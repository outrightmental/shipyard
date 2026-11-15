import { LitElement, html, nothing } from 'lit';
import { fleetNotices, type FleetNotice } from '../../shared/notices.js';
import { shortCommit } from '../../shared/release.js';
import '../components/yoke-app.js';
import type { Api } from './api.js';
import type { Auth } from './auth.js';
import './fleet-page.js';
import type { ConsoleView, FleetStore } from './fleet-store.js';
import { icons } from './icons.js';
import './repos-page.js';

/** The console's pages, by the name each goes by in the address (`#/fleet`). */
export type Page = 'dashboard' | 'fleet' | 'repositories';

const PAGES: ReadonlyArray<{ id: Page; label: string; hint: string; icon: keyof typeof icons }> = [
  { id: 'dashboard', label: 'Dashboard', hint: 'Everything the fleet is working on', icon: 'dashboard' },
  { id: 'fleet', label: 'Fleet', hint: 'The machines that host coding agents', icon: 'fleet' },
  { id: 'repositories', label: 'Repositories', hint: 'What Shipyard is subscribed to, and who works each', icon: 'repositories' },
];

/** Whether the menu is folded to its icons, kept for this browser. */
const NAV_KEY = 'shipyard.nav.collapsed';

/** The page an address names: `#/fleet` is Fleet, anything unknown is the dashboard. */
export function pageOf(hash: string): Page {
  const name = hash.replace(/^#\/?/, '').split('?')[0];
  return PAGES.some((page) => page.id === name) ? name as Page : 'dashboard';
}

/** How many notices each page's item in the menu counts: where each is put right. */
export function noticeCounts(notices: readonly FleetNotice[]): Record<Page, number> {
  const counts: Record<Page, number> = { dashboard: 0, fleet: 0, repositories: 0 };
  for (const notice of notices) {
    switch (notice.kind) {
      case 'no-fleet':
      case 'member-offline':
      case 'member-note':
        counts.fleet += 1;
        break;
      default:
        counts.repositories += 1;
    }
  }
  return counts;
}

/**
 * The console: a menu down the left-hand edge that folds to its icons, and
 * the page beside it.
 *
 * The dashboard is Yoke's, unchanged in how it is drawn — the field, and the
 * inbox down its right-hand edge — for the whole fleet at once. Fleet and
 * Repositories are where the fleet is set up: which machines there are, which
 * repositories Shipyard is subscribed to, and who works each.
 */
export class ShipyardApp extends LitElement {
  static override properties = {
    store: { attribute: false },
    api: { attribute: false },
    auth: { attribute: false },
    notice: { attribute: false },
    _view: { state: true },
    _page: { state: true },
    _collapsed: { state: true },
  };

  store: FleetStore | null = null;
  api: Api | null = null;
  auth: Auth | null = null;
  /** Something that went wrong before the console was up, to say along its top until it is put away. */
  notice: string | null = null;

  private _view: ConsoleView | null = null;
  private _page: Page = pageOf(typeof location === 'undefined' ? '' : location.hash);
  private _collapsed = readCollapsed();
  private _unsub: (() => void) | null = null;

  private readonly _onHashChange = () => { this._page = pageOf(location.hash); };

  protected override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    if (this.store) {
      this._view = this.store.view;
      this._unsub = this.store.subscribeView((view) => { this._view = view; });
    }
    window.addEventListener('hashchange', this._onHashChange);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
    window.removeEventListener('hashchange', this._onHashChange);
  }

  private _go(page: Page) {
    if (pageOf(location.hash) !== page) location.hash = `#/${page === 'dashboard' ? '' : page}`;
    this._page = page;
  }

  private _toggle() {
    this._collapsed = !this._collapsed;
    try { localStorage.setItem(NAV_KEY, this._collapsed ? '1' : '0'); } catch { /* no storage */ }
  }

  private _sidebar(view: ConsoleView) {
    const counts = noticeCounts(fleetNotices(view, this.store?.now() ?? Date.now()));
    const org = view.github.org;
    const release = shortCommit(view.release);
    return html`
      <aside class="console-side" aria-label="Shipyard">
        <div class="console-brand" title="Shipyard${org ? ` · ${org}` : ''}">
          <span class="console-mark">${icons.mark()}</span>
          <span class="console-name">Shipyard<small>${org ?? 'not connected to GitHub'}</small></span>
        </div>
        <nav class="console-nav">
          ${PAGES.map((page) => html`
            <button
              class="console-item${this._page === page.id ? ' is-active' : ''}"
              type="button"
              title="${page.label} — ${page.hint}"
              aria-current="${this._page === page.id ? 'page' : 'false'}"
              @click=${() => this._go(page.id)}
            >
              ${icons[page.icon]()}
              <span class="console-item-text">${page.label}</span>
              ${counts[page.id] > 0 ? html`<span class="console-pill" aria-label="${counts[page.id]} to look at">${counts[page.id]}</span>` : nothing}
            </button>`)}
        </nav>
        <div class="console-foot">
          ${view.operatorEmail ? html`<div class="console-who" title="Signed in as ${view.operatorEmail}">${view.operatorEmail}</div>` : nothing}
          ${release ? html`<div class="console-who console-release" title="The commit Shipyard runs">${release}</div>` : nothing}
          <button class="console-item" type="button" title="Sign out" @click=${() => { void this.auth?.signOut(); }}>
            ${icons.signOut()}<span class="console-item-text">Sign out</span>
          </button>
          <button
            class="console-item"
            type="button"
            title="${this._collapsed ? 'Expand the menu' : 'Collapse the menu'}"
            aria-expanded="${this._collapsed ? 'false' : 'true'}"
            @click=${() => this._toggle()}
          >
            ${this._collapsed ? icons.chevronRight() : icons.chevronLeft()}<span class="console-item-text">Collapse</span>
          </button>
        </div>
      </aside>`;
  }

  private _pageBody(view: ConsoleView) {
    if (!view.loaded) {
      return html`<div class="console-starting" role="status">${view.error ? `Shipyard could not be read: ${view.error}` : 'Reading the fleet…'}</div>`;
    }
    switch (this._page) {
      case 'fleet':
        return html`<shipyard-fleet class="console-page" .store=${this.store} .api=${this.api}></shipyard-fleet>`;
      case 'repositories':
        return html`<shipyard-repos class="console-page" .store=${this.store} .api=${this.api}></shipyard-repos>`;
      default:
        return html`<div class="console-page console-dashboard"><yoke-app .store=${this.store}></yoke-app></div>`;
    }
  }

  override render() {
    const view = this._view;
    if (!view) return html``;
    return html`
      <div
        class="console${this._collapsed ? ' is-collapsed' : ''}"
        @dashboard-navigate=${(event: CustomEvent<string>) => this._go(pageOf(`#/${event.detail}`))}
      >
        ${this._sidebar(view)}
        <main class="console-main">
          ${this.notice ? html`<p class="console-banner console-notice" role="alert">
            <span>${this.notice}</span>
            <button class="console-button is-quiet" type="button" @click=${() => { this.notice = null; }}>Dismiss</button>
          </p>` : nothing}
          ${this._pageBody(view)}
        </main>
      </div>`;
  }
}

function readCollapsed(): boolean {
  try { return localStorage.getItem(NAV_KEY) === '1'; } catch { return false; }
}

customElements.define('shipyard-app', ShipyardApp);
