import '../styles/global.css';
import '../styles/inbox.css';
import '../styles/drawer.css';
import './console.css';
import type { FleetMember, GitHubStatus, SubscribedRepo } from '../../shared/protocol.js';
import { CENTRAL_MEMBER_ID } from '../../shared/protocol.js';
import { dashboardReducer, initialState } from '../store/dashboard-store.js';
import type { DashboardState, LifecyclePair } from '../store/types.js';
import type { Api } from './api.js';
import type { Auth } from './auth.js';
import { sumFleet } from './fleet-merge.js';
import type { ConsoleView, FleetStore } from './fleet-store.js';
import './shipyard-app.js';
import type { ShipyardApp } from './shipyard-app.js';

/**
 * The console with a made-up fleet, for working on how it looks:
 *
 *   npm run demo:console
 *
 * Nothing here talks to the platform. Three fleet members — one burning, one
 * held by its usage limit, one offline — work four repositories between them,
 * and a fifth repository is subscribed to and assigned to no one, so every
 * heading, every notice and both pages have something to show.
 */

const now = Date.now();
const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
const event = (type: string, data: Record<string, unknown> = {}) => ({ type, timestamp: iso(0), data });

const GITHUB: GitHubStatus = {
  connected: true,
  org: 'acme',
  app: { id: 1, slug: 'shipyard-acme', name: 'shipyard-acme', htmlUrl: 'https://github.com/apps/shipyard-acme', installUrl: 'https://github.com/apps/shipyard-acme/installations/new' },
  installation: { id: 9, account: 'acme', repositorySelection: 'selected', htmlUrl: 'https://github.com/organizations/acme/settings/installations/9' },
};

function member(id: string, name: string, repos: string[], overrides: Partial<FleetMember> = {}): FleetMember {
  return {
    id, name, status: 'active', enrolledAt: iso(-9 * 86_400_000), enrolledBy: 'operator@example.com', lastSeenAt: iso(-4_000),
    commit: '4e270b0aa1', maxConcurrency: 4, repos, notes: [], connected: true,
    host: { hostname: `${name}.local`, platform: 'darwin', arch: 'arm64', osRelease: '25.1.0', node: '22.14.0', cpus: 12, totalMemoryMb: 36_864 },
    ...overrides,
  };
}

const MEMBERS: FleetMember[] = [
  member('m_a1', 'atlas', ['acme/atlas-api', 'acme/atlas-web']),
  member('m_b2', 'borealis', ['acme/xj-music'], { maxConcurrency: 3 }),
  member('m_c3', 'cirrus', ['acme/docs'], { lastSeenAt: iso(-42 * 60_000), connected: false, maxConcurrency: 2 }),
];

const REPOS: SubscribedRepo[] = [
  ['acme/atlas-api', 'm_a1'], ['acme/atlas-web', 'm_a1'], ['acme/xj-music', 'm_b2'], ['acme/docs', 'm_c3'], ['acme/orphan', null],
].map(([repo, memberId]) => ({ repo: repo as string, memberId: memberId as string | null, subscribedAt: iso(-8 * 86_400_000), subscribedBy: 'operator@example.com', settings: {} }));

function pair(issue: number, title: string, pr: number | null, overrides: Partial<LifecyclePair> = {}, checks = 'success'): LifecyclePair {
  return {
    issue: { number: issue, title, state: 'open' },
    pr: pr === null ? null : { number: pr, title, state: 'open', draft: overrides.prPhase !== 'review', checksStatus: checks },
    prPhase: pr === null ? 'absent' : 'active',
    ...overrides,
  };
}

function pool(engines: number): DashboardState {
  let state = initialState();
  for (let i = 0; i < engines; i++) {
    state = dashboardReducer(state, event('iteration-start', { engineIndex: i, iterationNumber: 14, maxConcurrency: engines }));
    state = dashboardReducer(state, event('engine-idle', { engineIndex: i, reason: 'idle', nextCycleAtMs: now + 40_000 + i * 7_000 }));
  }
  return state;
}

function atlas(): DashboardState {
  let state = pool(4);
  state = dashboardReducer(state, event('lifecycle-update', { repo: 'acme/atlas-api', pairs: [
    pair(212, 'Rate-limit the public search endpoint per API key', 231),
    pair(214, 'Return 409 instead of 500 when an order is edited twice', 233, { prPhase: 'review', approval: 'awaiting-approval' }),
    pair(219, 'Paginate the audit log export', null),
    pair(220, 'Migrate the session store to the new schema', null, { blockedByIssueNumbers: [219] }),
    pair(223, 'Document the webhook retry policy', null),
  ] }));
  state = dashboardReducer(state, event('lifecycle-update', { repo: 'acme/atlas-web', pairs: [
    pair(88, 'Keep the filter bar in view while the table scrolls', 97),
    pair(91, 'Show the empty state when a search finds nothing', 99, {}, 'pending'),
    pair(93, 'Remember the chosen density between visits', null),
  ] }));
  state = dashboardReducer(state, event('action-start', {
    actionIndex: 1, totalActions: 1, type: 'self-review', repo: 'acme/atlas-api', issueNumber: 212, pullRequestNumber: 231,
    issueTitle: 'Rate-limit the public search endpoint per API key', model: 'claude-opus-5-5', startedAt: now - 11 * 60_000,
  }));
  state = dashboardReducer(state, event('action-start', {
    actionIndex: 2, totalActions: 1, type: 'start-implementation', repo: 'acme/atlas-web', issueNumber: 88,
    issueTitle: 'Keep the filter bar in view while the table scrolls', model: 'claude-fable-5-2', startedAt: now - 47 * 60_000,
  }));
  state = dashboardReducer(state, event('usage-update', { status: 'ok', window: 'five_hour', usedPercent: 38, resetsAtMs: now + 2.4 * 3_600_000, fetchedAtMs: now }));
  return state;
}

function borealis(): DashboardState {
  let state = pool(3);
  state = dashboardReducer(state, event('lifecycle-update', { repo: 'acme/xj-music', pairs: [
    pair(402, 'Crossfade between segments at the bar line, not the beat', 415, {}, 'failure'),
    pair(404, 'Cache decoded audio between plays of the same program', null),
    pair(407, 'Export a mixdown as FLAC', null),
  ] }));
  state = dashboardReducer(state, event('work-hold', { kind: 'claude-usage-limit', reason: 'Claude usage limit', untilMs: now + 96 * 60_000 }));
  state = dashboardReducer(state, event('usage-update', { status: 'ok', window: 'seven_day', usedPercent: 100, resetsAtMs: now + 96 * 60_000, fetchedAtMs: now }));
  return state;
}

function cirrus(): DashboardState {
  let state = pool(2);
  state = dashboardReducer(state, event('lifecycle-update', { repo: 'acme/docs', pairs: [
    pair(31, 'Explain how fleet members are enrolled', 36, { prPhase: 'review' }),
    pair(33, 'Add a page on assigning repositories', null),
  ] }));
  return state;
}

function central(): DashboardState {
  return dashboardReducer(initialState(), event('lifecycle-update', { repo: 'acme/orphan', unassigned: true, pairs: [
    pair(5, 'Pick a license', null),
    pair(6, 'Set up continuous integration', null),
  ] }));
}

const states = new Map<string, DashboardState>([
  ['m_a1', atlas()], ['m_b2', borealis()], ['m_c3', cirrus()], [CENTRAL_MEMBER_ID, central()],
]);

const view: ConsoleView = {
  loaded: true, error: null, connection: 'connected', release: '4e270b0aa1b2c3d4e5f60718293a4b5c6d7e8f90',
  operatorEmail: 'operator@example.com', members: MEMBERS, repos: REPOS, github: GITHUB, clockSkewMs: 0,
};

const sum = (): DashboardState => sumFleet({ fleet: view, states, connection: 'connected', nowMs: Date.now() });
const listeners = new Set<(state: DashboardState) => void>();
setInterval(() => { const state = sum(); for (const listener of listeners) listener(state); }, 1000);

/** As much of the console's store as the console reads, standing still. */
const store = {
  view,
  getState: sum,
  subscribe(listener: (state: DashboardState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  subscribeView() { return () => undefined; },
  approvePullRequest() { return true; },
  now: () => Date.now(),
  refresh: async () => undefined,
} as unknown as FleetStore;

const available = ['acme/atlas-api', 'acme/atlas-web', 'acme/xj-music', 'acme/docs', 'acme/orphan', 'acme/playground', 'acme/infra'].map((repo) => ({
  repo, private: repo !== 'acme/docs', archived: false, description: repo === 'acme/playground' ? 'Scratch space' : null,
  defaultBranch: 'main', htmlUrl: `https://github.com/${repo}`,
}));

/**
 * GitHub takes its time over the list, and the page has that to show.
 * `?listing=20000` has it take that many millis, to look at the page while it
 * reads; `?fail` has the reading fail.
 */
const query = new URLSearchParams(location.search);
const LISTING_MS = Number(query.get('listing')) || 2600;
const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

const api = {
  get: async (path: string) => {
    if (path !== '/github/repositories') return { ok: true };
    await wait(LISTING_MS);
    if (query.has('fail')) throw new Error('GitHub would not list the installation\'s repositories (502)');
    return { ok: true, available };
  },
  post: async (path: string) => (path === '/fleet/enroll-codes'
    ? { ok: true, code: 'enr_0123456789abcdef0123456789abcdef', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }
    : { ok: true }),
  put: async () => ({ ok: true }),
  patch: async () => ({ ok: true }),
  delete: async () => ({ ok: true }),
} as unknown as Api;

const app = document.createElement('shipyard-app') as ShipyardApp;
app.store = store;
app.api = api;
app.auth = { signOut: async () => undefined } as unknown as Auth;
document.getElementById('app')?.replaceChildren(app);
