/**
 * A fleet member's machine, measured.
 *
 * Shipyard hands work to machines it cannot see. Whether one is short of
 * processor, memory or disk, slow to reach, or simply struggling, is what an
 * operator needs before giving it more cylinders or another repository — and
 * is otherwise only found out when work on it goes slowly. So a member
 * measures the machine it runs on and reports it with everything else it
 * reports, as a `system-update` event, and each member's heading on the
 * dashboard says what its machine is doing.
 *
 * This is the reading itself and nothing else: what a member writes
 * (src/fleet/system-monitor.ts), what the platform keeps the latest of
 * (replay-cache.ts), and what a dashboard reads (src/dashboard/shared/system-view.ts).
 */

/** How often a member measures and reports. A member is taken as gone after 75 seconds of silence. */
export const SYSTEM_REPORT_MS = 15_000;

export interface SystemReading {
  /** When it was measured, in epoch millis, by the member's own clock. */
  atMs: number;
  cpu: {
    /** How much of every core was busy since the reading before, 0–100; null for a first reading, which has none before it. */
    percent: number | null;
    /** The same for the busiest single core: one core flat out is not a busy machine, and can still be what work waits on. */
    busiestPercent: number | null;
    cores: number;
    /** Processes ready to run, averaged over 1, 5 and 15 minutes; null where the system keeps no such number (Windows). */
    load: [number, number, number] | null;
  };
  memory: {
    /** In use, and not to be had by asking: what is cached and would be given up is not counted. */
    usedBytes: number;
    totalBytes: number;
  };
  /** The disk the member's checkouts are on; null when it could not be read. */
  disk: { freeBytes: number; totalBytes: number } | null;
  /** The member's own process. */
  process: {
    rssBytes: number;
    /** The latest its event loop ran since the reading before, in millis: a member that is itself held up. */
    loopLagMs: number;
    uptimeSeconds: number;
  };
  /** How long Shipyard took to answer the member's last post, in millis; null before the first. */
  platformMs: number | null;
  /** How long the machine has been up, in seconds. */
  uptimeSeconds: number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const atLeastZero = (value: unknown): number | null => (finite(value) && value >= 0 ? value : null);
const percent = (value: unknown): number | null => (finite(value) ? Math.min(100, Math.max(0, value)) : null);
const record = (value: unknown): Record<string, unknown> | null =>
  (typeof value === "object" && value !== null ? value as Record<string, unknown> : null);

/**
 * The reading an event carries, or null when what it carries is not one. A
 * member is another machine on another commit: what it sends is taken for what
 * it is only so far as it is well formed, and a number that makes no sense is
 * left out rather than drawn.
 */
export function systemReadingOf(data: unknown): SystemReading | null {
  const root = record(data);
  const cpu = record(root?.["cpu"]);
  const memory = record(root?.["memory"]);
  const own = record(root?.["process"]);
  if (!root || !cpu || !memory || !finite(root["atMs"])) return null;
  const totalBytes = atLeastZero(memory["totalBytes"]);
  const usedBytes = atLeastZero(memory["usedBytes"]);
  const cores = atLeastZero(cpu["cores"]);
  if (totalBytes === null || usedBytes === null || cores === null) return null;

  const loads = Array.isArray(cpu["load"]) ? cpu["load"].map(atLeastZero) : null;
  const load = loads && loads.length === 3 && loads.every((value) => value !== null) ? loads as [number, number, number] : null;
  const disk = record(root["disk"]);
  const freeBytes = atLeastZero(disk?.["freeBytes"]);
  const diskBytes = atLeastZero(disk?.["totalBytes"]);

  return {
    atMs: root["atMs"],
    cpu: { percent: percent(cpu["percent"]), busiestPercent: percent(cpu["busiestPercent"]), cores: Math.round(cores), load },
    memory: { usedBytes: Math.min(usedBytes, totalBytes), totalBytes },
    disk: freeBytes !== null && diskBytes !== null && diskBytes > 0 ? { freeBytes: Math.min(freeBytes, diskBytes), totalBytes: diskBytes } : null,
    process: {
      rssBytes: atLeastZero(own?.["rssBytes"]) ?? 0,
      loopLagMs: atLeastZero(own?.["loopLagMs"]) ?? 0,
      uptimeSeconds: atLeastZero(own?.["uptimeSeconds"]) ?? 0,
    },
    platformMs: atLeastZero(root["platformMs"]),
    uptimeSeconds: atLeastZero(root["uptimeSeconds"]) ?? 0,
  };
}
