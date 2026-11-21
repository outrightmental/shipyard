import { LitElement, html, nothing } from 'lit';
import type { AvailableRepo, EngineDefaults, GitHubStatus, RepoSettings, SubscribedRepo } from '../../shared/protocol.js';
import { formatClockTime } from '../shared/format.js';
import { errorLine, type Api } from './api.js';
import type { ConsoleView, FleetStore } from './fleet-store.js';
import {
  browserStorage,
  forgetKeptRepositories,
  keepRepositories,
  readKeptRepositories,
  type KeptRepositories,
  type MemberName,
} from './kept-repositories.js';

/** The organization the app is made for, when nobody has said: the studio's. */
export const DEFAULT_ORG = 'outrightmental';

/** How many rows stand in for the list while it is read for the first time. */
const PLACEHOLDER_ROWS = 6;

/** The list of what the app can see that is in hand, and the installation it is the list of. */
export interface ListInHand {
  installation: number;
  available: AvailableRepo[];
  /** When it was read, in epoch millis. */
  readAt: number;
}

/**
 * What the app's installation can see, kept up with the installation there is.
 *
 * Reading it takes GitHub seconds, so it is never waited for with nothing to
 * show: what this browser kept from its last visit is in hand at once, and a
 * reading is begun on arriving that replaces it. While that is under way
 * `reading` says so. A reading that fails leaves what is in hand as it was
 * and says why. A list that turns out to be another installation's is dropped
 * the moment that is known, and an answer that comes back after it has been
 * asked for again is not taken.
 */
export class AvailableList {
  list: ListInHand | null = null;
  /** A reading is under way. */
  reading = false;
  /** Why the last reading failed, when it did. */
  error: string | null = null;
  /** The list in hand was read on this visit, not kept from an earlier one. */
  fresh = false;
  /** The installation the last reading was begun for. */
  private _for: number | null = null;
  private _turn = 0;

  constructor(
    private readonly read: () => Promise<AvailableRepo[]>,
    private readonly changed: () => void,
    kept: KeptRepositories | null = null,
    private readonly now: () => number = Date.now,
  ) {
    const installation = kept?.github.installation?.id ?? null;
    if (kept?.available && installation !== null) {
      this.list = { installation, available: kept.available, readAt: kept.readAt ?? 0 };
    }
  }

  /** Follow the installation there is: its list is read, once, and another's is dropped. */
  follow(installation: number | null): void {
    if (this.list && this.list.installation !== installation) {
      this.list = null;
      this.fresh = false;
    }
    if (installation === null) {
      // A reading under way is for an installation there no longer is.
      this._for = null;
      this._turn += 1;
      this.reading = false;
      this.error = null;
      return;
    }
    if (installation === this._for) return;
    this._for = installation;
    void this._read(installation);
  }

  /** What the installation can see may have changed: the next `follow` reads it again. */
  stale(): void {
    this._for = null;
  }

  private async _read(installation: number): Promise<void> {
    const turn = ++this._turn;
    this.reading = true;
    this.error = null;
    this.changed();
    try {
      const available = await this.read();
      if (turn !== this._turn) return;
      this.list = { installation, available, readAt: this.now() };
      this.fresh = true;
    } catch (error) {
      if (turn !== this._turn) return;
      this.error = errorLine(error);
    }
    this.reading = false;
    this.changed();
  }
}

/**
 * What the page is drawn from: the fleet as the store has read it, or — until
 * it has — as this browser kept it, which nothing can be changed from.
 */
interface Drawn {
  github: GitHubStatus;
  repos: readonly SubscribedRepo[];
  members: readonly MemberName[];
  /** Platform-wide engine defaults; empty when drawn from kept state. */
  engineDefaults: EngineDefaults;
  /** The store has read the fleet: this is how things are, not how they were. */
  settled: boolean;
}

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
 *
 * The page is never drawn empty to be filled in later. It is drawn at once
 * from what this browser kept the last time it was here (kept-repositories.ts)
 * and read again behind that, and while it is being read the list says so:
 * in words, with a bar that sweeps under its headings, and — the first time,
 * when there is nothing kept to show — with rows standing in for the ones to
 * come.
 */
export class ShipyardRepos extends LitElement {
  static override properties = {
    store: { attribute: false },
    api: { attribute: false },
    _view: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _org: { state: true },
    _filter: { state: true },
    _expanded: { state: true },
  };

  store: FleetStore | null = null;
  api: Api | null = null;

  private _view: ConsoleView | null = null;
  /** The page as this browser last drew it: what is shown until the store has read the fleet. */
  private _kept: KeptRepositories | null = null;
  private _list: AvailableList | null = null;
  private _busy: string | null = null;
  private _error: string | null = null;
  private _org = DEFAULT_ORG;
  private _filter = '';
  private _unsub: (() => void) | null = null;
  /** Repos whose settings panel is expanded, by "owner/repo". */
  private _expanded = new Set<string>();

  protected override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    if (!this.store) return;
    this._kept = readKeptRepositories(browserStorage());
    this._list = new AvailableList(
      async () => (await this.api!.get<{ available: AvailableRepo[] }>('/github/repositories')).available,
      () => { this.requestUpdate(); this._keep(); },
      this._kept,
    );
    this._view = this.store.view;
    this._unsub = this.store.subscribeView((view) => {
      this._view = view;
      this._follow();
    });
    this._follow();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
  }

  private _drawn(): Drawn | null {
    const view = this._view;
    if (view?.loaded) return { github: view.github, repos: view.repos, members: view.members, settled: true, engineDefaults: view.engineDefaults };
    const kept = this._kept;
    return kept ? { github: kept.github, repos: kept.repos, members: kept.members, settled: false, engineDefaults: {} } : null;
  }

  /**
   * Read what the app can see, on arriving and whenever the installation
   * changes. Until the store has read the fleet the installation is the one
   * that was kept, so the reading is begun at once rather than after it.
   */
  private _follow() {
    this._list?.follow(this._drawn()?.github.installation?.id ?? null);
    this._keep();
  }

  /** Keep the page as it now is, for the next arrival. Only what the store has read is kept, never what was kept. */
  private _keep() {
    const view = this._view;
    if (!view?.loaded) return;
    if (!view.github.connected) {
      forgetKeptRepositories(browserStorage());
      return;
    }
    const list = this._list?.list ?? null;
    keepRepositories(browserStorage(), {
      github: view.github,
      repos: view.repos,
      members: view.members.map(({ id, name }) => ({ id, name })),
      available: list?.available ?? null,
      readAt: list?.readAt ?? null,
    });
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
      this._follow();
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
      this._list?.stale();
    });
  }

  private _disconnect(github: GitHubStatus) {
    if (!confirm(`Disconnect Shipyard from ${github.app?.name ?? 'GitHub'}? Fleet members can no longer be given GitHub tokens, so all work stops. The app itself stays on GitHub until it is deleted there.`)) return;
    void this._run('disconnect', () => this.api!.delete('/github'));
  }

  private _github(drawn: Drawn) {
    const { github } = drawn;
    // What was kept is shown, and nothing is changed from it.
    const off = !drawn.settled;
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
            <button class="console-button is-primary" type="submit" ?disabled=${off || this._busy === 'connect'}>Create the GitHub App</button>
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
          <button
            class="console-button" type="button"
            ?disabled=${off || this._busy === 'refresh' || this._list?.reading === true}
            @click=${() => this._refreshInstallation()}
          >
            ${installation ? 'Read the repositories again' : 'I have installed it'}
          </button>
          <button class="console-button is-danger" type="button" ?disabled=${off || this._busy === 'disconnect'} @click=${() => this._disconnect(github)}>Disconnect</button>
        </div>
      </section>`;
  }

  // ── Engine defaults ─────────────────────────────────────────────────────────

  private _engineDefaultsCard(drawn: Drawn) {
    const off = !drawn.settled;
    const busy = this._busy === 'engine-defaults' || off;
    const d = drawn.engineDefaults;
    return html`
      <section class="console-card" aria-label="Engine defaults">
        <header class="console-card-head"><h2>Engine defaults</h2></header>
        <p class="console-note">
          Platform-wide model and effort for each development phase. Per-repository settings override these; a
          machine's own <code>~/.shipyard/env.yaml</code> overrides both.
        </p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
          ${this._modelInput('Initial model', d.initialModel, (v) => this._saveEngineDefaults(drawn, 'initialModel', v), busy)}
          ${this._modelInput('Review model', d.reviewModel, (v) => this._saveEngineDefaults(drawn, 'reviewModel', v), busy)}
          ${this._effortSelect('Initial effort', d.initialEffort, (v) => this._saveEngineDefaults(drawn, 'initialEffort', v), busy)}
          ${this._effortSelect('Review effort', d.reviewEffort, (v) => this._saveEngineDefaults(drawn, 'reviewEffort', v), busy)}
          ${this._modelInput('Describe model', d.describeModel, (v) => this._saveEngineDefaults(drawn, 'describeModel', v), busy)}
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

  private _saveRepoSettings(row: RepoRow, field: keyof RepoSettings, value: string | undefined) {
    const current = row.subscribed?.settings ?? {};
    const next: Record<string, unknown> = { ...current };
    if (value !== undefined) next[field] = value;
    else delete next[field];
    void this._run(`repo:${row.repo}`, () => this.api!.put(this._path(row.repo), { settings: next }));
  }

  private _saveEngineDefaults(drawn: Drawn, field: keyof EngineDefaults, value: string | undefined) {
    const next: Record<string, unknown> = { ...drawn.engineDefaults };
    if (value !== undefined && value !== '') next[field] = value;
    else delete next[field];
    void this._run('engine-defaults', () => this.api!.put('/engine-defaults', next));
  }

  private _modelInput(label: string, value: string | undefined, onChange: (v: string | undefined) => void, busy: boolean) {
    return html`
      <label class="console-field">
        <span>${label}</span>
        <input
          class="console-input" type="text" placeholder="platform default" autocomplete="off" spellcheck="false"
          ?disabled=${busy}
          .value=${value ?? ''}
          @change=${(e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); onChange(v || undefined); }}
        >
      </label>`;
  }

  private _effortSelect(label: string, value: string | undefined, onChange: (v: string | undefined) => void, busy: boolean) {
    return html`
      <label class="console-field">
        <span>${label}</span>
        <select
          class="console-input"
          ?disabled=${busy}
          .value=${value ?? ''}
          @change=${(e: Event) => { const v = (e.target as HTMLSelectElement).value; onChange(v || undefined); }}
        >
          <option value="">platform default</option>
          ${['low', 'medium', 'high', 'xhigh', 'max'].map((e) => html`<option value="${e}" ?selected=${value === e}>${e}</option>`)}
        </select>
      </label>`;
  }

  private _row(row: RepoRow, drawn: Drawn) {
    const { subscribed, available } = row;
    const { members } = drawn;
    // One thing at a time: while a change is under way every row's controls
    // are off, so a press that would be dropped cannot be made, and the row
    // being changed says what is happening to it. They are off, too, while
    // the row is drawn from what was kept: that is how it was, not how it is.
    const active = this._busy === `repo:${row.repo}`;
    const busy = this._busy !== null || !drawn.settled;
    const assigned = subscribed?.memberId ?? '';
    // Assigned to a member that has since been retired is assigned to no one.
    const orphaned = assigned !== '' && !members.some((member) => member.id === assigned);
    const expanded = subscribed !== null && this._expanded.has(row.repo);
    const s = subscribed?.settings ?? {};
    return html`
      <tr class="${subscribed ? 'is-subscribed' : ''}" aria-busy="${active ? 'true' : 'false'}">
        <td>
          <a class="console-link" href="${available?.htmlUrl ?? `https://github.com/${row.repo}`}" target="_blank" rel="noopener noreferrer">${row.repo}</a>
          ${available?.private ? html`<span class="console-tag">private</span>` : nothing}
          ${available?.archived ? html`<span class="console-tag">archived</span>` : nothing}
          ${subscribed && !available && drawn.settled && this._list?.fresh === true && !this._list.reading
            // Said only of a list read on this visit: one kept from an earlier visit may simply be behind.
            ? html`<span class="console-tag is-down" title="The GitHub App's installation does not include this repository, so no fleet member can be given a token for it">not visible to the app</span>`
            : nothing}
          ${available?.description ? html`<div class="console-faint">${available.description}</div>` : nothing}
          ${subscribed
            ? html`<div>
                <button
                  class="console-button is-quiet" type="button" style="margin-top:0.25rem"
                  @click=${() => { if (expanded) this._expanded.delete(row.repo); else this._expanded.add(row.repo); this.requestUpdate(); }}
                >${expanded ? 'Hide settings' : 'Settings'}</button>
              </div>`
            : nothing}
          ${expanded ? html`
            <div class="console-repo-settings" style="margin-top:0.5rem;display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
              ${this._modelInput('Initial model', s.initialModel, (v) => this._saveRepoSettings(row, 'initialModel', v), busy)}
              ${this._modelInput('Review model', s.reviewModel, (v) => this._saveRepoSettings(row, 'reviewModel', v), busy)}
              ${this._effortSelect('Initial effort', s.initialEffort, (v) => this._saveRepoSettings(row, 'initialEffort', v), busy)}
              ${this._effortSelect('Review effort', s.reviewEffort, (v) => this._saveRepoSettings(row, 'reviewEffort', v), busy)}
              ${this._modelInput('Describe model', s.describeModel, (v) => this._saveRepoSettings(row, 'describeModel', v), busy)}
            </div>` : nothing}
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
            ? html`<button class="console-button is-quiet" type="button" ?disabled=${busy} @click=${() => this._unsubscribe(row)}>${active ? 'Working…' : 'Unsubscribe'}</button>`
            : html`<button class="console-button" type="button" ?disabled=${busy} @click=${() => this._subscribe(row)}>${active ? 'Subscribing…' : 'Subscribe'}</button>`}
        </td>
      </tr>`;
  }

  /** What is being read, in words, or null when nothing is. */
  private _activity(drawn: Drawn): string | null {
    if (this._list?.reading) return 'Reading the repositories from GitHub…';
    return drawn.settled ? null : 'Reading the fleet…';
  }

  /** A row standing in for one that is on its way, the first time the list is read. */
  private _placeholder() {
    return html`
      <tr class="console-placeholder" aria-hidden="true">
        <td><span class="console-bone"></span></td>
        <td><span class="console-bone"></span></td>
        <td class="console-cell-action"><span class="console-bone"></span></td>
      </tr>`;
  }

  private _repositories(drawn: Drawn) {
    const list = this._list?.list ?? null;
    const error = this._list?.error ?? null;
    const reading = this._list?.reading === true;
    const activity = this._activity(drawn);
    const rows = repoRows(list?.available ?? [], drawn.repos);
    const filter = this._filter.trim().toLowerCase();
    const shown = filter ? rows.filter((row) => row.repo.toLowerCase().includes(filter)) : rows;
    const installed = drawn.github.installation !== null;
    const failed = error
      ? html`<p class="console-banner" role="alert">
          The repositories the app can see could not be read: ${error}${list ? `. This is the list as it was read ${formatClockTime(list.readAt)}.` : ''}
        </p>`
      : nothing;
    if (rows.length === 0 && activity === null) {
      if (error) return failed;
      return html`<p class="console-empty">${installed
        ? 'The app can see no repository yet. Give it some on GitHub, then read them again.'
        : 'Once the app is installed, the repositories it can see are listed here to subscribe to.'}</p>`;
    }
    return html`
      ${failed}
      <div class="console-row console-table-tools">
        <input
          class="console-input" type="search" placeholder="Filter repositories" aria-label="Filter repositories"
          .value=${this._filter}
          @input=${(event: Event) => { this._filter = (event.target as HTMLInputElement).value; }}
        >
        <span class="console-faint">${drawn.repos.length} subscribed${list ? ` of ${list.available.length} the app can see` : ''}</span>
        <span class="console-activity" role="status">
          ${activity ? html`<span class="console-spinner" aria-hidden="true"></span>${activity}` : nothing}
        </span>
      </div>
      <table class="console-table" aria-busy="${activity ? 'true' : 'false'}">
        <thead><tr><th scope="col">Repository</th><th scope="col">Worked by</th><th scope="col"><span class="console-sr">Subscription</span></th></tr></thead>
        <tbody>
          <tr class="console-table-activity" aria-hidden="true">
            <td colspan="3"><div class="console-progress${activity ? ' is-on' : ''}"></div></td>
          </tr>
          ${shown.map((row) => this._row(row, drawn))}
          ${reading && list === null ? Array.from({ length: PLACEHOLDER_ROWS }, () => this._placeholder()) : nothing}
        </tbody>
      </table>
      ${drawn.settled && drawn.members.length === 0 && drawn.repos.length > 0
        ? html`<p class="console-note">There is no fleet member to assign these to yet. <a class="console-link" href="#/fleet">Enroll a machine</a>.</p>`
        : nothing}`;
  }

  override render() {
    const view = this._view;
    if (!view) return html``;
    const drawn = this._drawn();
    if (!drawn) {
      // Nothing read yet and nothing kept: the first arrival in this browser.
      return view.error
        ? html`<div class="console-starting" role="status">Shipyard could not be read: ${view.error}</div>`
        : html`<div class="console-starting" role="status"><span class="console-spinner" aria-hidden="true"></span>Reading the fleet…</div>`;
    }
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
        ${!drawn.settled && view.error
          ? html`<p class="console-banner" role="alert">Shipyard could not be read: ${view.error}. This is the page as it was last read.</p>`
          : nothing}
        ${this._error ? html`<p class="console-banner" role="alert">${this._error}</p>` : nothing}
        ${this._github(drawn)}
        ${this._engineDefaultsCard(drawn)}
        ${drawn.github.connected ? this._repositories(drawn) : nothing}
      </div>`;
  }
}

customElements.define('shipyard-repos', ShipyardRepos);
