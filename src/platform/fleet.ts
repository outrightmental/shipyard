import {
  CENTRAL_MEMBER_ID,
  ENROLL_CODE_MS,
  type FleetMember,
  type HostInfo,
  type MemberConfig,
  type MemberNote,
  type RepoSettings,
  type SubscribedRepo,
} from "../shared/protocol.js";
import { commitOf } from "../shared/release.js";
import { iso, refuse, sameDigest, sha256, type Platform } from "./platform.js";
import type { Row } from "./store.js";

/**
 * The fleet: the machines that host coding agents for Shipyard.
 *
 * One fleet member is one machine and one Claude account. It joins with a
 * one-time code an operator makes in the console, and from then on proves
 * itself with a token only it holds: the platform keeps the token's SHA-256,
 * never the token. A member starts assigned to nothing; what it works on is
 * the repositories an operator assigns it (repos.ts).
 *
 * Rows (infra/dynamodb.tf): `MEMBER/<id>`, `ENROLL/<sha256 of code>`,
 * `CONN/<connectionId>`.
 */

const MEMBER = "MEMBER";
const ENROLL = "ENROLL";
const CONN = "CONN";
const REPO = "REPO";

/**
 * How many cylinders a fleet member has until an operator says otherwise. It
 * is the member's own number, kept on its row and set from the console's
 * Fleet page: a machine does not say how big its pool is, Shipyard does.
 */
export const DEFAULT_MAX_CONCURRENCY = 6;
/** Past this a pool is a mistake, not a setting. */
export const MAX_MAX_CONCURRENCY = 32;
/** A connection row outlives its socket by at most this: API Gateway closes a socket after two hours. */
const CONNECTION_TTL_MS = 3 * 60 * 60_000;
/** A heartbeat is written to the table no more often than this: the row is read on every post. */
const SEEN_WRITE_EVERY_MS = 15_000;

export interface MemberRow extends Row {
  id: string;
  name: string;
  status: "active" | "retired";
  tokenHash?: string;
  enrolledAt: string;
  enrolledBy: string | null;
  lastSeenAt: string | null;
  commit: string | null;
  host: HostInfo | null;
  maxConcurrency: number;
  configVersion: string;
  notes: MemberNote[];
  /** The id of the process last heard from: a new one means the member started again. */
  boot: string | null;
}

export interface RepoRow extends Row {
  repo: string;
  memberId: string | null;
  subscribedAt: string;
  subscribedBy: string | null;
  settings: RepoSettings;
}

export interface ConnectionRow extends Row {
  connectionId: string;
  kind: "console" | "member";
  memberId?: string;
  email?: string | null;
  connectedAt: string;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export async function getMember(p: Platform, id: string): Promise<MemberRow | null> {
  return (await p.table.get(MEMBER, id)) as MemberRow | null;
}

export async function listMemberRows(p: Platform): Promise<MemberRow[]> {
  return (await p.table.query(MEMBER)) as MemberRow[];
}

export async function listRepoRows(p: Platform): Promise<RepoRow[]> {
  return (await p.table.query(REPO)) as RepoRow[];
}

export async function listConnections(p: Platform): Promise<ConnectionRow[]> {
  const nowSeconds = Math.floor(p.now() / 1000);
  // DynamoDB removes an expired row when it gets to it, which can be days.
  return ((await p.table.query(CONN)) as ConnectionRow[]).filter((row) => row.ttl === undefined || row.ttl > nowSeconds);
}

export function repoView(row: RepoRow): SubscribedRepo {
  return {
    repo: row.repo,
    memberId: row.memberId ?? null,
    subscribedAt: row.subscribedAt,
    subscribedBy: row.subscribedBy ?? null,
    settings: row.settings ?? {},
  };
}

export function memberView(row: MemberRow, repos: readonly RepoRow[], connections: readonly ConnectionRow[]): FleetMember {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    enrolledAt: row.enrolledAt,
    enrolledBy: row.enrolledBy ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    commit: row.commit ?? null,
    host: row.host ?? null,
    maxConcurrency: row.maxConcurrency,
    repos: repos.filter((repo) => repo.memberId === row.id).map((repo) => repo.repo).sort(),
    notes: row.notes ?? [],
    connected: connections.some((connection) => connection.kind === "member" && connection.memberId === row.id),
  };
}

/**
 * The order the fleet is listed in, everywhere: as its members joined, which
 * nothing that happens to a member can change. Two that joined in the same
 * instant go by name.
 */
export function byEnrollment(a: Pick<MemberRow, "enrolledAt" | "name">, b: Pick<MemberRow, "enrolledAt" | "name">): number {
  if (a.enrolledAt !== b.enrolledAt) return a.enrolledAt < b.enrolledAt ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The members an operator has not retired, in the order they joined. */
export function activeMembers(rows: readonly MemberRow[]): MemberRow[] {
  return rows.filter((member) => member.status === "active").sort(byEnrollment);
}

// ── Enrolling ────────────────────────────────────────────────────────────────

/**
 * A one-time code for one machine: fifteen minutes, once. Only its hash is
 * kept, so the table never holds something a machine could be enrolled with.
 */
export async function createEnrollCode(p: Platform, by: string | null): Promise<{ code: string; expiresAt: string }> {
  const code = `enr_${p.random(16)}`;
  const expiresAtMs = p.now() + ENROLL_CODE_MS;
  await p.table.put({
    PK: ENROLL,
    SK: sha256(code),
    createdAt: iso(p.now()),
    createdBy: by,
    expiresAtMs,
    ttl: Math.floor(expiresAtMs / 1000) + 3600,
  });
  return { code, expiresAt: iso(expiresAtMs) };
}

function cleanName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 64) : "";
  return name || fallback;
}

function cleanHost(value: unknown): HostInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const host = value as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 120) : "");
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  return {
    hostname: text(host["hostname"]),
    platform: text(host["platform"]),
    arch: text(host["arch"]),
    osRelease: text(host["osRelease"]),
    node: text(host["node"]),
    cpus: count(host["cpus"]),
    totalMemoryMb: count(host["totalMemoryMb"]),
  };
}

function newToken(p: Platform, memberId: string): string {
  return `shp_${memberId}_${p.random(32)}`;
}

export interface EnrollRequest {
  code?: unknown;
  name?: unknown;
  host?: unknown;
  commit?: unknown;
  /** The enrollment this machine already has, when it is enrolling again. */
  previous?: { memberId?: unknown; token?: unknown } | null;
}

export interface EnrollResult {
  memberId: string;
  name: string;
  token: string;
  platformUrl: string;
  wsUrl: string;
  /** True when the machine was already a member and keeps its name and its repositories. */
  reenrolled: boolean;
}

/**
 * Redeem a code for a machine's token. The code is spent whatever happens
 * next, so it can never be redeemed twice.
 *
 * A machine that is already a member — it says so with the token it has —
 * stays that member: it keeps its name and its repositories, and its old
 * token stops working. Anything else is a new member, assigned to nothing.
 */
export async function enroll(p: Platform, request: EnrollRequest): Promise<EnrollResult> {
  const code = typeof request.code === "string" ? request.code.trim() : "";
  if (!code) return refuse(400, "CODE_REQUIRED", "no enrollment code was given", "make one in the console: Fleet, Enroll a machine");
  const key = sha256(code);
  const row = await p.table.get(ENROLL, key);
  // Removed as it is read: of two machines racing with one code, one finds it gone.
  if (row === null || !(await p.table.delete(ENROLL, key, { ifPresent: true }))) {
    return refuse(403, "CODE_UNKNOWN", "that enrollment code is not one Shipyard gave out, or it has been used", "make a new one in the console: Fleet, Enroll a machine");
  }
  const expiresAtMs = row["expiresAtMs"];
  if (typeof expiresAtMs !== "number" || expiresAtMs <= p.now()) {
    return refuse(403, "CODE_EXPIRED", "that enrollment code has expired", "codes last fifteen minutes: make a new one in the console");
  }
  const createdBy = typeof row["createdBy"] === "string" ? row["createdBy"] : null;

  const at = iso(p.now());
  const host = cleanHost(request.host);
  const commit = commitOf(request.commit);
  const settings = { platformUrl: p.settings.publicUrl, wsUrl: p.settings.publicWs };

  const previousId = typeof request.previous?.memberId === "string" ? request.previous.memberId : "";
  const previousToken = typeof request.previous?.token === "string" ? request.previous.token : "";
  if (previousId && previousToken) {
    const existing = await authenticateMember(p, previousToken).catch(() => null);
    if (existing && existing.id === previousId) {
      const token = newToken(p, existing.id);
      const name = cleanName(request.name, existing.name);
      await p.table.update(MEMBER, existing.id, { tokenHash: sha256(token), host, commit, name, notes: [] });
      await refreshConfigVersion(p, existing.id);
      return { memberId: existing.id, name, token, ...settings, reenrolled: true };
    }
  }

  const memberId = `m_${p.random(5)}`;
  const token = newToken(p, memberId);
  const name = cleanName(request.name, host?.hostname || memberId);
  const member: MemberRow = {
    PK: MEMBER,
    SK: memberId,
    id: memberId,
    name,
    status: "active",
    tokenHash: sha256(token),
    enrolledAt: at,
    enrolledBy: createdBy,
    lastSeenAt: null,
    commit,
    host,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    configVersion: "",
    notes: [],
    boot: null,
  };
  member.configVersion = configVersionOf(member, []);
  await p.table.put(member);
  return { memberId, name, token, ...settings, reenrolled: false };
}

/**
 * The member a bearer token is: `shp_<memberId>_<secret>`. The id says which
 * row to read, and the row's hash says whether the token is its. A retired
 * member's token is no one's.
 */
export async function authenticateMember(p: Platform, bearer: string | null | undefined): Promise<MemberRow> {
  const token = String(bearer ?? "").replace(/^Bearer\s+/i, "").trim();
  const match = /^shp_(m_[0-9a-f]+)_[0-9a-f]+$/.exec(token);
  const member = match ? await getMember(p, match[1]!) : null;
  if (!member || !member.tokenHash || !sameDigest(member.tokenHash, sha256(token))) {
    return refuse(401, "TOKEN_UNKNOWN", "that is not a fleet member's token", "enroll this machine again with a code from the console");
  }
  if (member.status !== "active") {
    return refuse(403, "MEMBER_RETIRED", "this machine was retired from the fleet", "enroll it again with a code from the console");
  }
  return member;
}

// ── A member's configuration ─────────────────────────────────────────────────

function configVersionOf(member: Pick<MemberRow, "name" | "maxConcurrency">, repos: readonly RepoRow[]): string {
  const mine = [...repos].sort((a, b) => (a.repo < b.repo ? -1 : 1)).map((repo) => [repo.repo, repo.settings ?? {}]);
  return sha256(JSON.stringify([member.name, member.maxConcurrency, mine])).slice(0, 16);
}

/**
 * Work out a member's configuration version again, after anything that goes
 * into it changed. It is kept on the member's row so that a heartbeat, which
 * reads that row anyway, can say it without reading every repository.
 */
export async function refreshConfigVersion(p: Platform, memberId: string): Promise<string | null> {
  if (memberId === CENTRAL_MEMBER_ID) return null;
  const member = await getMember(p, memberId);
  if (!member) return null;
  const repos = (await listRepoRows(p)).filter((repo) => repo.memberId === memberId);
  const configVersion = configVersionOf(member, repos);
  if (configVersion !== member.configVersion) await p.table.update(MEMBER, memberId, { configVersion });
  return configVersion;
}

/** What a member is told to be. `github`: whether Shipyard can mint it a GitHub token, and who its commits are by. */
export async function memberConfig(
  p: Platform,
  member: MemberRow,
  github: { ready: boolean; git: { name: string; email: string } | null },
): Promise<MemberConfig> {
  const repos = (await listRepoRows(p)).filter((repo) => repo.memberId === member.id);
  return {
    member: { id: member.id, name: member.name },
    release: p.settings.release,
    configVersion: configVersionOf(member, repos),
    maxConcurrency: member.maxConcurrency,
    repos: repos.sort((a, b) => (a.repo < b.repo ? -1 : 1)).map((repo) => ({ repo: repo.repo, ...(repo.settings ?? {}) })),
    github: { ready: github.ready },
    git: github.git,
    wsUrl: p.settings.publicWs,
  };
}

// ── What a member says about itself ──────────────────────────────────────────

function cleanNotes(value: unknown, at: string): MemberNote[] | null {
  if (!Array.isArray(value)) return null;
  const notes: MemberNote[] = [];
  for (const entry of value.slice(0, 8)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { code, message } = entry as Record<string, unknown>;
    if (typeof code !== "string" || typeof message !== "string" || !code) continue;
    notes.push({ code: code.slice(0, 40), message: message.slice(0, 400), at });
  }
  return notes;
}

function sameNotes(a: readonly MemberNote[], b: readonly MemberNote[]): boolean {
  return a.length === b.length && a.every((note, i) => note.code === b[i]!.code && note.message === b[i]!.message);
}

export interface MemberReport {
  boot?: unknown;
  commit?: unknown;
  host?: unknown;
  /** Every problem it has right now; an empty list clears them. Absent leaves them as they were. */
  notes?: unknown;
}

/**
 * Take in what a member's post says about it — that it is there, which
 * process and commit it is, what is wrong with it — writing only what changed.
 * Returns the row as it now is, and whether this is a process not heard from
 * before (the member started again) or something an operator would see changed.
 */
export async function recordMemberReport(
  p: Platform,
  member: MemberRow,
  report: MemberReport,
): Promise<{ member: MemberRow; restarted: boolean; changed: boolean }> {
  const at = iso(p.now());
  const patch: Record<string, unknown> = {};
  let changed = false;

  const lastSeenMs = member.lastSeenAt ? Date.parse(member.lastSeenAt) : 0;
  // Coming back from offline is something to tell the consoles; a routine beat is not.
  const wasOffline = !member.lastSeenAt || p.now() - lastSeenMs > 60_000;
  if (wasOffline || p.now() - lastSeenMs >= SEEN_WRITE_EVERY_MS) patch["lastSeenAt"] = at;
  if (wasOffline) changed = true;

  const boot = typeof report.boot === "string" && report.boot ? report.boot.slice(0, 64) : null;
  const restarted = boot !== null && boot !== member.boot;
  if (restarted) patch["boot"] = boot;

  const commit = commitOf(report.commit);
  if (commit !== null && commit !== member.commit) {
    patch["commit"] = commit;
    changed = true;
  }
  const host = cleanHost(report.host);
  if (host !== null && JSON.stringify(host) !== JSON.stringify(member.host)) patch["host"] = host;

  const notes = cleanNotes(report.notes, at);
  if (notes !== null && !sameNotes(notes, member.notes ?? [])) {
    patch["notes"] = notes;
    changed = true;
  }

  if (Object.keys(patch).length === 0) return { member, restarted, changed };
  const updated = (await p.table.update(MEMBER, member.id, patch)) as MemberRow | null;
  return { member: updated ?? { ...member, ...patch } as MemberRow, restarted, changed };
}

// ── What an operator does to a member ────────────────────────────────────────

export async function updateMember(
  p: Platform,
  memberId: string,
  change: { name?: unknown; maxConcurrency?: unknown },
): Promise<MemberRow> {
  const member = await getMember(p, memberId);
  if (!member || member.status !== "active") return refuse(404, "MEMBER_UNKNOWN", `there is no fleet member ${memberId}`);
  const patch: Record<string, unknown> = {};
  if (change.name !== undefined) {
    const name = cleanName(change.name, "");
    if (!name) return refuse(400, "NAME_REQUIRED", "a fleet member needs a name");
    patch["name"] = name;
  }
  if (change.maxConcurrency !== undefined) {
    const n = change.maxConcurrency;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_MAX_CONCURRENCY) {
      return refuse(400, "POOL_SIZE", `a fleet member has between 1 and ${MAX_MAX_CONCURRENCY} cylinders`);
    }
    patch["maxConcurrency"] = n;
  }
  if (Object.keys(patch).length > 0) await p.table.update(MEMBER, memberId, patch);
  await refreshConfigVersion(p, memberId);
  return (await getMember(p, memberId))!;
}

/**
 * Retire a member: its token stops working at once, and its repositories are
 * assigned to no one (they say so in the console until someone reassigns
 * them). The row is kept, so what it was is still on record.
 */
export async function retireMember(p: Platform, memberId: string, by: string | null): Promise<string[]> {
  const member = await getMember(p, memberId);
  if (!member || member.status !== "active") return refuse(404, "MEMBER_UNKNOWN", `there is no fleet member ${memberId}`);
  const released: string[] = [];
  for (const repo of await listRepoRows(p)) {
    if (repo.memberId !== memberId) continue;
    await p.table.update(REPO, repo.repo, { memberId: null });
    released.push(repo.repo);
  }
  await p.table.update(MEMBER, memberId, {
    status: "retired",
    tokenHash: undefined,
    retiredAt: iso(p.now()),
    retiredBy: by,
  });
  return released;
}

// ── Connections ──────────────────────────────────────────────────────────────

export async function openConnection(
  p: Platform,
  connectionId: string,
  who: { kind: "console"; email: string | null } | { kind: "member"; memberId: string },
): Promise<void> {
  const row: ConnectionRow = {
    PK: CONN,
    SK: connectionId,
    connectionId,
    kind: who.kind,
    connectedAt: iso(p.now()),
    ttl: Math.floor((p.now() + CONNECTION_TTL_MS) / 1000),
    ...(who.kind === "member" ? { memberId: who.memberId } : { email: who.email }),
  };
  await p.table.put(row);
}

export async function closeConnection(p: Platform, connectionId: string): Promise<ConnectionRow | null> {
  const row = (await p.table.get(CONN, connectionId)) as ConnectionRow | null;
  if (row) await p.table.delete(CONN, connectionId);
  return row;
}

export async function getConnection(p: Platform, connectionId: string): Promise<ConnectionRow | null> {
  return (await p.table.get(CONN, connectionId)) as ConnectionRow | null;
}

/** Send to a connection; a connection that has gone is forgotten. */
async function post(p: Platform, connection: ConnectionRow, message: unknown): Promise<boolean> {
  let delivered = false;
  try {
    delivered = await p.sockets.post(connection.connectionId, message);
  } catch (error) {
    p.log(`push to ${connection.connectionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!delivered) await p.table.delete(CONN, connection.connectionId).catch(() => undefined);
  return delivered;
}

/** Push to every open console. Returns how many took it. */
export async function pushToConsoles(p: Platform, message: unknown, connections?: readonly ConnectionRow[]): Promise<number> {
  const consoles = (connections ?? await listConnections(p)).filter((connection) => connection.kind === "console");
  const results = await Promise.all(consoles.map((connection) => post(p, connection, message)));
  return results.filter(Boolean).length;
}

/** Push to a member's open sockets. Returns how many took it: zero means the member will not hear it. */
export async function pushToMember(p: Platform, memberId: string, message: unknown, connections?: readonly ConnectionRow[]): Promise<number> {
  const sockets = (connections ?? await listConnections(p))
    .filter((connection) => connection.kind === "member" && connection.memberId === memberId);
  const results = await Promise.all(sockets.map((connection) => post(p, connection, message)));
  return results.filter(Boolean).length;
}

/** Push to every member's open sockets. */
export async function pushToFleet(p: Platform, message: unknown): Promise<number> {
  const sockets = (await listConnections(p)).filter((connection) => connection.kind === "member");
  const results = await Promise.all(sockets.map((connection) => post(p, connection, message)));
  return results.filter(Boolean).length;
}

/** Push to one connection, whoever's it is. */
export async function pushToConnection(p: Platform, connection: ConnectionRow, message: unknown): Promise<boolean> {
  return post(p, connection, message);
}
