import type { FleetView } from '../../shared/notices.js';
import {
  CENTRAL_MEMBER_ID,
  type ConsolePush,
  type ConsoleSend,
  type ConsoleState,
  type EngineDefaults,
  type FleetMember,
  type GitHubStatus,
  type SubscribedRepo,
} from '../../shared/protocol.js';
import type { WireEvent } from '../../shared/replay-cache.js';
import type { DashboardSource } from '../components/shipyard-dashboard.js';
import { approveKey, type ApproveTarget } from '../shared/pill-approval.js';
import {
  dashboardReducer,
  initCylinders,
  initialState,
  markApprovalPressesSent,
  recordApprovalPress,
  replayState,
  unansweredApprovalPresses,
} from '../store/dashboard-store.js';
import type { ApprovalPress, DashboardState } from '../store/types.js';
import type { Api } from './api.js';
import type { Auth } from './auth.js';
import { sumFleet } from './fleet-merge.js';

/**
 * The console's store: the fleet, and Shipyard's dashboard as the sum of it.
 *
 * It keeps one dashboard state per fleet member — the very state that
 * member's own screen keeps, fed the same events through the same reducer —
 * and adds them up (fleet-merge.ts) for the field and the inbox to draw.
 *
 * It is brought up to date the way a pool's own dashboard is: a read of
 * everything replayable (`GET /api/state`), then every event as it happens,
 * down the socket. The socket is opened first and what arrives is held until
 * the read has been applied, so nothing that happens in between is missed.
 * When the socket drops it is opened again with a fresh token, and the read
 * is made again.
 */

/** What the pages of the console are drawn from, beside the dashboard itself. */
export interface ConsoleView {
  /** False until the first read has come back. */
  loaded: boolean;
  /** Why the last read failed, when it did. */
  error: string | null;
  connection: DashboardState['connection'];
  release: string | null;
  operatorEmail: string | null;
  members: FleetMember[];
  repos: SubscribedRepo[];
  github: GitHubStatus;
  /** Platform-wide engine defaults, editable from the console. */
  engineDefaults: EngineDefaults;
  /** How far this browser's clock is ahead of the platform's, in millis:
   *  "offline" is judged by the platform's clock, whatever this machine's says. */
  clockSkewMs: number;
}

const NO_GITHUB: GitHubStatus = { connected: false, org: null, app: null, installation: null };

/** API Gateway closes a socket that has said nothing for ten minutes. */
const PING_EVERY_MS = 4 * 60_000;
const RECONNECT_AFTER_MS = 3_000;
/** Several "the fleet changed" in a row are one read. */
const REFRESH_DEBOUNCE_MS = 250;

type Listener<T> = (value: T) => void;

export class FleetStore implements DashboardSource {
  private _view: ConsoleView = {
    loaded: false, error: null, connection: 'connecting', release: null, operatorEmail: null,
    members: [], repos: [], github: NO_GITHUB, engineDefaults: {}, clockSkewMs: 0,
  };
  private _states = new Map<string, DashboardState>();
  private _sum: DashboardState = { ...initialState(), fleet: [], brand: 'Shipyard', title: 'Shipyard', multiProject: true };
  private readonly _sumListeners = new Set<Listener<DashboardState>>();
  private readonly _viewListeners = new Set<Listener<ConsoleView>>();

  private _socket: WebSocket | null = null;
  private _closed = false;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Events that arrived while a read was under way, to apply once it is in. */
  private _held: ConsolePush[] | null = null;
  private _reading: Promise<void> | null = null;

  constructor(
    private readonly api: Api,
    private readonly auth: Auth,
    private readonly wsUrl: string,
  ) {}

  // ── What the dashboard and the pages read ──────────────────────────────────

  getState(): DashboardState { return this._sum; }

  subscribe(listener: Listener<DashboardState>): () => void {
    this._sumListeners.add(listener);
    return () => { this._sumListeners.delete(listener); };
  }

  get view(): ConsoleView { return this._view; }

  subscribeView(listener: Listener<ConsoleView>): () => void {
    this._viewListeners.add(listener);
    return () => { this._viewListeners.delete(listener); };
  }

  /** The platform's clock, as near as this browser can tell. */
  now(): number { return Date.now() - this._view.clockSkewMs; }

  // ── Starting and stopping ──────────────────────────────────────────────────

  start(): void {
    this._closed = false;
    this._connect();
    // The clocks on the field run on this: a state is new only when something
    // changed, and "offline" is a matter of time passing.
    this._tickTimer = setInterval(() => this._resum(), 1000);
  }

  stop(): void {
    this._closed = true;
    if (this._reconnectTimer !== null) clearTimeout(this._reconnectTimer);
    if (this._pingTimer !== null) clearInterval(this._pingTimer);
    if (this._tickTimer !== null) clearInterval(this._tickTimer);
    if (this._refreshTimer !== null) clearTimeout(this._refreshTimer);
    this._reconnectTimer = this._pingTimer = this._tickTimer = this._refreshTimer = null;
    this._socket?.close();
    this._socket = null;
  }

  /** Read the fleet again, now: after the operator changed something. */
  refresh(): Promise<void> {
    return this._read();
  }

  // ── The socket ─────────────────────────────────────────────────────────────

  private _setConnection(connection: DashboardState['connection']): void {
    if (this._view.connection === connection) return;
    this._setView({ ...this._view, connection });
    this._resum();
  }

  private async _connect(): Promise<void> {
    if (this._closed) return;
    let token: string | null = null;
    try { token = await this.auth.idToken(); } catch { /* Cognito out of reach: tried again below */ }
    if (this._closed) return;
    if (!token) {
      this._scheduleReconnect();
      return;
    }
    const socket = new WebSocket(`${this.wsUrl}?${new URLSearchParams({ token }).toString()}`);
    this._socket = socket;
    // A handshake that hangs fires nothing at all: give up on it and try again.
    const connectTimeout = setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) socket.close(); }, 10_000);

    socket.addEventListener('open', () => {
      clearTimeout(connectTimeout);
      this._setConnection('connected');
      this._pingTimer = setInterval(() => this._send({ t: 'ping' }), PING_EVERY_MS);
      // What arrives from here on is held until the read is in.
      void this._read().then(() => this._resendUnansweredPresses());
    });
    socket.addEventListener('message', (event) => {
      let push: ConsolePush;
      try { push = JSON.parse(String(event.data)) as ConsolePush; } catch { return; }
      this._onPush(push);
    });
    socket.addEventListener('close', () => {
      clearTimeout(connectTimeout);
      if (this._pingTimer !== null) clearInterval(this._pingTimer);
      this._pingTimer = null;
      if (this._socket === socket) this._socket = null;
      this._setConnection('disconnected');
      this._scheduleReconnect();
    });
    socket.addEventListener('error', () => { /* a close follows, and is what is acted on */ });
  }

  private _scheduleReconnect(): void {
    if (this._closed || this._reconnectTimer !== null) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      void this._connect();
    }, RECONNECT_AFTER_MS);
  }

  private _send(message: ConsoleSend): boolean {
    const socket = this._socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private _onPush(push: ConsolePush): void {
    if (this._held !== null && (push.t === 'events' || push.t === 'member-reset' || push.t === 'seen')) {
      this._held.push(push);
      return;
    }
    switch (push.t) {
      case 'events':
        this._apply(push.member, push.events);
        this._resum();
        return;
      case 'seen':
        this._seen(push.member, push.at);
        return;
      case 'member-reset':
        this._resetProcess(push.member);
        this._resum();
        return;
      case 'changed':
      case 'resync':
        this._refreshSoon();
        return;
      case 'pong':
        return;
    }
  }

  /**
   * The platform heard from a member. "Offline" is worked out here, from when
   * each member was last heard from and the clock, and the fleet is read again
   * only when something about it changes — which a member at work does not.
   * So this is what keeps a member that is there from being called offline
   * for the console's not having asked: its copy of when is brought forward,
   * and never back, by what arrives out of order.
   */
  private _seen(memberId: string, at: string): void {
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) return;
    let moved = false;
    const members = this._view.members.map((member) => {
      if (member.id !== memberId) return member;
      const hadMs = member.lastSeenAt === null ? NaN : Date.parse(member.lastSeenAt);
      if (hadMs >= atMs) return member;
      moved = true;
      return { ...member, lastSeenAt: at };
    });
    if (!moved) return;
    this._setView({ ...this._view, members });
    this._resum();
  }

  private _refreshSoon(): void {
    if (this._refreshTimer !== null) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      void this._read();
    }, REFRESH_DEBOUNCE_MS);
  }

  // ── Reading everything ─────────────────────────────────────────────────────

  private _read(): Promise<void> {
    this._reading ??= this._readOnce().finally(() => { this._reading = null; });
    return this._reading;
  }

  private async _readOnce(): Promise<void> {
    const first = !this._view.loaded;
    this._held ??= [];
    try {
      const state = await this.api.get<ConsoleState & { ok: true }>('/state');
      const previous = this._states;
      const next = new Map<string, DashboardState>();
      const ids = [...state.members.map((member) => member.id), CENTRAL_MEMBER_ID];
      for (const id of ids) {
        const member = state.members.find((candidate) => candidate.id === id);
        next.set(id, replayState(previous.get(id) ?? initialState(), state.cached[id] ?? [], (fresh) => {
          // The size of a member's pool before any of its engines has said so.
          const size = member?.maxConcurrency ?? 0;
          fresh.maxConcurrency = size;
          fresh.cylinders = initCylinders(size);
        }));
      }
      this._states = next;
      this._setView({
        ...this._view,
        loaded: true,
        error: null,
        release: state.release,
        operatorEmail: state.operator.email,
        members: state.members,
        repos: state.repos,
        github: state.github,
        engineDefaults: state.engineDefaults ?? {},
        clockSkewMs: Date.now() - state.serverTimeMs,
      });
    } catch (error) {
      this._setView({ ...this._view, error: error instanceof Error ? error.message : String(error) });
    } finally {
      const held = this._held ?? [];
      this._held = null;
      for (const push of held) this._onPush(push);
      this._resum();
    }
    // The repositories nobody is assigned are read by the platform itself, and
    // only while a console is open: ask for a fresh reading on arriving.
    if (first && this._view.loaded && this._view.repos.some((repo) => repo.memberId === null)) {
      void this.api.post('/central/refresh').catch(() => undefined);
    }
  }

  // ── Each member's own state ────────────────────────────────────────────────

  private _stateOf(memberId: string): DashboardState {
    let state = this._states.get(memberId);
    if (!state) {
      state = initialState();
      const size = this._view.members.find((member) => member.id === memberId)?.maxConcurrency ?? 0;
      state.maxConcurrency = size;
      state.cylinders = initCylinders(size);
      this._states.set(memberId, state);
    }
    return state;
  }

  private _apply(memberId: string, events: readonly WireEvent[]): void {
    let state = this._stateOf(memberId);
    for (const event of events) state = dashboardReducer(state, event);
    // A pool's own dashboard shows its feed one item at a time, three seconds
    // each. With a fleet's worth arriving that queue would only grow: here an
    // item is in the feed as soon as it is heard.
    if (state.broadcastQueue.length > 0) {
      state = {
        ...state,
        broadcastVisible: [...[...state.broadcastQueue].reverse(), ...state.broadcastVisible].slice(0, 15),
        broadcastQueue: [],
      };
    }
    this._states.set(memberId, state);
  }

  /**
   * A member started again: what its last process was doing is gone with it.
   * Its work is as it was, and so are the last readings of its account's usage
   * and of its machine, the operator's own presses, and the failures heard of.
   */
  private _resetProcess(memberId: string): void {
    const was = this._states.get(memberId);
    if (!was) return;
    const fresh = initialState();
    const size = this._view.members.find((member) => member.id === memberId)?.maxConcurrency ?? was.cylinders.length;
    this._states.set(memberId, {
      ...fresh,
      maxConcurrency: size,
      cylinders: initCylinders(size),
      lifecycleByRepo: was.lifecycleByRepo,
      lastLifecyclePairs: was.lastLifecyclePairs,
      sessionCountByRepo: was.sessionCountByRepo,
      sessionCount: was.sessionCount,
      usage: was.usage,
      system: was.system,
      approvalPresses: was.approvalPresses,
      failures: was.failures,
      eventStream: was.eventStream,
      eventCount: was.eventCount,
      broadcastVisible: was.broadcastVisible,
    });
  }

  // ── Decisions ──────────────────────────────────────────────────────────────

  /** The member a repository's decisions go to, or the platform's own when it is no one's. */
  private _ownerOf(repo: string): string {
    return this._view.repos.find((candidate) => candidate.repo === repo)?.memberId ?? CENTRAL_MEMBER_ID;
  }

  /**
   * Ask for a review-gated PR to be approved and merged, and record the press
   * so its card follows it at once. The press is kept with the member the
   * repository is assigned to, as that member's own dashboard would keep it,
   * so everything that follows a press — Queued, Approving, Merged, and being
   * sent again if it was never answered — works as it does there.
   */
  approvePullRequest(target: ApproveTarget): boolean {
    const sent = this._send({ t: 'approve', repo: target.repo, pullRequestNumber: target.pullRequestNumber });
    const owner = this._ownerOf(target.repo);
    this._states.set(owner, recordApprovalPress(this._stateOf(owner), target, sent, Date.now()));
    this._resum();
    return sent;
  }

  /** Send each press nobody has answered, now the connection is back. */
  private _resendUnansweredPresses(): void {
    for (const [memberId, state] of this._states) {
      const sent: ApprovalPress[] = unansweredApprovalPresses(state)
        .filter((press) => this._send({ t: 'approve', repo: press.repo, pullRequestNumber: press.pullRequestNumber }));
      if (sent.length > 0) this._states.set(memberId, markApprovalPressesSent(state, sent, Date.now()));
    }
    this._resum();
  }

  /** Whether this console has a press outstanding for a PR (the card's key). */
  hasPress(target: ApproveTarget): boolean {
    return this._sum.approvalPresses.has(approveKey(target));
  }

  // ── The sum ────────────────────────────────────────────────────────────────

  private _fleet(): FleetView {
    return { members: this._view.members, repos: this._view.repos, github: this._view.github };
  }

  private _resum(): void {
    this._sum = sumFleet({ fleet: this._fleet(), states: this._states, connection: this._view.connection, nowMs: this.now() });
    for (const listener of this._sumListeners) listener(this._sum);
  }

  private _setView(view: ConsoleView): void {
    this._view = view;
    for (const listener of this._viewListeners) listener(view);
  }
}
