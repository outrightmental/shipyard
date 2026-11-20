import { LitElement, html } from 'lit';
import { FAILURE_SHOW_MS, type DashboardState } from '../store/dashboard-store.js';
import type { Point } from '../field/geometry.js';
import { fieldModel } from '../field/model.js';
import { inboxWithLedger, inspect, InboxLedger, type Selection } from '../shared/inbox.js';
import type { KeepAwakeStatus } from '../shared/keep-awake.js';
import type { ApproveTarget } from '../shared/pill-approval.js';
import { lampReserve, railLayout } from '../shared/rail.js';
import { workViews } from '../shared/work-view.js';
import type { KeepAwakeLight } from './keep-awake-light.js';
import './activity-drawer.js';
import './keep-awake-light.js';
import './shipyard-field.js';
import './shipyard-inbox.js';

/**
 * What the dashboard needs of a store: its state, to be told when it changes,
 * and somewhere to send an Approve press. A pool's own store
 * (store/dashboard-store.ts) is one; so is Shipyard's, which is the sum of
 * every fleet member's (console/fleet-store.ts).
 */
export interface DashboardSource {
  getState(): DashboardState;
  subscribe(listener: (state: DashboardState) => void): () => void;
  approvePullRequest(target: ApproveTarget): boolean;
}

/** No card to draw a line to: the inbox is folded away. */
const NO_ANCHORS: ReadonlyMap<string, Point> = new Map();

/**
 * The dashboard: the field, with the inbox down its right-hand edge.
 *
 * Everything the run is doing is drawn on the field, one canvas the size of
 * the window. Everything a person can do about it is a card in the inbox. This
 * element is the little that joins them: it reads the store, works out what
 * both should show, and carries a press in the inbox back to Shipyard.
 */
<<<<<<<< HEAD:src/dashboard/components/shipyard-dashboard.ts
export class ShipyardDashboard extends LitElement {
========
export class ShipyardApp extends LitElement {
>>>>>>>> 2ba45e0 (Rename every remaining yoke reference to shipyard (#27)):src/dashboard/components/shipyard-app.ts
  static override properties = {
    store: { attribute: false },
    _state: { attribute: false, state: true },
    _selection: { attribute: false, state: true },
    _logOpen: { attribute: false, state: true },
    _keepAwake: { attribute: false, state: true },
    _anchors: { attribute: false, state: true },
    _pinnedOpen: { attribute: false, state: true },
    _dismissed: { attribute: false, state: true },
    _viewportWidth: { attribute: false, state: true },
  };

  store: DashboardSource | null = null;
  private _state: DashboardState | null = null;
  private _unsub: (() => void) | null = null;
  private _resizeObserver: ResizeObserver | null = null;

  /** What was tapped on the field, to say more about. */
  private _selection: Selection | null = null;
  private _logOpen = false;
  private _keepAwake: KeepAwakeStatus = 'idle';
  private _anchors: ReadonlyMap<string, Point> = new Map();
  /** On a narrow screen, whether the inbox has been opened over the field. */
  private _pinnedOpen = false;
  /** The cards a person has put away, by id. */
  private _dismissed: ReadonlySet<string> = new Set();
  private _viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  private readonly _ledger = new InboxLedger();
  private _baseTitle: string | null = null;
  private _waiting = 0;

  /**
   * The width the dashboard has, which is its own: the whole window when it
   * is the page, and what is left beside the menu inside Shipyard's console.
   */
  private readonly _onResize = () => {
    const width = Math.round(this.getBoundingClientRect().width);
    this._viewportWidth = width > 0 ? width : window.innerWidth;
  };
  private readonly _onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (this._logOpen) this._logOpen = false;
    else if (this._selection) this._selection = null;
    else if (this._pinnedOpen) this._pinnedOpen = false;
  };

  protected override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    if (this.store) {
      this._state = this.store.getState();
      // The store also ticks once a second, which is what keeps the clocks on
      // the field running: a state object is new only when an event changed it.
      this._unsub = this.store.subscribe((state) => {
        this._state = state;
        this.requestUpdate();
      });
    }
    window.addEventListener('resize', this._onResize);
    window.addEventListener('keydown', this._onKeyDown);
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._onResize);
      this._resizeObserver.observe(this);
    }
    this._onResize();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onKeyDown);
  }

  protected override updated() {
    // The tab says how much is waiting, for when the dashboard is not the tab in front.
    this._baseTitle ??= document.title;
    const title = this._waiting > 0 ? `(${this._waiting}) ${this._baseTitle}` : this._baseTitle;
    if (document.title !== title) document.title = title;
  }

  /** One press approves (#278): the store sends it and records the press, and
   *  the card follows it from there. */
  private _onApprove(event: CustomEvent<ApproveTarget>) {
    this.store?.approvePullRequest(event.detail);
  }

  private _onSelect(event: CustomEvent<Selection | null>) {
    this._selection = event.detail;
    if (event.detail !== null) this._pinnedOpen = true;
  }

  private _onCardSelect(event: CustomEvent<string>) {
    this._selection = { kind: 'work', key: event.detail };
  }

  private _onDismiss(event: CustomEvent<string>) {
    this._dismissed = new Set([...this._dismissed, event.detail]);
  }

  private _onKeepAwake() {
    this.querySelector<KeepAwakeLight>('keep-awake-light')?.resume();
  }

  /**
   * The inbox says where its cards are in the window's coordinates; the field
   * draws in its own, which are the window's only when the dashboard is the
   * whole page.
   */
  private _onAnchors(event: CustomEvent<Map<string, Point>>) {
    const box = this.getBoundingClientRect();
    if (box.left === 0 && box.top === 0) {
      this._anchors = event.detail;
      return;
    }
    const local = new Map<string, Point>();
    for (const [id, point] of event.detail) local.set(id, { x: point.x - box.left, y: point.y - box.top });
    this._anchors = local;
  }

  /** A card's button that goes to a page of the console: the console's to act on. */
  private _onNavigate(event: CustomEvent<string>) {
    this.dispatchEvent(new CustomEvent<string>('dashboard-navigate', { detail: event.detail, bubbles: true, composed: true }));
  }

  override render() {
    const s = this._state;
    if (!s) return html``;

    const nowMs = Date.now();
    const works = workViews(s, nowMs);
    const cards = inboxWithLedger({
      works,
      failures: [...s.failures.values()],
      keepAwake: this._keepAwake,
      disk: s.disk,
      notices: s.notices,
      readOnly: s.readOnly,
      dismissed: this._dismissed,
      nowMs,
      failureShowMs: FAILURE_SHOW_MS,
    }, this._ledger);
    this._waiting = cards.length;

    const selection = this._selection;
    const model = fieldModel(s, nowMs, { cards, selection, works });
    // Work that already has a card is spoken for by it: the card is picked
    // out, rather than a second one opened that says less.
    const selectedCard = selection?.kind === 'work'
      ? cards.find((card) => card.workKey === selection.key) ?? null
      : null;
    const inspection = selectedCard ? null : inspect(selection, {
      works,
      engines: [...model.reactors.map((reactor) => reactor.engine), ...model.bench],
      usageHeading: model.vitals.usage.heading,
      usageTitle: model.vitals.usage.title,
      hold: model.vitals.hold,
      crews: model.crews,
    });

    const rail = railLayout(this._viewportWidth, cards.length > 0 || inspection !== null, this._pinnedOpen);
    const baseUrl = `https://github.com/${s.owner}/${s.repo}`;

    return html`
      <div class="shell" style="--rail-w:${rail.reserved}px;--panel-w:${rail.panel}px">
        <shipyard-field
          .model=${model}
          .railWidth=${rail.reserved}
          .lampWidth=${s.fleet === null ? lampReserve(this._viewportWidth) : 0}
          .anchors=${rail.open ? this._anchors : NO_ANCHORS}
          @field-select=${this._onSelect}
          @field-log=${() => { this._logOpen = !this._logOpen; }}
        ></shipyard-field>
        ${s.fleet === null ? html`<keep-awake-light
          @keep-awake-status=${(event: CustomEvent<KeepAwakeStatus>) => { this._keepAwake = event.detail; }}
        ></keep-awake-light>` : ''}
        <activity-drawer
          .open=${this._logOpen}
          .events=${s.eventStream}
          .feed=${s.broadcastVisible}
          .baseUrl=${baseUrl}
          .multiProject=${s.multiProject}
          .eventCount=${s.eventCount}
          .sessionCount=${s.sessionCount}
          @drawer-close=${() => { this._logOpen = false; }}
        ></activity-drawer>
        <shipyard-inbox
          .cards=${cards}
          .inspection=${inspection}
          .selectedCardId=${selectedCard?.id ?? null}
          .multiProject=${s.multiProject}
          .open=${rail.open}
          .overlay=${rail.overlay}
          .logOpen=${this._logOpen}
          .readOnly=${s.readOnly}
          @inbox-approve=${this._onApprove}
          @inbox-select=${this._onCardSelect}
          @inbox-dismiss=${this._onDismiss}
          @inbox-keep-awake=${this._onKeepAwake}
          @inbox-navigate=${this._onNavigate}
          @inbox-close-inspector=${() => { this._selection = null; }}
          @inbox-toggle=${() => { this._pinnedOpen = !this._pinnedOpen; }}
          @inbox-log=${() => { this._logOpen = !this._logOpen; }}
          @inbox-anchors=${this._onAnchors}
        ></shipyard-inbox>
      </div>
    `;
  }
}

<<<<<<<< HEAD:src/dashboard/components/shipyard-dashboard.ts
customElements.define('shipyard-dashboard', ShipyardDashboard);
========
customElements.define('shipyard-dashboard', ShipyardApp);
>>>>>>>> 2ba45e0 (Rename every remaining yoke reference to shipyard (#27)):src/dashboard/components/shipyard-app.ts
