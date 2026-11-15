import { LitElement, html, nothing } from 'lit';
import type { AvailableRepo, FleetMember, GitHubStatus, SubscribedRepo } from '../../shared/protocol.js';
import { errorLine, type Api } from './api.js';
import type { ConsoleView, FleetStore } from './fleet-store.js';

/** The organization the app is made for, when nobody has said: the studio's. */
export const DEFAULT_ORG = 'outrightmental';

/** One line of the Repositories table: a repository the app can see, one Shipyard is subscribed to, or both. */
export interface RepoRow {
  repo: string;
  /** What GitHub says of it, when the app's installation can see it. */
  available: AvailableRepo | null;
  /** Shipyard's subscription to it, when it has one. */
  subscribed: SubscribedRepo | null;
}

/**
 * Every repository there is to show: the ones the app's installation can see,
 * and the ones Shipyard is subscribed to — which should be among them, and
 * are listed all the same when they are not, since a subscription the app can
 * no longer see is exactly what an operator needs to be shown. Subscribed
 * first, then by name.
 */
export function repoRows(available: readonly AvailableRepo[], subscribed: readonly SubscribedRepo[]): RepoRow[] {
  const rows = new Map<string, RepoRow>();
  for (const repo of available) rows.set(repo.repo.toLowerCase(), { repo: repo.repo, available: repo, subscribed: null });
  for (const repo of subscribed) {
    const key = repo.repo.toLowerCase();
    const row = rows.get(key);
    if (row) row.subscribed = repo;
    else rows.set(key, { repo: repo.repo, available: null, subscribed: repo });
  }
  return [...rows.values()].sort((a, b) => {
    if ((a.subscribed === null) !== (b.subscribed === null)) return a.subscribed === null ? 1 : -1;
    return a.repo.toLowerCase() < b.repo.toLowerCase() ? -1 : 1;
  });
}

/**
 * Repositories: what Shipyard is subscribed to, and who works each.
 *
 * Shipyard is on GitHub as an app the operator creates from here, once, and
 * installs on the organization. A repository the app can see can be
 * subscribed to, which puts its issues on the dashboard; it gets no work done
 * until it is assigned to a fleet member.
 */
export class ShipyardRepos extends LitElement {
  static override properties = {
    store: { attribute: false },
    api: { attribute: false },
    _view: { state: true },
    _available: { state: true },
    _availableError: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _org: { state: true },
    _filter: { state: true },
  };

  store: FleetStore | null = null;
  api: Api | null = null;

  private _view: ConsoleView | null = null;
  private _available: AvailableRepo[] | null = null;
  private _availableError: string | null = null;
  private _busy: string | null = null;
  private _error: string | null = null;
  private _org = DEFAULT_ORG;
  private _filter = '';
  private _unsub: (() => void) | null = null;
  /** The installation the list of repositories was last read for. */
  private _listedFor: number | null = null;

  protected override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    if (!this.store) return;
    this._view = this.store.view;
    this._unsub = this.store.subscribeView((view) => {
      this._view = view;
      this._listIfInstalled();
    });
    this._listIfInstalled();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
  }

  /** Read what the app can see, once per installation: it changes only when the installation does. */
  private _listIfInstalled() {
    const installation = this._view?.github.installation?.id ?? null;
    if (installation === null) {
      this._available = null;
      this._listedFor = null;
      return;
    }
    if (installation === this._listedFor) return;
    this._listedFor = installation;
    void this._list();
  }

  private async _list() {
    this._availableError = null;
    try {
      const { available } = await this.api!.get<{ available: AvailableRepo[] }>('/github/repositories');
      this._available = available;
    } catch (error) {
      this._availableError = errorLine(error);
    }
  }

  private async _run(what: string, action: () => Promise<void>) {
    if (this._busy) return;
    this._busy = what;
    this._error = null;
    try {
      await action();
      await this.store?.refresh();
    } catch (error) {
      this._error = errorLine(error);
    } finally {
      this._busy = null;
    }
  }

  // ── GitHub ─────────────────────────────────────────────────────────────────

  /**
   * Create the app: the platform makes the manifest and remembers its state;
   * this page posts it to GitHub in the operator's own browser, as GitHub's
   * manifest flow asks. GitHub sends the browser back to the console with a
   * code, which the console's entry hands to the platform (main.ts).
   */
  private _connect() {
    return this._run('connect', async () => {
      const begun = await this.api!.post<{ action: string; manifest: Record<string, unknown> }>('/github/manifest', { org: this._org.trim() });
      const form = document.createElement('form');
      form.method = 'post';
      form.action = begun.action;
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'manifest';
      field.value = JSON.stringify(begun.manifest);
      form.append(field);
      document.body.append(form);
      form.submit();
    });
  }

  private _refreshInstallation() {
    return this._run('refresh', async () => {
      await this.api!.post('/github/refresh');
      this._listedFor = null;
    });
  }

  private _disconnect(github: GitHubStatus) {
    if (!confirm(`Disconnect Shipyard from ${github.app?.name ?? 'GitHub'}? Fleet members can no longer be given GitHub tokens, so all work stops. The app itself stays on GitHub until it is deleted there.`)) return;
    void this._run('disconnect', () => this.api!.delete('/github'));
  }

  private _github(github: GitHubStatus) {
    if (!github.connected || !github.app) {
      return html`
        <section class="console-card" aria-label="Connect GitHub">
          <header class="console-card-head"><h2>Connect GitHub</h2></header>
          <p class="console-note">
            Shipyard works on GitHub as a GitHub App of its own: its access is the repositories it is installed on, and what it
            does there is done in its name. Creating it takes one confirmation on GitHub; nothing secret is typed or pasted.
          </p>
          <form class="console-row" @submit=${(event: Event) => { event.preventDefault(); void this._connect(); }}>
            <label class="console-field">
              <span>Organization</span>
              <input
                class="console-input" type="text" required autocomplete="off" spellcheck="false"
                .value=${this._org}
                @input=${(event: Event) => { this._org = (event.target as HTMLInputElement).value; }}
              >
            </label>
            <button class="console-button is-primary" type="submit" ?disabled=${this._busy === 'connect'}>Create the GitHub App</button>
          </form>
        </section>`;
    }
    const { app, installation } = github;
    return html`
      <section class="console-card" aria-label="GitHub">
        <header class="console-card-head">
          <span class="console-dot is-${installation ? 'ok' : 'held'}" aria-hidden="true"></span>
          <h2><a class="console-link" href="${app.htmlUrl}" target="_blank" rel="noopener noreferrer">${app.name}</a></h2>
          <span class="console-standing is-${installation ? 'ok' : 'held'}">${installation ? `installed on ${installation.account}` : 'not installed yet'}</span>
        </header>
        ${installation
          ? html`<p class="console-note">
              It sees ${installation.repositorySelection === 'all' ? 'every repository of the organization' : 'the repositories chosen for it'}.
              ${installation.htmlUrl ? html`<a class="console-link" href="${installation.htmlUrl}" target="_blank" rel="noopener noreferrer">Change which on GitHub</a>, then read them again here.` : ''}
            </p>`
          : html`<p class="console-note">
              The app exists and is installed nowhere, so it can see no repository. Install it on ${github.org ?? 'the organization'},
              choosing the repositories Shipyard may work on.
            </p>`}
        <div class="console-row">
          ${installation ? nothing : html`<a class="console-button is-primary" href="${app.installUrl}">Install on GitHub</a>`}
          <button class="console-button" type="button" ?disabled=${this._busy === 'refresh'} @click=${() => this._refreshInstallation()}>
            ${installation ? 'Read the repositories again' : 'I have installed it'}
          </button>
          <button class="console-button is-danger" type="button" ?disabled=${this._busy === 'disconnect'} @click=${() => this._disconnect(github)}>Disconnect</button>
        </div>
      </section>`;
  }

  // ── Repositories ───────────────────────────────────────────────────────────

  private _path(repo: string): string {
    const [owner, name] = repo.split('/');
    return `/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}`;
  }

  private _subscribe(row: RepoRow) {
    return this._run(`repo:${row.repo}`, () => this.api!.put(this._path(row.repo), {}));
  }

  private _unsubscribe(row: RepoRow) {
    const worked = row.subscribed?.memberId ? ' The fleet member working it stops, once what it is running on it ends.' : '';
    if (!confirm(`Stop subscribing to ${row.repo}?${worked} Its issues leave the dashboard.`)) return;
    void this._run(`repo:${row.repo}`, () => this.api!.delete(this._path(row.repo)));
  }

  private _assign(row: RepoRow, event: Event) {
    const memberId = (event.target as HTMLSelectElement).value || null;
    void this._run(`repo:${row.repo}`, () => this.api!.put(this._path(row.repo), { memberId }));
  }

  private _row(row: RepoRow, members: readonly FleetMember[]) {
    const { subscribed, available } = row;
    const busy = this._busy === `repo:${row.repo}`;
    const assigned = subscribed?.memberId ?? '';
    // Assigned to a member that has since been retired is assigned to no one.
    const orphaned = assigned !== '' && !members.some((member) => member.id === assigned);
    return html`
      <tr class="${subscribed ? 'is-subscribed' : ''}" aria-busy="${busy ? 'true' : 'false'}">
        <td>
          <a class="console-link" href="${available?.htmlUrl ?? `https://github.com/${row.repo}`}" target="_blank" rel="noopener noreferrer">${row.repo}</a>
          ${available?.private ? html`<span class="console-tag">private</span>` : nothing}
          ${available?.archived ? html`<span class="console-tag">archived</span>` : nothing}
          ${subscribed && !available && this._available !== null ? html`<span class="console-tag is-down" title="The GitHub App's installation does not include this repository, so no fleet member can be given a token for it">not visible to the app</span>` : nothing}
          ${available?.description ? html`<div class="console-faint">${available.description}</div>` : nothing}
        </td>
        <td>
          ${subscribed
            ? html`<select class="console-input${assigned === '' || orphaned ? ' is-held' : ''}" aria-label="Fleet member for ${row.repo}" ?disabled=${busy} @change=${(event: Event) => this._assign(row, event)}>
                <option value="" ?selected=${assigned === '' || orphaned}>— no one —</option>
                ${members.map((member) => html`<option value="${member.id}" ?selected=${member.id === assigned}>${member.name}</option>`)}
              </select>
              ${assigned === '' || orphaned ? html`<span class="console-standing is-held">gets no work done</span>` : nothing}`
            : html`<span class="console-faint">not subscribed</span>`}
        </td>
        <td class="console-cell-action">
          ${subscribed
            ? html`<button class="console-button is-quiet" type="button" ?disabled=${busy} @click=${() => this._unsubscribe(row)}>Unsubscribe</button>`
            : html`<button class="console-button" type="button" ?disabled=${busy} @click=${() => this._subscribe(row)}>Subscribe</button>`}
        </td>
      </tr>`;
  }

  private _repositories(view: ConsoleView) {
    const rows = repoRows(this._available ?? [], view.repos);
    const filter = this._filter.trim().toLowerCase();
    const shown = filter ? rows.filter((row) => row.repo.toLowerCase().includes(filter)) : rows;
    const installed = view.github.installation !== null;
    if (rows.length === 0) {
      return html`<p class="console-empty">${installed
        ? this._available === null ? (this._availableError ?? 'Reading the repositories the app can see…') : 'The app can see no repository yet. Give it some on GitHub, then read them again.'
        : 'Once the app is installed, the repositories it can see are listed here to subscribe to.'}</p>`;
    }
    return html`
      ${this._availableError ? html`<p class="console-banner" role="alert">The repositories the app can see could not be read: ${this._availableError}</p>` : nothing}
      <div class="console-row console-table-tools">
        <input
          class="console-input" type="search" placeholder="Filter repositories" aria-label="Filter repositories"
          .value=${this._filter}
          @input=${(event: Event) => { this._filter = (event.target as HTMLInputElement).value; }}
        >
        <span class="console-faint">${view.repos.length} subscribed${this._available ? ` of ${this._available.length} the app can see` : ''}</span>
      </div>
      <table class="console-table">
        <thead><tr><th scope="col">Repository</th><th scope="col">Worked by</th><th scope="col"><span class="console-sr">Subscription</span></th></tr></thead>
        <tbody>${shown.map((row) => this._row(row, view.members))}</tbody>
      </table>
      ${view.members.length === 0 && view.repos.length > 0
        ? html`<p class="console-note">There is no fleet member to assign these to yet. <a class="console-link" href="#/fleet">Enroll a machine</a>.</p>`
        : nothing}`;
  }

  override render() {
    const view = this._view;
    if (!view) return html``;
    return html`
      <div class="console-scroll">
        <header class="console-page-head">
          <div>
            <h1>Repositories</h1>
            <p class="console-lede">
              Subscribing to a repository puts its issues on the dashboard. It gets no work done until it is assigned to a fleet
              member, and it is assigned to exactly one.
            </p>
          </div>
        </header>
        ${this._error ? html`<p class="console-banner" role="alert">${this._error}</p>` : nothing}
        ${this._github(view.github)}
        ${view.github.connected ? this._repositories(view) : nothing}
      </div>`;
  }
}

customElements.define('shipyard-repos', ShipyardRepos);
