import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostInfo } from "../shared/protocol.js";
import { commitOf } from "../shared/release.js";

/**
 * What a fleet member knows about the machine it runs on (#4): the
 * enrollment `npm run enroll` wrote (`<home>/fleet.json` and `<home>/token`),
 * a description of the host for the Fleet page, and the commit this checkout
 * is on.
 *
 * The home holds the enrollment and the token and nothing else of
 * Shipyard's. What the engines keep — checkouts, scratch, session history —
 * is where Yoke has always kept it.
 */

/** This checkout: the directory package.json is in. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where a member keeps its enrollment: `SHIPYARD_HOME`, else `~/.shipyard`. */
export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["SHIPYARD_HOME"] || join(os.homedir(), ".shipyard");
}

/** A member's enrollment, as `<home>/fleet.json` keeps it. Never the token. */
export interface Enrollment {
  memberId: string;
  name: string;
  /** https://shipyard.outright.io */
  platformUrl: string;
  /** wss://ws.shipyard.outright.io */
  wsUrl: string;
  enrolledAt: string;
}

/** The enrollment in `home`, or null before the machine has been enrolled. */
export function readEnrollment(home: string): Enrollment | null {
  const file = join(home, "fleet.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Enrollment>;
    if (typeof parsed.memberId !== "string" || typeof parsed.platformUrl !== "string") return null;
    return {
      memberId: parsed.memberId,
      name: typeof parsed.name === "string" ? parsed.name : parsed.memberId,
      platformUrl: parsed.platformUrl.replace(/\/+$/, ""),
      wsUrl: typeof parsed.wsUrl === "string" ? parsed.wsUrl : "",
      enrolledAt: typeof parsed.enrolledAt === "string" ? parsed.enrolledAt : "",
    };
  } catch {
    return null;
  }
}

/** Write a file only its owner can read: the enrollment and the token are this machine's own. */
function writePrivate(file: string, text: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  // The mode is taken at creation only; an existing file keeps the one it had.
  try { chmodSync(file, 0o600); } catch { /* Windows keeps to its own permissions */ }
  return file;
}

export function writeEnrollment(home: string, enrollment: Enrollment): string {
  return writePrivate(join(home, "fleet.json"), `${JSON.stringify(enrollment, null, 2)}\n`);
}

/** The member's token: `SHIPYARD_TOKEN`, else `<home>/token`; null when there is none. */
export function readToken(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env["SHIPYARD_TOKEN"]) return env["SHIPYARD_TOKEN"];
  const file = join(home, "token");
  if (!existsSync(file)) return null;
  const token = readFileSync(file, "utf8").trim();
  return token || null;
}

export function writeToken(home: string, token: string): string {
  return writePrivate(join(home, "token"), `${token}\n`);
}

/** The host, for the Fleet page: nothing that identifies a person beyond the machine's own name. */
export function hostInfo(): HostInfo {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    osRelease: os.release(),
    node: process.versions.node,
    cpus: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
  };
}

/**
 * The commit this process runs: the checkout's HEAD, in full, or null when it
 * is not a git checkout. Read once at start: a checkout moved under a running
 * member is not what that member runs.
 */
export function checkoutCommit(root: string = REPO_ROOT): string | null {
  try {
    return commitOf(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).toString());
  } catch {
    return null;
  }
}
