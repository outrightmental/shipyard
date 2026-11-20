import type { DashboardState, WorkHold } from '../store/types.js';
import { formatClockTime, formatDuration } from './format.js';
import { usageGaugeView, usageLimitUntilMs, type UsageGaugeView } from './usage-gauge.js';

/** A hold parking the whole pool, as the field says it. */
export interface HoldView {
  kind: string;
  /** "2h 14m": how long is left. */
  remaining: string;
  /** "Sep 21, 8:50 AM", in the viewer's time zone (#272). */
  deadline: string;
  /** "Claude usage limit". */
  reason: string;
  untilMs: number;
}

/** Whether yoke is running, draining after a stop order, or has stopped. */
export type RunPhase = 'running' | 'shutting-down' | 'shut-down';

/**
 * The HUD state slot value shown while a pool is shutting down, derived from
 * the reason it was asked to stop.
 */
export function shutdownHudLabel(reason: string | null): string {
  if (!reason) return 'STOPPING';
  if (reason.startsWith('updating to ')) return `UPDATING ${reason.slice('updating to '.length)}`;
  if (reason === 'its engine pool was resized') return 'RESTARTING';
  if (reason.startsWith('an operator retired')) return 'RETIRING';
  if (reason.startsWith('Shipyard no longer takes')) return 'UNENROLLED';
  return 'STOPPING';
}

/**
 * The note shown in a shutting-down pool's burning section and fleet member
 * heading, derived from the reason the pool was asked to stop.
 */
export function shutdownNote(reason: string | null): string {
  if (!reason) return 'finishing what is in flight, then stopping';
  if (reason.startsWith('updating to ')) return `finishing what is in flight, then ${reason}`;
  if (reason === 'its engine pool was resized') return 'finishing what is in flight, then restarting — engine pool resized';
  if (reason.startsWith('an operator retired')) return 'finishing what is in flight, then stopping — retired by an operator';
  if (reason.startsWith('Shipyard no longer takes')) return 'finishing what is in flight, then stopping — Shipyard no longer takes its token';
  return `finishing what is in flight, then stopping — ${reason}`;
}

/**
 * The instruments along the top of the field: what used to be a header bar, a
 * hold banner and a status bar, as one reading of the run.
 */
export interface Vitals {
  /** What this is a dashboard of, said small under the title: "YOKE" for a
   *  pool run by hand, "SHIPYARD" for the fleet's and for a fleet member's. */
  brand: string;
  /** The dashboard's title, as configured (`dashboard_title`). */
  title: string;
  /** "4 projects", or the one project's "owner/repo". */
  subtitle: string;
  /** Where the title links: the project on GitHub, or its owner with several. */
  homeUrl: string;
  /** The latest cycle any engine has started; 0 before the first. */
  cycle: number;
  /** What the run counts down to: the next cycle, or the end of a hold. */
  countdown: { label: 'NEXT' | 'WAITING'; value: string; held: boolean } | null;
  /** The hold parking every engine, or null when work is free to run. */
  hold: HoldView | null;
  /** The Claude account's usage window nearest its limit (#254). */
  usage: UsageGaugeView;
  connection: DashboardState['connection'];
  phase: RunPhase;
  /** Why the pool was asked to stop; null when no reason was given (e.g. operator pressed Ctrl-C). */
  shutdownReason: string | null;
  /** How many engines are in the pool, and how many are running an action. */
  engines: number;
  burning: number;
  eventCount: number;
  sessionCount: number;
}

/** "2 fleet members · 5 repositories": how much the fleet's dashboard is the sum of. */
function fleetSubtitle(state: DashboardState): string {
  const members = state.fleet?.length ?? 0;
  const repos = state.lifecycleByRepo.size;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    count(members, 'fleet member', 'fleet members'),
    ...(repos > 0 ? [count(repos, 'repository', 'repositories')] : []),
  ].join(' · ');
}

/** A hold that is still running at `nowMs`, or null. */
export function liveHold(hold: WorkHold | null, nowMs: number): WorkHold | null {
  return hold !== null && hold.untilMs > nowMs ? hold : null;
}

/**
 * The run's vitals at `nowMs`.
 *
 * A hold outranks every engine's own countdown: while one is active no engine
 * is going to start anything whatever its timer says, and "NEXT 1m" above a
 * pool parked for three hours is the most misleading thing the field could say.
 */
export function vitals(state: DashboardState, nowMs: number): Vitals {
  const hold = liveHold(state.hold, nowMs);
  const cycle = state.cylinders.reduce((max, c) => Math.max(max, c.iterationNumber), 0);
  const nextCycleAtMs = state.cylinders.reduce<number | null>((min, c) => {
    if (c.status === 'idle' && c.nextCycleAtMs !== null && (min === null || c.nextCycleAtMs < min)) {
      return c.nextCycleAtMs;
    }
    return min;
  }, null);

  const target = hold?.untilMs ?? nextCycleAtMs;
  const countdown = target !== null && target > nowMs
    ? { label: hold ? 'WAITING' as const : 'NEXT' as const, value: formatDuration(target - nowMs), held: hold !== null }
    : null;

  const projectCount = state.sessionCountByRepo.size || state.lifecycleByRepo.size;
  // With several projects there is no one repository to name or link to.
  const subtitle = state.fleet !== null
    ? fleetSubtitle(state)
    : state.multiProject
      ? (projectCount > 1 ? `${projectCount} projects` : '')
      : (state.owner && state.repo ? `${state.owner}/${state.repo}` : '');
  const homeUrl = state.multiProject
    ? `https://github.com/${state.owner || ''}`
    : `https://github.com/${state.owner}/${state.repo}`;

  return {
    brand: state.brand || 'Yoke',
    title: state.title || state.brand || 'Yoke',
    subtitle,
    homeUrl,
    cycle,
    countdown,
    hold: hold === null ? null : {
      kind: hold.kind,
      remaining: formatDuration(hold.untilMs - nowMs),
      deadline: formatClockTime(hold.untilMs),
      reason: hold.reason,
      untilMs: hold.untilMs,
    },
    usage: usageGaugeView(state.usage, nowMs, usageLimitUntilMs(hold)),
    connection: state.connection,
    phase: state.appShutdown ? 'shut-down' : state.shutdownRequested ? 'shutting-down' : 'running',
    shutdownReason: state.shutdownReason ?? null,
    engines: state.cylinders.length,
    burning: state.cylinders.filter((c) => c.status === 'active').length,
    eventCount: state.eventCount,
    sessionCount: state.sessionCount,
  };
}
