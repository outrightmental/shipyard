import type { WireEvent } from "./replay-cache.js";

/**
 * What the platform, the fleet and the console say to one another.
 *
 * Three parties, two channels:
 *
 *   fleet member ──HTTPS──▶ platform        hello, events up, heartbeat, a GitHub token
 *   fleet member ◀───WS──── platform        a poke (config changed), a command (approve, cancel), a release
 *   console      ──HTTPS──▶ platform        everything the operator does (/api/…)
 *   console      ◀───WS──── platform        every member's events, and that the fleet changed
 *   console      ───WS────▶ platform        an Approve press, a cancel
 *
 * A member sends its events up over HTTPS, in order, one batch at a time, and
 * keeps the socket for what must reach it at once. So a member whose socket is
 * down still reports, and hears that its configuration changed at its next
 * heartbeat.
 */

/** The pseudo-member whose events are the platform's own: the work of repositories no member is assigned. */
export const CENTRAL_MEMBER_ID = "central";

/** How often a member with nothing to say says so. */
export const HEARTBEAT_MS = 20_000;

/** A member not heard from for this long is offline. */
export const OFFLINE_AFTER_MS = 75_000;

/** How long an enrollment code lasts. */
export const ENROLL_CODE_MS = 15 * 60_000;

export interface HostInfo {
  hostname: string;
  platform: string;
  arch: string;
  osRelease: string;
  node: string;
  cpus: number;
  totalMemoryMb: number;
}

/** Something a member says about itself that an operator should see: why it cannot update, that its Claude login lapsed. */
export interface MemberNote {
  /** A stable code: "UPDATE_BLOCKED", "CLAUDE_AUTH", "GITHUB_TOKEN". */
  code: string;
  message: string;
  /** ISO time it was last said. */
  at: string;
}

/** A fleet member, as the console sees it. */
export interface FleetMember {
  id: string;
  name: string;
  /** "active" until an operator retires it. */
  status: "active" | "retired";
  enrolledAt: string;
  enrolledBy: string | null;
  /** ISO time of its last heartbeat or batch of events; null before the first. */
  lastSeenAt: string | null;
  /** The commit its checkout is on. */
  commit: string | null;
  host: HostInfo | null;
  /** The size of its engine pool. */
  maxConcurrency: number;
  /** The repositories assigned to it, "owner/repo". */
  repos: string[];
  notes: MemberNote[];
  /** Whether it holds a socket open right now. */
  connected: boolean;
}

/** Platform-wide engine model and effort defaults, editable from the console. */
export interface EngineDefaults {
  /** Override the default initial-implementation model platform-wide. */
  initialModel?: string;
  /** Override the default review model platform-wide. */
  reviewModel?: string;
  /** Override the default initial-implementation effort platform-wide. */
  initialEffort?: string;
  /** Override the default review effort platform-wide. */
  reviewEffort?: string;
  /** Override the default PR-description model platform-wide. */
  describeModel?: string;
}

/** Per-repository settings a member applies to its work on it. All optional: Shipyard's defaults otherwise. */
export interface RepoSettings {
  /** How many of the member's engines may work this repository at once. */
  maxConcurrency?: number;
  /** A GitHub Projects v2 board number: turns on Project SDLC for the repository. */
  githubProjectNumber?: number;
  /** GitHub logins to ask for review, in Project SDLC. */
  reviewers?: string[];
  /** Only issues labelled "focus" are picked up. */
  focusMode?: boolean;
  /** Minutes a PR's checks may run before the unfinished ones count as stalled and are cancelled (default 60). */
  checksTimeoutMinutes?: number;
  /** Override the initial-implementation model for this repository. */
  initialModel?: string;
  /** Override the review model for this repository. */
  reviewModel?: string;
  /** Override the initial-implementation effort for this repository. */
  initialEffort?: string;
  /** Override the review effort for this repository. */
  reviewEffort?: string;
  /** Override the PR-description model for this repository. */
  describeModel?: string;
}

/** A repository Shipyard is subscribed to. */
export interface SubscribedRepo {
  /** "owner/repo". */
  repo: string;
  /** The fleet member that works it; null while it is assigned to no one, and gets no work done. */
  memberId: string | null;
  subscribedAt: string;
  subscribedBy: string | null;
  settings: RepoSettings;
}

/** The GitHub App Shipyard connects as, as the console sees it. Never its secrets. */
export interface GitHubStatus {
  /** The app exists: the operator created it from the console. */
  connected: boolean;
  /** The organization it was made for. */
  org: string | null;
  app: { id: number; slug: string; name: string; htmlUrl: string; installUrl: string } | null;
  /** Where it is installed; null until the operator installs it on the organization. */
  installation: { id: number; account: string; repositorySelection: string; htmlUrl: string } | null;
}

/** A repository the app's installation can see. */
export interface AvailableRepo {
  repo: string;
  private: boolean;
  archived: boolean;
  description: string | null;
  defaultBranch: string;
  htmlUrl: string;
}

/** What a member is told to be: the answer to hello, and to GET /fleet/config. */
export interface MemberConfig {
  member: { id: string; name: string };
  /** The commit the platform runs; null when it was applied by hand and announces none. */
  release: string | null;
  /** Changes whenever anything below does, so a member knows to ask again. */
  configVersion: string;
  maxConcurrency: number;
  repos: Array<{ repo: string } & RepoSettings>;
  /** Platform-wide engine defaults; per-repo settings override these, machine settings override those. */
  engineDefaults: EngineDefaults;
  /** Whether Shipyard can mint this member a GitHub token at all. */
  github: { ready: boolean };
  /**
   * Who the member's commits are by: the GitHub App itself, so that what
   * Shipyard does on GitHub is in its name from the commit to the pull
   * request. Null until the app exists.
   */
  git: { name: string; email: string } | null;
  wsUrl: string;
}

/** The answer to every member post: enough to notice it must ask for its config again, or update. */
export interface MemberAck {
  ok: true;
  release: string | null;
  configVersion: string;
}

/** Everything a console opened now needs: GET /api/state. */
export interface ConsoleState {
  release: string | null;
  serverTimeMs: number;
  operator: { email: string | null };
  members: FleetMember[];
  repos: SubscribedRepo[];
  github: GitHubStatus;
  /** Platform-wide engine defaults, editable from the console. */
  engineDefaults: EngineDefaults;
  /** Each member's replayable events, by member id. */
  cached: Record<string, WireEvent[]>;
}

/** Platform → console, over the socket. */
export type ConsolePush =
  | { t: "events"; member: string; events: WireEvent[] }
  /** A member started again: what its last process was doing is gone. */
  | { t: "member-reset"; member: string }
  /**
   * A member was heard from: its `lastSeenAt` is now `at`. Said as often as
   * that is written, because nothing else tells an open console so — a member
   * doing nothing but its work changes nothing about the fleet, and a console
   * left to its own copy would call it offline a minute after reading it.
   */
  | { t: "seen"; member: string; at: string }
  /** The fleet, the repositories or the GitHub connection changed: read /api/state again. */
  | { t: "changed" }
  /** Too much happened to push: read /api/state again. */
  | { t: "resync" }
  | { t: "pong" };

/** Console → platform, over the socket. */
export type ConsoleSend =
  | { t: "approve"; repo: string; pullRequestNumber: number }
  | { t: "cancel"; member: string; engineIndex: number }
  | { t: "ping" };

/** Platform → member, over the socket. */
export type MemberPush =
  /** Its configuration changed: ask for it again. */
  | { t: "poke" }
  /** The platform runs this commit now. */
  | { t: "release"; release: string | null }
  | { t: "command"; command: "pull-request-approve"; repo: string; pullRequestNumber: number; by: string | null }
  | { t: "command"; command: "cylinder-cancel"; engineIndex: number; by: string | null }
  /** An operator retired this machine: stop, and do not come back. */
  | { t: "retired" }
  | { t: "pong" };

/** A member's status at `nowMs`. */
export function memberOnline(member: Pick<FleetMember, "lastSeenAt" | "status">, nowMs: number): boolean {
  if (member.status !== "active" || member.lastSeenAt === null) return false;
  const seen = Date.parse(member.lastSeenAt);
  return Number.isFinite(seen) && nowMs - seen < OFFLINE_AFTER_MS;
}

/** "owner/repo", or null when it is not one. */
export function parseRepo(value: unknown): { owner: string; name: string; repo: string } | null {
  if (typeof value !== "string") return null;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(value.trim());
  if (!match) return null;
  return { owner: match[1]!, name: match[2]!, repo: `${match[1]}/${match[2]}` };
}
