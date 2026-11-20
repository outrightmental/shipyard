import { fleetNotices, noticeId, type FleetNotice, type FleetView } from '../../shared/notices.js';
import { CENTRAL_MEMBER_ID, memberOnline, type FleetMember } from '../../shared/protocol.js';
import { formatDuration } from '../shared/format.js';
import { initialState } from '../store/dashboard-store.js';
import type {
  ActionFailure,
  ApprovalPress,
  BroadcastEventData,
  CylinderState,
  DashboardState,
  EventLine,
  FleetCrew,
  FleetNoticeCard,
  IssueCard,
  LifecyclePair,
  PRCard,
  PullRequestApprovalStatus,
} from '../store/types.js';

/**
 * Shipyard's dashboard as the sum of its fleet's.
 *
 * Every fleet member reports the events its own dashboard is drawn from, and
 * the console keeps a state for each of them exactly as that member's own
 * screen does (the reducer in store/dashboard-store.ts, untouched). This is
 * the other half: those states added up into the one the field and the inbox
 * draw.
 *
 * Adding them up is mostly concatenation, because no two members ever work
 * the same repository: the engines side by side, each marked with the member
 * it belongs to; the repositories' work side by side; the approvals, the
 * failures and the log together. What a pool's own dashboard says once for
 * the whole run — the Claude account's usage, a hold parking every engine,
 * that it is shutting down — is no longer one thing, so it is left off the
 * top of the sum and carried per member (`DashboardState.fleet`), for that
 * member's heading in the burning section to say.
 */
export interface FleetSum {
  /** The fleet as the platform last described it. */
  fleet: FleetView;
  /** Each member's own state, by member id; the platform's own reading of the
   *  repositories no member is assigned is under `central`. */
  states: ReadonlyMap<string, DashboardState>;
  /** The console's connection to the platform. */
  connection: DashboardState['connection'];
  nowMs: number;
}

const BROADCAST_MAX = 15;
const STREAM_MAX = 300;

/** What a member has said is wrong with itself, in a line. */
function problemOf(member: FleetMember): string | null {
  const note = member.notes[0];
  return note ? note.message : null;
}

/** "acme" when every repository is acme's; empty when they are not all one owner's. */
function commonOwner(repos: Iterable<string>): string {
  const owners = new Set([...repos].map((repo) => repo.split('/')[0] ?? ''));
  return owners.size === 1 ? [...owners][0]! : '';
}

export function sumFleet(input: FleetSum): DashboardState {
  const { fleet, states, nowMs } = input;
  const members = fleet.members.filter((member) => member.status === 'active');
  const sum = initialState();

  const cylinders: CylinderState[] = [];
  const crews: FleetCrew[] = [];
  const issueCards = new Map<number, IssueCard>();
  const prCards = new Map<number, PRCard>();
  const lifecycle = new Map<string, LifecyclePair[]>();
  const sessionCountByRepo = new Map<string, number>();
  const approvals = new Map<string, PullRequestApprovalStatus>();
  const approvalPresses = new Map<string, ApprovalPress>();
  const failures = new Map<string, ActionFailure>();
  const stream: EventLine[] = [];
  const feed: BroadcastEventData[] = [];
  let eventCount = 0;
  let disk: DashboardState['disk'] = null;

  /** The parts of a member's state that add up the same whoever the member is. */
  const take = (state: DashboardState, offset: number, mine: (repo: string) => boolean): void => {
    for (const [number, card] of state.issueCards) issueCards.set(number, card);
    for (const [number, card] of state.prCards) prCards.set(number, card);
    for (const [repo, pairs] of state.lifecycleByRepo) {
      if (mine(repo)) lifecycle.set(repo, pairs);
    }
    for (const [repo, count] of state.sessionCountByRepo) {
      if (mine(repo)) sessionCountByRepo.set(repo, count);
    }
    for (const [key, status] of state.approvals) approvals.set(key, status);
    for (const [key, press] of state.approvalPresses) approvalPresses.set(key, press);
    // (A failure keeps its engine's number in its own pool, which is the number on that engine's ring.)
    for (const [key, failure] of state.failures) failures.set(key, failure);
    for (const line of state.eventStream) {
      stream.push(line.cylinderIdx >= 0 ? { ...line, cylinderIdx: line.cylinderIdx + offset } : line);
    }
    feed.push(...state.broadcastVisible);
    eventCount += state.eventCount;
  };

  for (const member of members) {
    const state = states.get(member.id);
    const online = memberOnline(member, nowMs);
    const lastSeenAtMs = member.lastSeenAt ? Date.parse(member.lastSeenAt) : null;
    crews.push({
      id: member.id,
      name: member.name,
      online,
      lastSeenAtMs: lastSeenAtMs !== null && Number.isFinite(lastSeenAtMs) ? lastSeenAtMs : null,
      usage: state?.usage ?? null,
      system: state?.system ?? null,
      hold: state?.hold ?? null,
      stopping: state?.shutdownRequested ?? false,
      stoppingReason: state?.shutdownReason ?? null,
      stopped: state?.appShutdown ?? false,
      repos: member.repos,
      problem: problemOf(member),
    });
    if (!state) continue;

    const offset = cylinders.length;
    // What a member that is not there was doing when last heard from is not
    // what it is doing: its engines are left off the field until it is back.
    if (online) {
      state.cylinders.forEach((cylinder, i) => {
        cylinders.push({ ...cylinder, index: offset + i + 1, memberId: member.id, memberIndex: i + 1 });
      });
    }
    const assigned = new Set(member.repos);
    // A member speaks for the repositories assigned to it, and no others.
    take(state, offset, (repo) => assigned.has(repo));
    if (state.disk?.low && disk === null) disk = state.disk;
  }

  // The platform's own reading of the repositories that are no member's.
  const central = states.get(CENTRAL_MEMBER_ID);
  if (central) take(central, cylinders.length, (repo) => !lifecycle.has(repo));

  // The repositories in the order of their names, as the field lists them, so
  // the sum never depends on which member happened to report first.
  const lifecycleByRepo = new Map([...lifecycle].sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  const lastLifecyclePairs: LifecyclePair[] = [];
  for (const pairs of lifecycleByRepo.values()) lastLifecyclePairs.push(...pairs);
  let sessionCount = 0;
  for (const count of sessionCountByRepo.values()) sessionCount += count;

  const subscribed = fleet.repos.map((repo) => repo.repo);
  const org = fleet.github.org ?? commonOwner(subscribed.length > 0 ? subscribed : lifecycleByRepo.keys());

  return {
    ...sum,
    connection: input.connection,
    maxConcurrency: cylinders.length,
    cylinders,
    issueCards,
    prCards,
    lifecycleByRepo,
    lastLifecyclePairs,
    sessionCountByRepo,
    sessionCount,
    broadcastVisible: feed.sort((a, b) => b.atMs - a.atMs).slice(0, BROADCAST_MAX),
    eventStream: stream.sort((a, b) => a.atMs - b.atMs).slice(-STREAM_MAX),
    eventCount,
    disk,
    approvals,
    approvalPresses,
    failures,
    // Always said: a card or a line of the log with no repository beside it
    // could be any member's.
    multiProject: true,
    owner: org,
    repo: '',
    title: org || 'Shipyard',
    brand: 'Shipyard',
    fleet: crews,
    notices: fleetNotices(fleet, nowMs).map((notice) => noticeCard(notice, nowMs)),
    readOnly: false,
  };
}

/** A fleet notice as the card the inbox draws for it. */
export function noticeCard(notice: FleetNotice, nowMs: number): FleetNoticeCard {
  const id = noticeId(notice);
  switch (notice.kind) {
    case 'github-not-connected':
      return {
        id, accent: 'warning', eyebrow: 'GitHub', title: 'Connect Shipyard to GitHub', repo: '', facts: [],
        line: 'until it is connected there are no repositories to subscribe to',
        action: { label: 'Connect GitHub', hint: 'Go to Repositories to connect Shipyard to GitHub', page: 'repositories' },
      };
    case 'github-not-installed':
      return {
        id, accent: 'warning', eyebrow: 'GitHub', title: 'Install the app on the organization', repo: '', facts: [],
        line: 'the GitHub App exists and is installed nowhere, so it can see no repository',
        action: { label: 'Install on GitHub', hint: 'Choose which repositories Shipyard can see, on GitHub', href: notice.installUrl },
      };
    case 'no-fleet':
      return {
        id, accent: 'warning', eyebrow: 'Fleet', title: 'No machine has joined the fleet', repo: '', facts: [],
        line: 'work is done by fleet members: enroll a machine to have one',
        action: { label: 'Enroll a machine', hint: 'Go to Fleet to enroll a machine', page: 'fleet' },
      };
    case 'repo-unassigned':
      return {
        id, accent: 'warning', eyebrow: 'Unassigned repository', title: notice.repo, repo: notice.repo, facts: [],
        line: 'no fleet member is assigned it, so it gets no work done',
        action: { label: 'Assign it', hint: `Go to Repositories to assign ${notice.repo} to a fleet member`, page: 'repositories' },
      };
    case 'member-unassigned':
      return {
        id, accent: 'warning', eyebrow: 'Idle fleet member', title: notice.name, repo: '', facts: [],
        line: 'it is assigned no repository, so it has nothing to work on',
        action: { label: 'Assign it work', hint: `Go to Repositories to assign a repository to ${notice.name}`, page: 'repositories' },
      };
    case 'member-offline': {
      const seen = notice.lastSeenAt ? Date.parse(notice.lastSeenAt) : NaN;
      return {
        id, accent: 'alarm', eyebrow: 'Fleet member offline', title: notice.name, repo: '',
        facts: notice.repos,
        line: Number.isFinite(seen)
          ? `last heard from ${formatDuration(Math.max(0, nowMs - seen))} ago — its repositories get no work done until it is back`
          : 'it has not connected since it was enrolled — its repositories get no work done',
        action: { label: 'See the fleet', hint: `Go to Fleet to see ${notice.name}`, page: 'fleet' },
      };
    }
    case 'member-note':
      return {
        id, accent: 'alarm', eyebrow: notice.name, title: notice.message, repo: '', facts: [],
        line: 'said by the fleet member itself — it keeps trying',
        action: { label: 'See the fleet', hint: `Go to Fleet to see ${notice.name}`, page: 'fleet' },
      };
  }
}
