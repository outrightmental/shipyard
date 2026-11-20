import type { DashboardState, FleetCrew } from '../store/types.js';
import type { BurnLevel } from '../shared/burn-level.js';
import { engineViews, type EngineView } from '../shared/engine-view.js';
import { formatClockTime, formatDuration, formatLogTime } from '../shared/format.js';
import type { InboxCard, Selection } from '../shared/inbox.js';
import { systemView, type SystemView } from '../shared/system-view.js';
import { usageGaugeView, usageLimitUntilMs, type UsageGaugeView } from '../shared/usage-gauge.js';
import { liveHold, shutdownNote, vitals, type Vitals } from '../shared/vitals.js';
import { compareProjectWork, workViews, type WorkView } from '../shared/work-view.js';

/**
 * What the field draws, worked out from the dashboard's state and the clock.
 *
 * The field is a thermal picture of the run. What an engine is burning on
 * (`BurnLevel`, #281) is at the top with the most room: a reactor each.
 * Everything else is below, grouped by the project it belongs to (#290), and
 * within each project hottest first — what yoke works next drawn whole, then
 * what waits on someone else and what nothing is coming for, dimmed. Nothing
 * has a box of fixed size to be fitted into — a piece of work takes the room
 * its state has earned, and gives it up when the state changes.
 */
export interface FieldModel {
  vitals: Vitals;
  /** Every engine running an action, with the work it is on. */
  reactors: Reactor[];
  /** The engines that are not: idle, parked by a limit, finished, shut down. */
  bench: EngineView[];
  /**
   * On Shipyard's dashboard, the fleet's members, in the order they joined:
   * the burning section is then a group for each, headed by the member's name
   * and its Claude account's usage, with that member's reactors and bench
   * under it. Every reactor and every engine on the bench is in exactly one.
   * Null on a pool's own dashboard, where the engines are one pool under one
   * heading.
   */
  crews: Crew[] | null;
  /** What the field says where the work would be, when there is none: before
   *  the first of it has arrived, and once it has and there is nothing open. */
  notes: { loading: string; empty: string };
  /** The work no engine is on, a group for each project, in the order of their
   *  names; a project with none left out. */
  strata: Stratum[];
  /** Every piece of work, wherever it is drawn. */
  works: WorkView[];
  /** The last few lines of the event log, oldest first. */
  ribbon: RibbonLine[];
  /** The lines from work on the field to the inbox cards about it. */
  tethers: Tether[];
  selection: Selection | null;
  /** True when work is labelled with its project, because several share the dashboard. */
  multiProject: boolean;
  /** Yoke is shutting down: every piece of work has gone dark (#268). */
  dark: boolean;
  /** Whether a first lifecycle has arrived yet; until then there is nothing to say. */
  loaded: boolean;
}

/** An engine running an action, and the work it is running it on. */
export interface Reactor {
  engine: EngineView;
  /** Null only for an action that names no issue and no PR. */
  work: WorkView | null;
}

/**
 * One fleet member's group in the burning section: what a pool's own
 * dashboard says once, along its top, said for this member alone.
 */
export interface Crew {
  id: string;
  name: string;
  /** Its engines running an action, with the work each is on. */
  reactors: Reactor[];
  /** Its engines that are not. */
  bench: EngineView[];
  /** How many engines it has on the field, and how many of them are burning. */
  engines: number;
  burning: number;
  /** Its Claude account's usage window nearest its limit. */
  usage: UsageGaugeView;
  /** The machine it runs on, as last measured: a gauge for each thing measured.
   *  Null before the first reading, and for a member that is not there — what
   *  its machine was doing when last heard from is not what it is doing. */
  system: SystemView | null;
  /** What its heading says of it after the gauge, and how: `plain` is how it
   *  is doing; `held`, something is holding it up that will pass by itself or
   *  wants assigning; `down`, it is not there, or something is wrong with it. */
  note: { text: string; tone: 'plain' | 'held' | 'down' };
  /** The repositories assigned to it. */
  repos: string[];
  online: boolean;
}

/** A level a piece of work can be drawn at below the reactors. */
export type StratumLevel = Exclude<BurnLevel, 'burning'>;

/** The levels below the reactors, hottest first. */
export const STRATUM_LEVELS: readonly StratumLevel[] = ['queued', 'waiting', 'cold'];

/**
 * One project's work that no engine is on (#290). Its level is no longer
 * where it is drawn but how: each piece keeps its own (`stratumLevel`), and
 * says it in its weight.
 */
export interface Stratum {
  /** The project, "owner/repo"; empty only when neither its work nor the
   *  dashboard named one. */
  repo: string;
  /** Queued first, then waiting, then cold; within each, `compareWork`'s order. */
  works: WorkView[];
}

/**
 * The level a piece of work is drawn at below the reactors: its own. Work
 * that is `burning` with no engine cannot happen while yoke runs, and is
 * drawn as queued if it ever does rather than dropped.
 */
export function stratumLevel(work: WorkView): StratumLevel {
  return work.level === 'burning' ? 'queued' : work.level;
}

/** How many of a project's pieces of work are at each level, hottest first;
 *  a level with none left out. */
export function levelCounts(works: readonly WorkView[]): Array<{ level: StratumLevel; count: number }> {
  return STRATUM_LEVELS
    .map((level) => ({ level, count: works.filter((work) => stratumLevel(work) === level).length }))
    .filter((entry) => entry.count > 0);
}

export interface RibbonLine {
  /** "18:45:07", in the viewer's time zone (#272). */
  time: string;
  /** The project the line came from, when it names one. */
  repo: string;
  text: string;
  /** The color of the engine's work, when an engine said it. */
  color: string | null;
  /** "info", "success", "warning", "error". */
  level: string;
}

/**
 * What the line between a piece of work and its inbox card is saying:
 * `waiting` on a person; `sent`, an approval on its way to yoke; `working`, an
 * engine carrying it out; `done`; a `problem`; or `selected`, the work a
 * person picked out to read about.
 */
export type TetherState = 'waiting' | 'sent' | 'working' | 'done' | 'problem' | 'selected';

export interface Tether {
  cardId: string;
  workKey: string;
  state: TetherState;
}

/** The id of the inspector card: the one card that is about whatever is selected. */
export const INSPECTOR_CARD_ID = 'inspect';

/** How many lines of the log the ribbon can ever show. */
export const RIBBON_MAX_LINES = 4;

function tetherState(card: InboxCard): TetherState {
  if (card.source === 'failure') return 'problem';
  if (card.action?.type !== 'approve') return 'waiting';
  switch (card.action.step) {
    case 'queued': return 'sent';
    case 'approving': return 'working';
    case 'merged': return 'done';
    case 'retry': return 'problem';
    default: return 'waiting';
  }
}

/**
 * The label a project goes by on the field. When every project has the same
 * owner — the usual case — the owner says nothing and is dropped, which is
 * most of the width of the name.
 */
export function repoLabels(repos: Iterable<string>): Map<string, string> {
  const all = [...new Set(repos)].filter((repo) => repo !== '');
  const owners = new Set(all.map((repo) => repo.split('/')[0]));
  const labels = new Map<string, string>();
  for (const repo of all) {
    labels.set(repo, owners.size <= 1 ? repo.slice(repo.indexOf('/') + 1) || repo : repo);
  }
  return labels;
}

/** The label every project named on the field goes by: those of its work, its
 *  groups and the log's lines, worked out together so that they agree. */
export function fieldRepoLabels(model: Pick<FieldModel, 'works' | 'strata' | 'ribbon'>): Map<string, string> {
  return repoLabels([
    ...model.works.map((work) => work.repo),
    ...model.strata.map((stratum) => stratum.repo),
    ...model.ribbon.map((line) => line.repo),
  ]);
}

/** The order the projects' groups are set in: by name, which nothing that
 *  happens to their work can change. One with no name goes last. */
function compareRepos(a: string, b: string): number {
  if (a === '' || b === '') return a === b ? 0 : a === '' ? 1 : -1;
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What a member's heading says of it, most pressing first. */
function crewNote(crew: FleetCrew, burning: number, engines: number, nowMs: number): Crew['note'] {
  if (!crew.online) {
    const ago = crew.lastSeenAtMs === null ? '' : ` · last heard from ${formatDuration(Math.max(0, nowMs - crew.lastSeenAtMs))} ago`;
    return { text: crew.lastSeenAtMs === null ? 'has not connected yet' : `offline${ago}`, tone: 'down' };
  }
  if (crew.problem) return { text: crew.problem, tone: 'down' };
  if (crew.stopped) return { text: 'stopped — its service starts it again', tone: 'held' };
  if (crew.stopping) return { text: shutdownNote(crew.stoppingReason), tone: 'held' };
  const hold = liveHold(crew.hold, nowMs);
  if (hold) {
    return {
      text: `waiting ${formatDuration(hold.untilMs - nowMs)} until ${formatClockTime(hold.untilMs)} for ${hold.reason}`,
      tone: 'held',
    };
  }
  if (crew.repos.length === 0) return { text: 'assigned no repositories', tone: 'held' };
  if (engines === 0) return { text: 'starting its engines', tone: 'plain' };
  if (burning === 0) return { text: 'no engine is running an action', tone: 'plain' };
  return { text: burning === 1 ? 'an engine is running an action' : 'engines are running actions', tone: 'plain' };
}

export function fieldModel(
  state: DashboardState,
  nowMs: number,
  ui: { cards?: readonly InboxCard[]; selection?: Selection | null; works?: WorkView[] } = {},
): FieldModel {
  const works = ui.works ?? workViews(state, nowMs);
  const engines = engineViews(state, nowMs);
  const dark = state.shutdownRequested || state.appShutdown;

  const reactors: Reactor[] = [];
  const bench: EngineView[] = [];
  const onReactor = new Set<string>();
  for (const engine of engines) {
    if (engine.status !== 'active') {
      bench.push(engine);
      continue;
    }
    // Two engines never hold the same work, but if the events ever said so,
    // the second still gets its reactor: an engine burning is never hidden.
    const work = works.find((candidate) =>
      candidate.engine !== null && candidate.engine.index === engine.index + 1 && !onReactor.has(candidate.key)) ?? null;
    if (work) onReactor.add(work.key);
    reactors.push({ engine, work });
  }

  // Below the reactors, a group for every project with work no engine is on
  // (#290) — a single project's included, so the field reads the same however
  // many share it. Work that names no project is the dashboard's own.
  const ownRepo = state.owner && state.repo ? `${state.owner}/${state.repo}` : '';
  const byRepo = new Map<string, WorkView[]>();
  for (const work of works) {
    if (onReactor.has(work.key)) continue;
    const repo = work.repo || ownRepo;
    const group = byRepo.get(repo);
    if (group) group.push(work);
    else byRepo.set(repo, [work]);
  }
  const strata: Stratum[] = [...byRepo]
    .sort(([a], [b]) => compareRepos(a, b))
    .map(([repo, group]) => ({ repo, works: group.sort(compareProjectWork) }));

  // On Shipyard's dashboard every engine is some member's, and is drawn in
  // that member's group. An engine of a member the fleet no longer lists has
  // nowhere to be drawn, and is not.
  const crews: Crew[] | null = state.fleet === null ? null : state.fleet.map((crew) => {
    const mine = reactors.filter((reactor) => reactor.engine.memberId === crew.id);
    const idle = bench.filter((engine) => engine.memberId === crew.id);
    const count = mine.length + idle.length;
    return {
      id: crew.id,
      name: crew.name,
      reactors: mine,
      bench: idle,
      engines: count,
      burning: mine.length,
      usage: usageGaugeView(crew.usage, nowMs, usageLimitUntilMs(liveHold(crew.hold, nowMs))),
      system: crew.online && crew.system ? systemView(crew.system) : null,
      note: crewNote(crew, mine.length, count, nowMs),
      repos: crew.repos,
      online: crew.online,
    };
  });

  const tethers: Tether[] = [];
  const known = new Set(works.map((work) => work.key));
  for (const card of ui.cards ?? []) {
    if (card.workKey !== null && known.has(card.workKey)) {
      tethers.push({ cardId: card.id, workKey: card.workKey, state: tetherState(card) });
    }
  }
  const selection = ui.selection ?? null;
  if (selection?.kind === 'work' && known.has(selection.key) && !tethers.some((t) => t.workKey === selection.key)) {
    tethers.push({ cardId: INSPECTOR_CARD_ID, workKey: selection.key, state: 'selected' });
  }

  return {
    vitals: vitals(state, nowMs),
    reactors,
    bench,
    crews,
    notes: state.fleet === null
      ? { loading: 'Connecting to yoke…', empty: 'No open issues or pull requests.' }
      : { loading: 'Reading the fleet…', empty: 'No open issues or pull requests in the repositories Shipyard is subscribed to.' },
    strata,
    works,
    ribbon: state.eventStream.slice(-RIBBON_MAX_LINES).map((line) => ({
      time: formatLogTime(line.atMs),
      repo: state.multiProject ? line.repo ?? '' : '',
      text: line.text,
      color: line.color,
      level: line.level,
    })),
    tethers,
    selection,
    multiProject: state.multiProject,
    dark,
    loaded: state.lifecycleByRepo.size > 0 || works.length > 0 || state.fleet !== null,
  };
}
