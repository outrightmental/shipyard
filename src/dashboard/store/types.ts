import type { PillActivity } from '../shared/pill-activity.js';

export interface CylinderState {
  index: number;
  /** Stable color of the issue this cylinder is working, or null when it has
   *  no issue (idle) — colors belong to issues, not cylinders (issue #236).
   *  Always at full saturation, and drawn so for as long as the cylinder
   *  holds the work (`cylinderColor` in shared/burn-level.ts, issue #286). */
  color: string | null;
  colorRgb: string | null;
  status: 'idle' | 'active' | 'done' | 'error' | 'shutdown';
  idleStatusText: string;
  actionType: string | null;
  /** "owner/repo" this cylinder is currently working, or null when idle. */
  repo: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  /** Titles of the issue/PR being worked, carried on the action so the work
   *  can still be drawn when it has left GitHub's open lists (e.g. an issue
   *  closed mid-flight). Null when unknown or idle. */
  issueTitle: string | null;
  prTitle: string | null;
  model: string | null;
  iterationNumber: number;
  thinkingLines: string[];
  actionStartedAt: number | null;
  nextCycleAtMs: number | null;
  rateLimitedUntilMs: number | null;
  /** On Shipyard's dashboard, the fleet member whose engine this is; absent on
   *  a pool's own dashboard, where every engine is the one pool's. */
  memberId?: string;
  /** On Shipyard's dashboard, its number within its member's pool, from 1 —
   *  what its ring says. `index` is then its number across the whole fleet,
   *  which is what tells it from every other engine on the field. */
  memberIndex?: number;
}

/**
 * A hold parking the whole engine pool until `untilMs` — the Claude
 * subscription quota or a GitHub rate limit. Global, not per cylinder: while
 * one is active nothing anywhere is being worked on.
 */
export interface WorkHold {
  /** Which shared resource ran out: "claude-usage-limit", "github-rate-limit". */
  kind: string;
  /** Short human-readable cause, e.g. "Claude usage limit". */
  reason: string;
  /** Epoch millis the hold ends and work resumes. */
  untilMs: number;
}

/**
 * The latest reading of the free space where yoke keeps its checkouts (#288).
 * `low` means even removing every idle checkout left it below the floor, so no
 * new work starts until there is room — the inbox lists it as a card.
 */
export interface DiskSpace {
  /** The directory whose filesystem was read: the checkout root. */
  path: string;
  freeBytes: number;
  /** `min_free_disk_gb`, in bytes. */
  minFreeBytes: number;
  low: boolean;
  /** Epoch millis of the reading. */
  atMs: number;
}

/**
 * A Claude account's usage windows, by their key in Anthropic's response: the
 * rolling 5-hour window and the weekly one (mirrors `UsageWindow` in
 * src/anthropic-usage.ts).
 */
export type UsageWindow = 'five_hour' | 'seven_day';

/**
 * The latest reading of the Claude account's usage — of whichever window is
 * nearest its limit — for the usage gauge (mirrors `UsageReading` in
 * src/anthropic-usage.ts).
 */
export interface AccountUsage {
  /** "ok": live numbers; "unconfigured": no token to read with, so the gauge
   *  is OFF; "unavailable": there is a token but the reading could not be taken. */
  status: 'ok' | 'unconfigured' | 'unavailable';
  /** Which window the numbers are of; null whenever `usedPercent` is. */
  window: UsageWindow | null;
  /** Percent (0–100) of that window consumed; null unless status is "ok",
   *  or an "unavailable" reading holds over the last good one's (see `heldFromMs`). */
  usedPercent: number | null;
  /** Epoch millis that window resets; null when unknown or none is open. */
  resetsAtMs: number | null;
  /** Epoch millis the reading was taken. */
  fetchedAtMs: number;
  /** Why there are no fresh numbers; empty when status is "ok". */
  reason: string;
  /** Set only on an "unavailable" reading that still carries the last good
   *  reading's numbers: the epoch millis those numbers were read. */
  heldFromMs?: number;
}

/**
 * A wall-clock time the server rendered into a line of text, in its own zone,
 * with the instant it stands for — so the dashboard can render it again in the
 * viewer's (mirrors `ClockTimeRef` in src/claude-agent.ts).
 */
export interface ClockTimeRef {
  /** The time exactly as the server rendered it into the text. */
  text: string;
  /** Epoch millis it stands for. */
  atMs: number;
}

export interface IssueCard {
  number: number;
  title: string;
  state: string;
}

export interface PRCard {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  checksStatus?: string;
  closingIssueNumbers?: number[];
  linkedIssueNumbers?: number[];
}

export interface LifecyclePair {
  issue?: IssueCard | null;
  pr?: PRCard | null;
  prPhase: string;
  colorIndex?: number;
  blockedByIssueNumbers?: number[];
  disabled?: boolean;
  /** Project status label for work out of the queue (e.g. "Backlog", "Done"). */
  projectStatus?: string;
  /** "owner/repo" this pair belongs to (set by the store from the update's scope). */
  repo?: string;
  /** Set while a review-gated PR waits on a human (#274): `awaiting-approval`
   *  while it is parked (its inbox card offers Approve), `approved` once
   *  approved and its squash-merge is pending. */
  approval?: 'awaiting-approval' | 'approved';
  /** Set while yoke has asked a person to review the PR on GitHub and waits
   *  for it (Project SDLC). The inbox lists it, with a link to the PR. */
  awaitingReview?: boolean;
  /** Set on work in a repository Shipyard is subscribed to and no fleet member
   *  is assigned: it is on the field, and nothing is coming for it until one is. */
  unassigned?: boolean;
}

/**
 * One fleet member, on Shipyard's dashboard: a machine and a Claude account,
 * with a pool of engines of its own. What a pool's own dashboard says once
 * for the whole run — the account's usage, a hold parking every engine, that
 * it is shutting down — Shipyard says once per member, in the heading of that
 * member's group of engines.
 */
export interface FleetCrew {
  id: string;
  name: string;
  /** Heard from lately (src/shared/protocol.ts `memberOnline`). */
  online: boolean;
  /** Epoch millis it was last heard from; null if it never has been. */
  lastSeenAtMs: number | null;
  /** The latest reading of its Claude account's usage, or null before the first. */
  usage: AccountUsage | null;
  /** The hold parking its pool, or null. */
  hold: WorkHold | null;
  /** Its process is finishing what is in flight and stopping — to update itself, usually. */
  stopping: boolean;
  /** Its process has stopped. */
  stopped: boolean;
  /** The repositories assigned to it, "owner/repo". */
  repos: string[];
  /** What it has said is wrong with it, in a line; null when nothing is. */
  problem: string | null;
}

/**
 * Something about the fleet an operator should be told: a repository nobody
 * is assigned, a member assigned nothing, a member that is not there. Each is
 * a card in the inbox. (`FleetNotice` in src/shared/notices.ts, worked into
 * what a card says.)
 */
export interface FleetNoticeCard {
  /** Stable for as long as the notice stands. */
  id: string;
  /** An alarm stops work that was under way; a warning is work not started. */
  accent: 'warning' | 'alarm';
  eyebrow: string;
  title: string;
  /** "owner/repo" it is about, or empty. */
  repo: string;
  facts: string[];
  line: string;
  /** Where its button goes: a page of the console, or a page on GitHub. */
  action: { label: string; hint: string; page?: string; href?: string } | null;
}

/** Where one dashboard approval stands (#276); see `PullRequestApprovalStatus`. */
export type PullRequestApprovalState = 'loading' | 'waiting' | 'approved' | 'refused' | 'failed';

/**
 * Where one dashboard approval of one PR stands (#276), as the latest
 * `pull-request-approval` event for it said (mirrors `PullRequestApproval` in
 * src/dashboard-approval.ts), with the time it arrived here.
 */
export interface PullRequestApprovalStatus {
  /** "owner/repo". */
  repo: string;
  pullRequestNumber: number;
  /** ISO time the server received the request that started this attempt. */
  requestedAt: string;
  /** `loading`: reading the PR from GitHub; `waiting`: waiting for a free
   *  planner; then how it ended. */
  state: PullRequestApprovalState;
  /** For `refused` and `failed`: why, in the log line's words. */
  reason?: string;
  /** For `approved`: the merge waits for the PR's checks. */
  checksPending?: boolean;
  /** For `approved`: an earlier approval stands. */
  alreadyApproved?: boolean;
  /** The server's stamp on the event, which tells a replay of it (on a
   *  reconnect) from a new answer. */
  emittedAt: string;
  /** Epoch millis, by this browser's clock, the event arrived. Compared only
   *  with this browser's own times, so the server's clock never matters. */
  receivedAtMs: number;
}

/**
 * A press of a pill's Approve button on this dashboard (#278). The store keeps
 * it per PR rather than the pill element keeping it: the lifecycle list reuses
 * elements as pills move, and a reconnect rebuilds the state, and neither may
 * make a press look as if it never happened.
 */
export interface ApprovalPress {
  /** "owner/repo"; empty only when the pill did not know its project. */
  repo: string;
  pullRequestNumber: number;
  /** Epoch millis of the press, by this browser's clock. */
  atMs: number;
  /** False while it waits for a live connection to send it on. */
  sent: boolean;
  /** Epoch millis it was last sent, when that was after the press: sent
   *  again on reconnecting, because yoke had not answered it. */
  sentAtMs?: number;
  /** An engine has since squash-merged the PR. */
  merged?: boolean;
}

/**
 * An action an engine ran that failed. The cylinder itself forgets the failure
 * at once — in the same tick it reports itself idle and starts its cycle wait
 * — and the line in the event log scrolls away, so the store keeps it here for
 * the inbox to say, until an engine takes the work up again.
 */
export interface ActionFailure {
  /** The work it was on, as `failureKey` names it. */
  key: string;
  /** "owner/repo"; empty when the action did not say. */
  repo: string;
  /** The action that failed, e.g. "self-review". */
  actionType: string;
  issueNumber: number | null;
  prNumber: number | null;
  issueTitle: string | null;
  prTitle: string | null;
  /** The first line of the error; the event log has the rest. */
  error: string;
  /** Epoch millis of the failure, from the event's stamp. */
  atMs: number;
  /** The engine that ran it, counted from 0. */
  engineIndex: number;
}

export interface BroadcastEventData {
  id: string;
  category: string;
  label: string;
  stateBefore: string;
  changeHow: string;
  stateAfter: string;
  excellence: string;
  workerIndex?: number;
  prNumber?: number;
  issueNumber?: number;
  commitHash?: string;
  runId?: string;
  /** "owner/repo" this feed item belongs to (shown as a chip in multi-project mode). */
  repo?: string;
  /** Epoch millis of the event, rendered in the viewer's time zone. */
  atMs: number;
  /** Stable color of the issue this event pertains to, or the neutral gray
   *  when the event has no associated issue. */
  color: string;
}

export interface EventLine {
  text: string;
  cylinderIdx: number;
  level: string;
  /** Epoch millis of the event, rendered in the viewer's time zone. */
  atMs: number;
  color: string | null;
  /** "owner/repo" this log line came from, when it originates from a project. */
  repo?: string;
}

export interface DashboardState {
  connection: 'connecting' | 'connected' | 'disconnected';
  maxConcurrency: number;
  cylinders: CylinderState[];
  issueCards: Map<number, IssueCard>;
  prCards: Map<number, PRCard>;
  cylinderByIssue: Map<number, number>;
  cylinderByPR: Map<number, number>;
  /** Lifecycle pairs per project ("owner/repo" → pairs). Kept separate so the
   *  projects sharing one dashboard never clobber each other's pane. */
  lifecycleByRepo: Map<string, LifecyclePair[]>;
  /** Flattened view of lifecycleByRepo, recomputed on each lifecycle update. */
  lastLifecyclePairs: LifecyclePair[];
  /** Active session count per project; `sessionCount` is their sum. */
  sessionCountByRepo: Map<string, number>;
  broadcastQueue: BroadcastEventData[];
  broadcastVisible: BroadcastEventData[];
  eventStream: EventLine[];
  eventCount: number;
  sessionCount: number;
  shutdownRequested: boolean;
  appShutdown: boolean;
  /** Each pill's activity, by pill key, as it stood when the pills went dark at
   *  shutdown (issue #268); null while yoke is running. */
  frozenPillActivity: Map<string, PillActivity | null> | null;
  /** The hold parking every engine, or null when work is free to run. */
  hold: WorkHold | null;
  /** Latest Claude account usage reading, or null until the first arrives. */
  usage: AccountUsage | null;
  /** Latest reading of the checkout disk's free space, or null until the first. */
  disk: DiskSpace | null;
  /** Each PR's latest dashboard approval (#276), keyed like the pill's
   *  `approveKey` ("owner/repo#n"). Outcomes drop out once they are stale. */
  approvals: Map<string, PullRequestApprovalStatus>;
  /** This dashboard's own Approve presses (#278), keyed like `approvals`. A
   *  press stays until its PR leaves the lifecycle, and keeps the answer to
   *  it in `approvals` from going stale. */
  approvalPresses: Map<string, ApprovalPress>;
  /** The latest failed action on each piece of work, by `failureKey`, until an
   *  engine starts on that work again or the failure is too old to matter. */
  failures: Map<string, ActionFailure>;
  /** True when more than one project shares this dashboard. */
  multiProject: boolean;
  owner: string;
  repo: string;
  title: string;
  /** What this is a dashboard of: "Yoke" for a pool run by hand, "Shipyard"
   *  for the fleet's dashboard and for a fleet member's own screen. */
  brand: string;
  /** Shipyard's dashboard: the fleet's members, in the order they joined, each
   *  with the engines in `cylinders` that carry its id. Null on a pool's own
   *  dashboard, whose engines are one pool and need no heading. */
  fleet: FleetCrew[] | null;
  /** What the fleet has to say to an operator; empty on a pool's own dashboard. */
  notices: FleetNoticeCard[];
  /** A fleet member's own screen: it shows what is waiting on a person, and
   *  takes no decisions — those are made in Shipyard. */
  readOnly: boolean;
}
