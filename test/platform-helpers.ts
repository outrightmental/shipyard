import { createHash } from "node:crypto";
import { handleHttp, type HttpRequest, type HttpResponse } from "../src/platform/http.js";
import { PlatformError, type Operator, type Platform } from "../src/platform/platform.js";
import { MemoryTable } from "../src/platform/store.js";
import { handleSocket } from "../src/platform/ws.js";

/**
 * A platform with nothing of AWS or GitHub in reach: a table in memory,
 * sockets that remember what was pushed down them, secrets in a map, a clock
 * a test moves by hand, and a `fetch` a test answers.
 */
export interface TestPlatform {
  p: Platform;
  table: MemoryTable;
  /** Everything pushed, in order: the connection it went down and the message. */
  pushed: Array<{ connectionId: string; message: Record<string, unknown> }>;
  /** Connections whose socket has gone: a push down one reports it gone. */
  gone: Set<string>;
  secrets: Map<string, string>;
  /** Every request the platform made, in order. */
  fetched: Array<{ url: string; method: string; headers: Record<string, string>; body: string }>;
  /** Answer the platform's requests: return undefined to answer 404. */
  onFetch(responder: (url: string, init: { method: string; body: string }) => unknown | undefined): void;
  advance(ms: number): void;
  nowMs(): number;
  logs: string[];
}

export const OPERATOR = { sub: "op-1", email: "operator@example.com" };
/** The token the test verifier takes as the operator's. */
export const OPERATOR_TOKEN = "operator-token";

export function testPlatform(options: { release?: string | null } = {}): TestPlatform {
  const table = new MemoryTable();
  const pushed: TestPlatform["pushed"] = [];
  const gone = new Set<string>();
  const secrets = new Map<string, string>();
  const fetched: TestPlatform["fetched"] = [];
  const logs: string[] = [];
  let nowMs = Date.parse("2026-11-15T12:00:00Z");
  let counter = 0;
  let responder: (url: string, init: { method: string; body: string }) => unknown | undefined = () => undefined;

  const p: Platform = {
    table,
    sockets: {
      async post(connectionId, message) {
        if (gone.has(connectionId)) return false;
        // Through JSON, as a socket would carry it.
        pushed.push({ connectionId, message: JSON.parse(JSON.stringify(message)) as Record<string, unknown> });
        return true;
      },
    },
    secrets: {
      async get(name) { return secrets.get(name) ?? null; },
      async put(name, value) { secrets.set(name, value); },
      async delete(name) { secrets.delete(name); },
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : "";
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
      fetched.push({ url, method, headers, body });
      const answer = responder(url, { method, body });
      if (answer === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      if (answer instanceof Response) return answer;
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    now: () => nowMs,
    // Distinct every time, and the same from run to run.
    random: (bytes) => createHash("sha256").update(`random-${++counter}`).digest("hex").slice(0, bytes * 2),
    settings: {
      release: options.release === undefined ? "0123456789abcdef0123456789abcdef01234567" : options.release,
      publicUrl: "https://shipyard.test",
      publicWs: "wss://ws.shipyard.test",
    },
    async verifyOperator(token): Promise<Operator> {
      if (token !== OPERATOR_TOKEN) throw new PlatformError(401, "JWT_SIGNATURE", "bad token signature");
      return OPERATOR;
    },
    log: (line) => { logs.push(line); },
  };

  return {
    p, table, pushed, gone, secrets, fetched, logs,
    onFetch(next) { responder = next; },
    advance(ms) { nowMs += ms; },
    nowMs: () => nowMs,
  };
}

interface CallOptions {
  /** A fleet member's token. */
  token?: string;
  /** False to call /api/… as someone API Gateway did not sign in. */
  operator?: boolean;
  headers?: Record<string, string>;
  /** The body as it is, for a webhook whose signature is over its exact text. */
  raw?: string;
}

/** Call the platform's HTTP API: /api/… as the operator unless told otherwise. */
export async function call(
  t: TestPlatform,
  method: string,
  path: string,
  body?: unknown,
  options: CallOptions = {},
): Promise<HttpResponse & { body: Record<string, unknown> }> {
  const request: HttpRequest = {
    method,
    path,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    body: options.raw ?? (body === undefined ? "" : JSON.stringify(body)),
    claims: path.startsWith("/api/") && options.operator !== false ? { ...OPERATOR } : null,
  };
  const response = await handleHttp(t.p, request);
  return response as HttpResponse & { body: Record<string, unknown> };
}

/** Enroll a machine and return what it was given. */
export async function enrollMachine(
  t: TestPlatform,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<{ memberId: string; token: string; name: string }> {
  const code = (await call(t, "POST", "/api/fleet/enroll-codes")).body["code"] as string;
  const enrolled = await call(t, "POST", "/enroll", { code, name, ...extra });
  if (enrolled.status !== 200) throw new Error(`enroll refused: ${JSON.stringify(enrolled.body)}`);
  return enrolled.body as unknown as { memberId: string; token: string; name: string };
}

/** Open a socket as a console, or as a fleet member with its token. */
export async function connect(t: TestPlatform, connectionId: string, who: { console: true } | { memberToken: string }): Promise<number> {
  const result = await handleSocket(t.p, {
    routeKey: "$connect",
    connectionId,
    headers: "memberToken" in who ? { authorization: `Bearer ${who.memberToken}` } : {},
    query: "console" in who ? { token: OPERATOR_TOKEN } : {},
    body: "",
  });
  return result.statusCode;
}

/** Send a message up a socket. */
export async function send(t: TestPlatform, connectionId: string, message: unknown): Promise<number> {
  const result = await handleSocket(t.p, { routeKey: "$default", connectionId, headers: {}, query: {}, body: JSON.stringify(message) });
  return result.statusCode;
}

/** What was pushed down one connection, in order. */
export function pushedTo(t: TestPlatform, connectionId: string): Array<Record<string, unknown>> {
  return t.pushed.filter((push) => push.connectionId === connectionId).map((push) => push.message);
}

export function event(type: string, data: Record<string, unknown> = {}, timestamp = "2026-11-15T12:00:00.000Z") {
  return { type, timestamp, data };
}
