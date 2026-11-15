import type { HostInfo, MemberAck, MemberConfig, MemberNote } from "../shared/protocol.js";
import type { WireEvent } from "../shared/replay-cache.js";

/**
 * A fleet member's calls to the platform, over HTTPS, with its token as the
 * bearer on every one (src/platform/http.ts, /fleet/…).
 *
 * Everything a member tells the platform goes this way — who it is, what its
 * engines are doing, that it is still there — and so does everything it must
 * be able to ask for: its configuration, and a GitHub token. The socket
 * (uplink.ts) only carries what cannot wait for the next heartbeat.
 */

/** A refusal from the platform, or that it could not be reached at all. */
export class PlatformRefusal extends Error {
  constructor(
    /** The HTTP status; 0 when the platform could not be reached. */
    readonly status: number,
    readonly code: string,
    message: string,
    readonly remedy: string | null = null,
  ) {
    super(message);
    this.name = "PlatformRefusal";
  }

  /** The platform no longer takes this machine's token: it was retired, or enrolled again elsewhere. */
  get unenrolled(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** Worth trying again later: the network, or the platform having a bad moment. */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

/** What a member says about itself with every post. */
export interface MemberReport {
  /** The id of this process: a new one tells the platform the member started again. */
  boot: string;
  commit: string | null;
  host?: HostInfo;
  /** Every problem it has right now; an empty list clears them. */
  notes?: Array<Pick<MemberNote, "code" | "message">>;
}

export interface GitHubToken {
  token: string;
  /** Epoch millis it stops working. */
  expiresAtMs: number;
  /** The repositories it reaches. */
  repos: string[];
}

export interface PlatformClientOptions {
  platformUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** How long a call may take before it is given up on. */
  timeoutMs?: number;
}

export class PlatformClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /**
   * How long Shipyard took to answer the last call it answered at all, in
   * millis; null before the first. What the member reports as how far away
   * Shipyard is (system-monitor.ts): it is measured on calls already made.
   */
  lastRoundTripMs: number | null = null;

  constructor(options: PlatformClientOptions) {
    this.base = options.platformUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Say who this is, and be told what to be. */
  async hello(report: MemberReport): Promise<MemberConfig> {
    return (await this.call<{ config: MemberConfig }>("POST", "/fleet/hello", report)).config;
  }

  async config(): Promise<MemberConfig> {
    return (await this.call<{ config: MemberConfig }>("GET", "/fleet/config")).config;
  }

  /** Report a batch of events, in the order they happened. */
  events(report: MemberReport, events: readonly WireEvent[]): Promise<MemberAck> {
    return this.call<MemberAck>("POST", "/fleet/events", { ...report, events });
  }

  /** Say it is still there, with nothing else to say. */
  beat(report: MemberReport): Promise<MemberAck> {
    return this.call<MemberAck>("POST", "/fleet/beat", report);
  }

  /** A GitHub token for the repositories assigned to this member, good for an hour. */
  async githubToken(): Promise<GitHubToken> {
    const body = await this.call<{ token: string; expiresAt: string; repos: string[] }>("POST", "/fleet/github-token", {});
    const expiresAtMs = Date.parse(body.expiresAt);
    return {
      token: body.token,
      // GitHub mints for an hour; a time that cannot be read is taken as nearly up.
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 10 * 60_000,
      repos: body.repos,
    };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    const began = performance.now();
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          "user-agent": "shipyard-fleet",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new PlatformRefusal(0, "UNREACHABLE", `Shipyard could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.lastRoundTripMs = Math.round(performance.now() - began);
    let json: Record<string, unknown> | null = null;
    try { json = await res.json() as Record<string, unknown>; } catch { /* no body, or not JSON */ }
    if (!res.ok || json?.["ok"] === false) {
      throw new PlatformRefusal(
        res.status,
        typeof json?.["code"] === "string" ? json["code"] : `HTTP_${res.status}`,
        typeof json?.["error"] === "string" ? json["error"] : `Shipyard answered ${res.status}`,
        typeof json?.["remedy"] === "string" ? json["remedy"] : null,
      );
    }
    return (json ?? {}) as T;
  }
}
