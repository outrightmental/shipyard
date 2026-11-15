import { broadcastLifecycleUpdate } from "../dashboard-utils.js";
import { EventEmitter } from "../event-emitter.js";
import { GitHubApiGateway } from "../github-gateway.js";
import { GitHubClient } from "../github.js";
import { buildBlockedIssueIndex } from "../orchestrator.js";
import { CENTRAL_MEMBER_ID, parseRepo } from "../shared/protocol.js";
import type { WireEvent } from "../shared/replay-cache.js";
import type { RepositorySnapshot } from "../types.js";
import { listConnections, listMemberRows, listRepoRows, type ConnectionRow } from "./fleet.js";
import { githubReady, installationToken } from "./github-app.js";
import type { Platform } from "./platform.js";
import { cachedEvents, relayEvents, removeProject } from "./relay.js";

/**
 * The platform's own reading of the repositories no fleet member is assigned.
 *
 * A subscribed repository's issues belong on the dashboard whether or not a
 * machine is working them — that it has work and nobody to do it is exactly
 * what an operator needs to see. A fleet member reads its own repositories
 * and reports them; a repository with no member has nobody to read it, so the
 * platform does, with the same code a member runs (the GitHub client and the
 * lifecycle Yoke's dashboard is drawn from), and keeps the result as the
 * events of a member of its own, `central`.
 *
 * It reads, and only reads: nothing here starts work or changes GitHub.
 */

/** Read at most this many repositories in one pass: a tick has a minute. */
const MAX_REPOS_PER_PASS = 12;

/** A wait GitHub's rate limit asks for is not one a function can sit out. */
function impatientSleep(ms: number): Promise<void> {
  if (ms > 3_000) return Promise.reject(new Error(`GitHub asked to wait ${Math.round(ms / 1000)}s`));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One repository's open work, as the lifecycle event a member would report for it. */
export async function readRepositoryLifecycle(p: Platform, repo: string, token: string): Promise<WireEvent | null> {
  const parsed = parseRepo(repo);
  if (!parsed) return null;
  // The gateway reports rate limits to whoever listens; here nobody does.
  const quiet = new EventEmitter();
  const gateway = new GitHubApiGateway({
    token,
    fetchImpl: p.fetch,
    eventEmitter: quiet,
    userAgent: "shipyard",
    maxAttempts: 1,
    sleep: impatientSleep,
    clock: () => p.now(),
  });
  const client = new GitHubClient({ owner: parsed.owner, repo: parsed.name, gateway });
  const [issues, pullRequests] = await Promise.all([client.listOpenIssues(), client.listOpenPullRequests()]);
  const snapshot: RepositorySnapshot = { issues, pullRequests, agentSessions: [] };

  let captured: WireEvent | null = null;
  const capture = new EventEmitter();
  capture.subscribe((event) => { if (event.type === "lifecycle-update") captured = event; });
  broadcastLifecycleUpdate(snapshot, new Set(), new Set(), buildBlockedIssueIndex(issues), false, false, capture, parsed.repo);
  const event = captured as WireEvent | null;
  if (!event) return null;
  // Said on the event, so a dashboard draws this work as waiting on a fleet member rather than as next up.
  return { ...event, data: { ...event.data, unassigned: true } };
}

/** The repositories that are no active member's: subscribed and unassigned, or assigned to a member since retired. */
export async function unassignedRepos(p: Platform): Promise<string[]> {
  const [repos, members] = await Promise.all([listRepoRows(p), listMemberRows(p)]);
  const active = new Set(members.filter((member) => member.status === "active").map((member) => member.id));
  return repos
    .filter((repo) => repo.memberId === null || repo.memberId === undefined || !active.has(repo.memberId))
    .map((repo) => repo.repo)
    .sort();
}

/**
 * Read the unassigned repositories again and pass on what changed. `only`
 * narrows it to some of them (the one just subscribed to). One that cannot be
 * read — the app is not installed on it — is skipped and said in the log.
 */
export async function refreshUnassigned(
  p: Platform,
  options: { only?: readonly string[]; connections?: readonly ConnectionRow[] } = {},
): Promise<{ read: string[]; failed: string[] }> {
  const result = { read: [] as string[], failed: [] as string[] };
  const unassigned = await unassignedRepos(p);

  // What `central` shows for a repository that has since been assigned or unsubscribed is stale.
  const shown = (await cachedEvents(p, CENTRAL_MEMBER_ID))
    .filter((event) => event.type === "lifecycle-update")
    .map((event) => String(event.data["repo"] ?? ""));
  for (const repo of shown) {
    if (!unassigned.includes(repo)) await removeProject(p, CENTRAL_MEMBER_ID, repo, options.connections);
  }

  const wanted = (options.only ? unassigned.filter((repo) => options.only!.includes(repo)) : unassigned).slice(0, MAX_REPOS_PER_PASS);
  if (wanted.length === 0 || !(await githubReady(p))) return result;

  let token: string;
  try {
    ({ token } = await installationToken(p, wanted));
  } catch (error) {
    // One of them is not a repository the app can see: read each alone, so the others still are.
    p.log(`central: no token for ${wanted.join(", ")}: ${error instanceof Error ? error.message : String(error)}`);
    if (wanted.length === 1) return { ...result, failed: wanted };
    for (const repo of wanted) {
      const one = await refreshUnassigned(p, { ...options, only: [repo] });
      result.read.push(...one.read);
      result.failed.push(...one.failed);
    }
    return result;
  }

  const events: WireEvent[] = [];
  await Promise.all(wanted.map(async (repo) => {
    try {
      const event = await readRepositoryLifecycle(p, repo, token);
      if (event) events.push(event);
      result.read.push(repo);
    } catch (error) {
      p.log(`central: could not read ${repo}: ${error instanceof Error ? error.message : String(error)}`);
      result.failed.push(repo);
    }
  }));
  await relayEvents(p, CENTRAL_MEMBER_ID, events, options.connections);
  return result;
}

/**
 * The tick, every two minutes. The unassigned repositories are read again
 * only while a console is open to show them: nobody is looking otherwise, and
 * the next console to open asks for a fresh reading itself.
 */
export async function tick(p: Platform): Promise<{ consoles: number; read: string[]; failed: string[] }> {
  const connections = await listConnections(p);
  const consoles = connections.filter((connection) => connection.kind === "console").length;
  if (consoles === 0) return { consoles, read: [], failed: [] };
  const { read, failed } = await refreshUnassigned(p, { connections });
  return { consoles, read, failed };
}
