import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Table } from "./store.js";

/**
 * Everything the platform reaches outside itself, in one place.
 *
 * The function's handler builds one of these from its environment (the table,
 * API Gateway's connection management, SSM, `fetch`); the tests build one from
 * a table in memory, a list that remembers what was pushed, and a `fetch` that
 * plays GitHub. Nothing else in src/platform/ names AWS.
 */
export interface Platform {
  table: Table;
  sockets: Sockets;
  secrets: Secrets;
  /** For GitHub's API and Cognito's key set. */
  fetch: typeof fetch;
  /** Epoch millis. */
  now(): number;
  /** `bytes` random bytes, as hex. */
  random(bytes: number): string;
  settings: PlatformSettings;
  /** Who a Cognito id token says a console is; throws a `PlatformError` when it says no one. */
  verifyOperator(token: string): Promise<Operator>;
  log(line: string): void;
}

export interface PlatformSettings {
  /** The commit this function was deployed from; null when it was applied by hand. */
  release: string | null;
  /** https://shipyard.outright.io */
  publicUrl: string;
  /** wss://ws.shipyard.outright.io */
  publicWs: string;
}

/** The open sockets, as the platform pushes to them. */
export interface Sockets {
  /** Send `message` down a connection. False when the connection is gone. */
  post(connectionId: string, message: unknown): Promise<boolean>;
}

/** The secrets the platform keeps out of its table: the GitHub App's credentials. */
export interface Secrets {
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** A signed-in operator. */
export interface Operator {
  sub: string;
  email: string | null;
}

/** A refusal the caller is told about: an HTTP status, a stable code, and a sentence. */
export class PlatformError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** What to do about it, when there is something. */
    readonly remedy?: string,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export function refuse(status: number, code: string, message: string, remedy?: string): never {
  throw new PlatformError(status, code, message, remedy);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Whether two hex digests are the same, in time that does not depend on where they differ. */
export function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
