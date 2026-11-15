import { CENTRAL_MEMBER_ID, type ConsoleState, type MemberAck } from "../shared/protocol.js";
import {
  activeMembers,
  authenticateMember,
  createEnrollCode,
  enroll,
  listConnections,
  listMemberRows,
  listRepoRows,
  memberConfig,
  memberView,
  pushToConsoles,
  pushToMember,
  recordMemberReport,
  repoView,
  retireMember,
  updateMember,
  type MemberRow,
} from "./fleet.js";
import {
  beginManifest,
  completeManifest,
  disconnectGithub,
  githubForMembers,
  githubStatus,
  installationToken,
  listAvailableRepos,
  refreshInstallation,
  verifyWebhook,
} from "./github-app.js";
import { operatorFromClaims } from "./jwt.js";
import { PlatformError, refuse, type Operator, type Platform } from "./platform.js";
import { cachedEvents, forgetMember, isWireEvent, MAX_EVENTS_PER_POST, relayEvents, resetMemberProcess } from "./relay.js";
import { deleteRepo, putRepo } from "./repos.js";
import { refreshUnassigned } from "./tick.js";
import { memberOnline } from "../shared/protocol.js";
import type { WireEvent } from "../shared/replay-cache.js";

/**
 * The platform's HTTP API. Four kinds of caller, each proving itself its own
 * way:
 *
 *   /api/…      the console: an operator, whose Cognito token API Gateway has
 *               already verified (the claims arrive with the request)
 *   /enroll     a machine with a one-time code
 *   /fleet/…    a fleet member, by the token only it holds
 *   /hooks/…    GitHub, by the signature of the webhook's body
 *
 * and /healthz, which proves nothing and says only which commit runs.
 */
export interface HttpRequest {
  method: string;
  path: string;
  /** Lower-cased names. */
  headers: Record<string, string>;
  /** The body as text, already decoded. */
  body: string;
  /** What API Gateway's JWT authorizer verified, on /api/… routes. */
  claims: Record<string, unknown> | null;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

function ok(body: Record<string, unknown> = {}): HttpResponse {
  return { status: 200, body: { ok: true, ...body } };
}

function parseBody(request: HttpRequest): Record<string, unknown> {
  if (!request.body) return {};
  try {
    const parsed = JSON.parse(request.body) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Said below.
  }
  return refuse(400, "BODY_NOT_JSON", "the request's body is not a JSON object");
}

/** Run a request to an answer: a refusal is an answer too, and anything else that goes wrong is a 500 and a log line. */
export async function handleHttp(p: Platform, request: HttpRequest): Promise<HttpResponse> {
  try {
    return await route(p, request);
  } catch (error) {
    if (error instanceof PlatformError) {
      return {
        status: error.status,
        body: { ok: false, code: error.code, error: error.message, ...(error.remedy ? { remedy: error.remedy } : {}) },
      };
    }
    p.log(`${request.method} ${request.path} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return { status: 500, body: { ok: false, code: "INTERNAL", error: "the platform could not do that" } };
  }
}

async function route(p: Platform, request: HttpRequest): Promise<HttpResponse> {
  const { method, path } = request;
  if (path === "/healthz") return ok({ service: "shipyard", release: p.settings.release });
  if (path.startsWith("/api/")) return consoleRoute(p, request, path.slice("/api".length));
  if (path === "/enroll" && method === "POST") return ok({ ...(await enroll(p, parseBody(request))) });
  if (path === "/enroll/status" && method === "GET") {
    const member = await authenticateMember(p, request.headers["authorization"]);
    return ok({ member: { id: member.id, name: member.name, online: memberOnline(member, p.now()), lastSeenAt: member.lastSeenAt } });
  }
  if (path.startsWith("/fleet/")) return fleetRoute(p, request, path.slice("/fleet".length));
  if (path === "/hooks/github" && method === "POST") return githubHook(p, request);
  return refuse(404, "NOT_FOUND", `nothing answers ${method} ${path}`);
}

// ── The console ──────────────────────────────────────────────────────────────

async function consoleState(p: Platform, operator: Operator): Promise<ConsoleState> {
  const [memberRows, repoRows, connections, github] = await Promise.all([
    listMemberRows(p), listRepoRows(p), listConnections(p), githubStatus(p),
  ]);
  const active = activeMembers(memberRows);
  const ids = [...active.map((member) => member.id), CENTRAL_MEMBER_ID];
  const caches = await Promise.all(ids.map((id) => cachedEvents(p, id)));
  const cached: Record<string, WireEvent[]> = {};
  ids.forEach((id, index) => { cached[id] = caches[index]!; });
  return {
    release: p.settings.release,
    serverTimeMs: p.now(),
    operator: { email: operator.email },
    members: active.map((member) => memberView(member, repoRows, connections)),
    repos: repoRows.map(repoView).sort((a, b) => (a.repo.toLowerCase() < b.repo.toLowerCase() ? -1 : 1)),
    github,
    cached,
  };
}

async function consoleRoute(p: Platform, request: HttpRequest, path: string): Promise<HttpResponse> {
  const operator = operatorFromClaims(request.claims);
  if (!operator) return refuse(401, "NOT_SIGNED_IN", "sign in to Shipyard first");
  const { method } = request;
  const by = operator.email ?? operator.sub;

  if (path === "/state" && method === "GET") return ok({ ...(await consoleState(p, operator)) });

  // The platform's own reading of the unassigned repositories, asked for by a console that has just opened.
  if (path === "/central/refresh" && method === "POST") return ok({ ...(await refreshUnassigned(p)) });

  // ── Fleet ──
  if (path === "/fleet/enroll-codes" && method === "POST") {
    const code = await createEnrollCode(p, by);
    return ok({ ...code, platformUrl: p.settings.publicUrl });
  }
  const member = /^\/fleet\/(m_[0-9a-f]+)$/.exec(path);
  if (member && method === "PATCH") {
    const updated = await updateMember(p, member[1]!, parseBody(request));
    await pushToMember(p, updated.id, { t: "poke" });
    await pushToConsoles(p, { t: "changed" });
    return ok({ member: { id: updated.id, name: updated.name, maxConcurrency: updated.maxConcurrency } });
  }
  if (member && method === "DELETE") {
    const memberId = member[1]!;
    const released = await retireMember(p, memberId, by);
    // Told before its sockets are forgotten, so a member that is listening stops at once.
    await pushToMember(p, memberId, { t: "retired" });
    await forgetMember(p, memberId);
    await pushToConsoles(p, { t: "changed" });
    return ok({ released });
  }

  // ── GitHub ──
  if (path === "/github" && method === "GET") return ok({ github: await githubStatus(p) });
  if (path === "/github/manifest" && method === "POST") return ok({ ...(await beginManifest(p, parseBody(request))) });
  if (path === "/github/app" && method === "POST") {
    const github = await completeManifest(p, parseBody(request), by);
    await pushToConsoles(p, { t: "changed" });
    return ok({ github });
  }
  if (path === "/github/refresh" && method === "POST") {
    const github = await refreshInstallation(p);
    await pushToConsoles(p, { t: "changed" });
    return ok({ github });
  }
  if (path === "/github" && method === "DELETE") {
    await disconnectGithub(p);
    await pushToConsoles(p, { t: "changed" });
    return ok({ github: await githubStatus(p) });
  }
  if (path === "/github/repositories" && method === "GET") return ok({ available: await listAvailableRepos(p) });

  // ── Repositories ──
  const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
  if (repo && method === "PUT") {
    const name = `${decodeURIComponent(repo[1]!)}/${decodeURIComponent(repo[2]!)}`;
    const saved = await putRepo(p, name, parseBody(request), by);
    // Unassigned, it is the platform's to read: at once, so it is on the dashboard before the next tick.
    if (saved.memberId === null) await refreshUnassigned(p, { only: [saved.repo] }).catch(() => undefined);
    return ok({ repo: saved });
  }
  if (repo && method === "DELETE") {
    await deleteRepo(p, `${decodeURIComponent(repo[1]!)}/${decodeURIComponent(repo[2]!)}`);
    return ok();
  }

  return refuse(404, "NOT_FOUND", `nothing answers ${method} /api${path}`);
}

// ── The fleet ────────────────────────────────────────────────────────────────

function ack(p: Platform, member: MemberRow): MemberAck {
  return { ok: true, release: p.settings.release, configVersion: member.configVersion };
}

/** A member's post says it is there, and may say more about it: taken in before the post itself is answered. */
async function heard(p: Platform, member: MemberRow, body: Record<string, unknown>): Promise<MemberRow> {
  const { member: updated, restarted, changed } = await recordMemberReport(p, member, body);
  if (restarted) await resetMemberProcess(p, member.id);
  if (changed || restarted) await pushToConsoles(p, { t: "changed" });
  return updated;
}

async function fleetRoute(p: Platform, request: HttpRequest, path: string): Promise<HttpResponse> {
  const authenticated = await authenticateMember(p, request.headers["authorization"]);
  const { method } = request;

  if (path === "/hello" && method === "POST") {
    const member = await heard(p, authenticated, parseBody(request));
    return ok({ config: await memberConfig(p, member, await githubForMembers(p)) });
  }

  if (path === "/config" && method === "GET") {
    return ok({ config: await memberConfig(p, authenticated, await githubForMembers(p)) });
  }

  if (path === "/beat" && method === "POST") {
    const member = await heard(p, authenticated, parseBody(request));
    return { status: 200, body: ack(p, member) };
  }

  if (path === "/events" && method === "POST") {
    const body = parseBody(request);
    const member = await heard(p, authenticated, body);
    const raw = Array.isArray(body["events"]) ? body["events"] : [];
    if (raw.length > MAX_EVENTS_PER_POST) return refuse(413, "TOO_MANY_EVENTS", `at most ${MAX_EVENTS_PER_POST} events in one post`);
    // A member speaks for the repositories assigned to it and no others: one
    // taken away a moment ago must not be put back on the dashboard by a
    // report that was already on its way.
    const mine = new Set((await listRepoRows(p)).filter((repo) => repo.memberId === member.id).map((repo) => repo.repo));
    const events = raw.filter(isWireEvent).filter((event) => {
      if (event.type !== "lifecycle-update" && event.type !== "snapshot-update") return true;
      return mine.has(String(event.data["repo"] ?? ""));
    });
    await relayEvents(p, member.id, events);
    return { status: 200, body: ack(p, member) };
  }

  if (path === "/github-token" && method === "POST") {
    const repos = (await listRepoRows(p)).filter((repo) => repo.memberId === authenticated.id).map((repo) => repo.repo).sort();
    if (repos.length === 0) {
      return refuse(409, "NO_REPOSITORIES", "no repository is assigned to this fleet member", "assign it one in the console: Repositories");
    }
    const token = await installationToken(p, repos);
    return ok({ token: token.token, expiresAt: token.expiresAt, repos });
  }

  return refuse(404, "NOT_FOUND", `nothing answers ${method} /fleet${path}`);
}

// ── GitHub's webhooks ────────────────────────────────────────────────────────

async function githubHook(p: Platform, request: HttpRequest): Promise<HttpResponse> {
  if (!(await verifyWebhook(p, request.body, request.headers["x-hub-signature-256"]))) {
    return refuse(401, "SIGNATURE", "that webhook is not signed by the GitHub App");
  }
  const event = request.headers["x-github-event"] ?? "";
  // The app was installed, removed, or given other repositories: find it again.
  if (event === "installation" || event === "installation_repositories") {
    await refreshInstallation(p).catch((error) => p.log(`webhook ${event}: ${error instanceof Error ? error.message : String(error)}`));
    await pushToConsoles(p, { t: "changed" });
  }
  return { status: 202, body: { ok: true, event } };
}
