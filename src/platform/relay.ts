import { gunzipSync, gzipSync } from "node:zlib";
import { CENTRAL_MEMBER_ID, type ConsolePush } from "../shared/protocol.js";
import { isProcessKey, replayOp, type WireEvent } from "../shared/replay-cache.js";
import { iso, type Platform } from "./platform.js";
import { pushToConsoles, type ConnectionRow } from "./fleet.js";
import type { Row } from "./store.js";

/**
 * The relay: every fleet member's events, kept and passed on.
 *
 * Yoke's dashboard is drawn from the events its engine pool emits. A member
 * posts those same events here; the relay keeps the ones a dashboard opened
 * later must be brought up to date with — each member's replay cache, the
 * map Yoke's dashboard server holds in memory, as rows of the table — and
 * pushes every one of them to the consoles that are open now.
 *
 * Rows: `CACHE#<memberId>/<cache key>`. The platform's own reading of the
 * repositories no member is assigned is kept the same way, under the member
 * id `central`.
 */

const cachePartition = (memberId: string): string => `CACHE#${memberId}`;

/** An event's JSON is stored as it is until it is this large, then gzipped: a row holds 400 KB. */
const GZIP_OVER_BYTES = 32 * 1024;
/** API Gateway pushes at most 128 KB down a socket in one message. */
const PUSH_MAX_BYTES = 100 * 1024;
/** At most this many events are taken in one post. */
export const MAX_EVENTS_PER_POST = 500;

function cacheRow(memberId: string, key: string, event: WireEvent, nowMs: number): Row {
  const json = JSON.stringify(event);
  const base = { PK: cachePartition(memberId), SK: key, at: iso(nowMs) };
  if (Buffer.byteLength(json) <= GZIP_OVER_BYTES) return { ...base, event: json };
  return { ...base, gz: gzipSync(json).toString("base64") };
}

function eventOf(row: Row): WireEvent | null {
  try {
    if (typeof row["event"] === "string") return JSON.parse(row["event"]) as WireEvent;
    if (typeof row["gz"] === "string") return JSON.parse(gunzipSync(Buffer.from(row["gz"], "base64")).toString("utf8")) as WireEvent;
  } catch {
    // A row that cannot be read is no event.
  }
  return null;
}

/** Whether something is an event as an engine pool emits one. */
export function isWireEvent(value: unknown): value is WireEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return typeof event["type"] === "string" && event["type"] !== "" && typeof event["timestamp"] === "string" &&
    typeof event["data"] === "object" && event["data"] !== null && !Array.isArray(event["data"]);
}

/** A member's replayable events, as a console opened now is brought up to date with them. */
export async function cachedEvents(p: Platform, memberId: string): Promise<WireEvent[]> {
  const rows = await p.table.query(cachePartition(memberId));
  return rows.map(eventOf).filter((event): event is WireEvent => event !== null);
}

/** Split events into messages API Gateway will carry. An event too large for any message is left out, and reported. */
function pushes(memberId: string, events: readonly WireEvent[]): { messages: ConsolePush[]; oversize: boolean } {
  const messages: ConsolePush[] = [];
  let oversize = false;
  let batch: WireEvent[] = [];
  let size = 0;
  for (const event of events) {
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (bytes > PUSH_MAX_BYTES) {
      oversize = true;
      continue;
    }
    if (size + bytes > PUSH_MAX_BYTES && batch.length > 0) {
      messages.push({ t: "events", member: memberId, events: batch });
      batch = [];
      size = 0;
    }
    batch.push(event);
    size += bytes;
  }
  if (batch.length > 0) messages.push({ t: "events", member: memberId, events: batch });
  return { messages, oversize };
}

/**
 * Take in a batch of a member's events: keep what is replayable, in the order
 * given, and push them all to the open consoles.
 *
 * Within one batch only the last event under each key is written — a pool
 * planning for six engines says a project's lifecycle six times a cycle, and
 * five of those are already out of date.
 */
export async function relayEvents(
  p: Platform,
  memberId: string,
  events: readonly WireEvent[],
  connections?: readonly ConnectionRow[],
): Promise<void> {
  if (events.length === 0) return;
  const writes = new Map<string, WireEvent | null>();
  for (const event of events) {
    const op = replayOp(event);
    for (const key of op.delete ?? []) writes.set(key, null);
    if (op.set !== undefined) writes.set(op.set, event);
  }
  await Promise.all([...writes].map(([key, event]) =>
    event === null
      ? p.table.delete(cachePartition(memberId), key)
      : p.table.put(cacheRow(memberId, key, event, p.now()))));

  const { messages, oversize } = pushes(memberId, events);
  for (const message of messages) await pushToConsoles(p, message, connections);
  // An event no socket can carry is still in the cache: the consoles read it from there.
  if (oversize) await pushToConsoles(p, { t: "resync" } satisfies ConsolePush, connections);
}

/**
 * A member started again. What its last process was doing — its engines, its
 * holds, that it was shutting down — is gone with that process, so it is
 * forgotten here and the consoles are told to forget it too. The work itself
 * stays: each repository's lifecycle is as true as it was a minute ago.
 */
export async function resetMemberProcess(p: Platform, memberId: string, connections?: readonly ConnectionRow[]): Promise<void> {
  const rows = await p.table.query(cachePartition(memberId));
  await Promise.all(rows.filter((row) => isProcessKey(row.SK)).map((row) => p.table.delete(row.PK, row.SK)));
  await pushToConsoles(p, { t: "member-reset", member: memberId } satisfies ConsolePush, connections);
}

/** Forget everything a member's cache holds: it has been retired. */
export async function forgetMember(p: Platform, memberId: string): Promise<void> {
  const rows = await p.table.query(cachePartition(memberId));
  await Promise.all(rows.map((row) => p.table.delete(row.PK, row.SK)));
}

/**
 * A repository is no longer a member's (or no longer the platform's own to
 * read): its work leaves that member's cache and every open console, as the
 * event the member itself emits when it hears. Said here too, because the
 * member may be offline when its repository is taken away.
 */
export async function removeProject(p: Platform, memberId: string, repo: string, connections?: readonly ConnectionRow[]): Promise<void> {
  await relayEvents(p, memberId, [{ type: "project-removed", timestamp: iso(p.now()), data: { repo } }], connections);
}

export { CENTRAL_MEMBER_ID };
