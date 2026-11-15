/**
 * Which of the events an engine pool emits a dashboard opened now must be
 * brought up to date with, and under what key.
 *
 * Yoke's dashboard server kept this in memory: a map of the latest event per
 * key, replayed to every browser that connected. Shipyard keeps the same map
 * per fleet member in its table (src/platform/relay.ts), so the rule for what
 * goes in it lives here, where the local dashboard server and the platform
 * both read it.
 *
 * Most events are not kept at all — a log line is history, not state. The ones
 * that are replace the last event under their key, and a few clear a key.
 */

export interface WireEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface ReplayOp {
  /** Keep this event under this key, in place of whatever was there. */
  set?: string;
  /** Forget whatever is under these keys. */
  delete?: string[];
}

/** The key of a project's lifecycle in the cache: what the lower section of the field is drawn from. */
export function lifecycleKey(repo: string): string {
  return `lifecycle-update:${repo}`;
}

/** The key of a project's snapshot in the cache. */
export function snapshotKey(repo: string): string {
  return `snapshot-update:${repo}`;
}

/** What `event` does to the replay cache; an empty op for one that is not kept. */
export function replayOp(event: WireEvent): ReplayOp {
  const { type, data } = event;
  switch (type) {
    case "lifecycle-update":
    case "snapshot-update":
      // Scoped per project, so the projects sharing a pool each keep their own
      // latest instead of overwriting one another.
      return { set: `${type}:${(data["repo"] as string) || ""}` };
    case "action-start":
    case "action-complete":
    case "action-error":
      return { set: `cylinder-${((data["actionIndex"] as number) || 1) - 1}` };
    case "iteration-start":
    case "engine-idle":
    case "engine-shutdown":
      return { set: `cylinder-${(data["engineIndex"] as number) ?? 0}` };
    case "github-rate-limit":
      return { set: type };
    case "github-rate-limit-cleared":
      return { delete: ["github-rate-limit"] };
    case "work-hold":
      // Replayed so a dashboard opened during a multi-hour hold still shows it.
      return { set: type };
    case "work-hold-cleared":
      return { delete: ["work-hold"] };
    case "disk-space":
    case "usage-update":
    case "shutdown-requested":
    case "app-shutdown":
      // Only the latest reading matters.
      return { set: type };
    case "pull-request-approval":
      // Each PR's latest approval status (#276 upstream).
      return { set: `pull-request-approval:${String(data["repo"])}#${String(data["pullRequestNumber"])}` };
    case "project-removed": {
      // A repository taken away from this pool: its work is no longer this
      // pool's to show.
      const repo = (data["repo"] as string) || "";
      return { delete: [lifecycleKey(repo), snapshotKey(repo)] };
    }
    default:
      return {};
  }
}

/**
 * The keys that describe a running process rather than the work: what its
 * engines are doing, what is holding it, that it is shutting down. They mean
 * nothing once that process has gone, so a member that starts again begins
 * with these cleared. The work itself — each project's lifecycle — and the
 * last usage reading are kept: they are still true while it restarts.
 */
export function isProcessKey(key: string): boolean {
  return (
    key.startsWith("cylinder-") ||
    key.startsWith("pull-request-approval:") ||
    key === "work-hold" ||
    key === "github-rate-limit" ||
    key === "shutdown-requested" ||
    key === "app-shutdown" ||
    key === "disk-space"
  );
}
