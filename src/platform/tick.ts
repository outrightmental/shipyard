import { broadcastLifecycleUpdate } from "../dashboard-utils.js";
import { EventEmitter } from "../event-emitter.js";
import { buildBlockedIssueIndex, parseClosingIssueNumbers, parseLinkedIssueNumbers } from "../orchestrator.js";
import { CENTRAL_MEMBER_ID, parseRepo } from "../shared/protocol.js";
import type { WireEvent } from "../shared/replay-cache.js";
import type { Issue, PullRequest, RepositorySnapshot } from "../types.js";
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
 * platform does, and keeps the result as the events of a member of its own,
 * `central`, drawn from the same lifecycle Shipyard's dashboard is.
 *
 * It reads, and only reads: nothing here starts work or changes GitHub.
 *
 * And it reads lightly. A fleet member reads a repository with Shipyard's whole
 * client, which asks GitHub about every issue's dependencies and every pull
 * request's checks and review threads, because it is about to act on the
 * answers. That is a request per issue, in turn: on 2026-11-15 the first
 * repository subscribed to took more than the 29 seconds a request to the
 * platform is given, and subscribing to it timed out. Nothing acts on this
 * reading — it is the list of what is open, for a dashboard to draw dimmed
 * and marked unassigned — so it is two listings, a few pages each, with a
 * time limit, and what only a member needs is left for the member to find
 * once one is assigned.
 */

const GITHUB_API = "https://api.github.com";
/** No one request to GitHub is waited on for longer than this. */
const READ_TIMEOUT_MS = 8_000;
/** A hundred to a page: the open issues and pull requests read are the first so many. */
const MAX_ISSUE_PAGES = 5;
const MAX_PULL_PAGES = 3;
/** How many repositories are read at once. */
const READ_AT_ONCE = 6;
/** Read at most this many repositories in one pass. */
const MAX_REPOS_PER_PASS = 60;

interface RestLabel { name?: string }

interface RestIssue {
  number: number;
  title: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  labels?: Array<string | RestLabel>;
  milestone?: { number: number; title: string } | null;
  type?: { name?: string } | null;
  /** Present on what GitHub's issue listing lists that is really a pull request. */
  pull_request?: unknown;
}

interface RestPull {
  number: number;
  title: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  draft?: boolean;
  labels?: Array<string | RestLabel>;
  head: { sha: string; ref: string };
  base: { ref: string };
}

const labelNames = (labels: Array<string | RestLabel> | undefined): string[] =>
  (labels ?? []).map((label) => (typeof label === "string" ? label : label.name ?? "")).filter(Boolean);

/** Every page of a listing, up to `maxPages`. */
async function listPages<T>(p: Platform, token: string, path: string, maxPages: number): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await p.fetch(`${GITHUB_API}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "shipyard",
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);
    const batch = await res.json() as T[];
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

/** One repository's open work, as the lifecycle event a member would report for it. */
export async function readRepositoryLifecycle(p: Platform, repo: string, token: string): Promise<WireEvent | null> {
  const parsed = parseRepo(repo);
  if (!parsed) return null;
  const base = `/repos/${parsed.owner}/${parsed.name}`;
  const [listed, pulls] = await Promise.all([
    listPages<RestIssue>(p, token, `${base}/issues?state=open`, MAX_ISSUE_PAGES),
    listPages<RestPull>(p, token, `${base}/pulls?state=open`, MAX_PULL_PAGES),
  ]);

  const issues: Issue[] = listed.filter((issue) => issue.pull_request === undefined).map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    state: "open",
    type: issue.type?.name ?? null,
    labels: labelNames(issue.labels),
    ...(issue.milestone ? { milestone: { number: issue.milestone.number, title: issue.milestone.title } } : {}),
  }));
  const pullRequests: PullRequest[] = pulls.map((pull) => {
    const text = `${pull.title}\n${pull.body ?? ""}`;
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body ?? "",
      headSha: pull.head.sha,
      headRefName: pull.head.ref,
      baseRefName: pull.base.ref,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      state: "open",
      draft: pull.draft === true,
      // What only acting on a pull request needs is not asked for here.
      hasMergeConflicts: false,
      hasCleanReviewOnHead: false,
      unresolvedReviewCommentCount: 0,
      checksStatus: "none",
      pendingChecksStartedAt: undefined,
      labels: labelNames(pull.labels),
      closingIssueNumbers: parseClosingIssueNumbers(text),
      linkedIssueNumbers: parseLinkedIssueNumbers(text),
    };
  });
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

  // A few at a time: each is a handful of requests, and they are all one installation's.
  for (let at = 0; at < wanted.length; at += READ_AT_ONCE) {
    const events: WireEvent[] = [];
    await Promise.all(wanted.slice(at, at + READ_AT_ONCE).map(async (repo) => {
      try {
        const event = await readRepositoryLifecycle(p, repo, token);
        if (event) events.push(event);
        result.read.push(repo);
      } catch (error) {
        p.log(`central: could not read ${repo}: ${error instanceof Error ? error.message : String(error)}`);
        result.failed.push(repo);
      }
    }));
    // Passed on as they are read, so the first repositories are on the dashboard while the last are being read.
    await relayEvents(p, CENTRAL_MEMBER_ID, events, options.connections);
  }
  result.read.sort();
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
