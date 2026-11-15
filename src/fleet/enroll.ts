import { execFileSync } from "node:child_process";
import type { HostInfo } from "../shared/protocol.js";
import { readEnrollment, readToken, writeEnrollment, writeToken, type Enrollment } from "./machine.js";

/**
 * Enrolling a machine (#4, `npm run enroll`): what the script does, as
 * functions a test can drive with a `fetch` of its own.
 *
 * A machine joins the fleet with a one-time code an operator makes in the
 * console (Fleet, Enroll a machine): fifteen minutes, one machine, once. The
 * code is redeemed here for the machine's token, which is written where only
 * this machine's user can read it and never shown.
 */

export interface EnrollOptions {
  platformUrl: string;
  code: string;
  /** What the machine is to be called; the platform keeps the name an already-enrolled machine has unless one is given. */
  name?: string | null;
  home: string;
  host: HostInfo;
  commit: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface EnrollOutcome extends Enrollment {
  /** True when the machine was already a member and stays that one: its name and repositories kept, its old token dead. */
  reenrolled: boolean;
  files: { enrollment: string; token: string };
}

/** Why the platform would not enroll the machine: what it said, and what to do about it. */
export class EnrollRefused extends Error {
  constructor(readonly code: string, message: string, readonly remedy: string | null) {
    super(message);
    this.name = "EnrollRefused";
  }
}

/**
 * Redeem the code at the platform for this machine's token, and keep what
 * the member needs in `home`. A machine enrolled before says who it was, with
 * the token it has, and stays that member.
 */
export async function enrollMachine(options: EnrollOptions): Promise<EnrollOutcome> {
  const base = options.platformUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const earlier = readEnrollment(options.home);
  const earlierToken = readToken(options.home, {});
  const previous = earlier && earlierToken ? { memberId: earlier.memberId, token: earlierToken } : null;

  let res: Response;
  try {
    res = await fetchImpl(`${base}/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "shipyard-fleet" },
      body: JSON.stringify({ code: options.code, name: options.name ?? undefined, host: options.host, commit: options.commit, previous }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new EnrollRefused("UNREACHABLE", `${base} could not be reached: ${error instanceof Error ? error.message : String(error)}`, null);
  }
  let body: Record<string, unknown> | null = null;
  try { body = await res.json() as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok || body?.["ok"] !== true || typeof body["token"] !== "string" || typeof body["memberId"] !== "string") {
    throw new EnrollRefused(
      typeof body?.["code"] === "string" ? body["code"] : `HTTP_${res.status}`,
      typeof body?.["error"] === "string" ? body["error"] : `the platform answered ${res.status}`,
      typeof body?.["remedy"] === "string" ? body["remedy"] : null,
    );
  }

  const enrollment: Enrollment = {
    memberId: body["memberId"],
    name: typeof body["name"] === "string" ? body["name"] : body["memberId"],
    platformUrl: typeof body["platformUrl"] === "string" ? body["platformUrl"].replace(/\/+$/, "") : base,
    wsUrl: typeof body["wsUrl"] === "string" ? body["wsUrl"] : "",
    enrolledAt: new Date((options.now ?? Date.now)()).toISOString(),
  };
  // The token before the enrollment: an enrollment with no token beside it would be a member that cannot speak.
  const token = writeToken(options.home, body["token"]);
  const file = writeEnrollment(options.home, enrollment);
  return { ...enrollment, reenrolled: body["reenrolled"] === true, files: { enrollment: file, token } };
}

/** Ask the platform, as the member, until it says the member is online (or the time is up). */
export async function waitUntilOnline(options: {
  platformUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  everyMs?: number;
}): Promise<boolean> {
  const base = options.platformUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  for (;;) {
    try {
      const res = await fetchImpl(`${base}/enroll/status`, { headers: { authorization: `Bearer ${options.token}`, accept: "application/json" } });
      if (res.ok) {
        const body = await res.json() as { member?: { online?: boolean } };
        if (body.member?.online === true) return true;
      }
    } catch {
      // The platform or the network: asked again.
    }
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => { setTimeout(resolve, options.everyMs ?? 3_000); });
  }
}

/** What a command says of its version, or null when it is not there to be run. */
export function commandVersion(command: string, args: string[] = ["--version"]): string | null {
  try {
    const out = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
      // A command on Windows may be a .cmd shim, which only a shell can run.
      shell: process.platform === "win32",
    }).toString().trim();
    return out.split("\n")[0]?.trim() || "";
  } catch {
    return null;
  }
}
