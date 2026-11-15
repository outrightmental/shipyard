import { LitElement, html, nothing } from 'lit';
import { memberOnline, type FleetMember } from '../../shared/protocol.js';
import { sameCommit, shortCommit } from '../../shared/release.js';
import { formatDuration } from '../shared/format.js';
import { usageGaugeView, usageLimitUntilMs } from '../shared/usage-gauge.js';
import { liveHold } from '../shared/vitals.js';
import { errorLine, type Api } from './api.js';
import type { ConsoleView, FleetStore } from './fleet-store.js';
import { icons } from './icons.js';

/** What a machine is told to run to join, with the code it was just given. */
export function enrollCommands(code: string): string[] {
  return [
    'git clone https://github.com/outrightmental/shipyard.git',
    'cd shipyard',
    'npm ci',
    `npm run enroll -- --code ${code}`,
  ];
}

/** How a member stands, in a word and a tone, at `nowMs`. */
export function memberStanding(
  member: FleetMember,
  release: string | null,
  nowMs: number,
): { word: string; tone: 'ok' | 'held' | 'down'; detail: string } {
  if (member.lastSeenAt === null) {
    return { word: 'not connected yet', tone: 'held', detail: 'enrolled, and has not been heard from since' };
  }
  const seenMs = Date.parse(member.lastSeenAt);
  if (!memberOnline(member, nowMs)) {
    return { word: 'offline', tone: 'down', detail: `last heard from ${formatDuration(Math.max(0, nowMs - seenMs))} ago` };
  }
  if (member.notes.length > 0) return { word: 'needs attention', tone: 'down', detail: member.notes[0]!.message };
  // A platform applied by hand announces no commit, and holds no member to one.
  if (release !== null && member.commit !== null && !sameCommit(member.commit, release)) {
    return { word: 'updating', tone: 'held', detail: `on ${shortCommit(member.commit)}, bringing itself to ${shortCommit(release)}` };
  }
  return { word: 'online', tone: 'ok', detail: member.connected ? 'connected' : 'reporting; its socket is not open, so decisions reach it at its next heartbeat' };
}

/**
 * Fleet: the machines that host coding agents for Shipyard.
 *
 * One fleet member is one machine and one Claude account. A machine joins
 * with a one-time code made here; it starts assigned to nothing, and is given
 * work on the Repositories page.
 */
export class ShipyardFleet extends LitElement {
  static override properties = {
    store: { attribute: false },
    api: { attribute: false },
    _view: { state: true },
    _code: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _copied: { state: true },
    _tick: { state: true },
  };

  store: FleetStore | null = null;
  api: Api | null = null;

  private _view: ConsoleView | null = null;
  private _code: { code: string; expiresAt: string } | null = null;
  private _busy: string | null = null;
  private _error: string | null = null;
  private _copied = false;
  private _tick = 0;
  private _unsubs: Array<() => void> = [];

  protected override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    if (!this.store) return;
    this._view = this.store.view;
    this._unsubs.push(this.store.subscribeView((view) => { this._view = view; }));
    // The dashboard's sum ticks once a second: "last heard from" and the usage gauges run on it.
    this._unsubs.push(this.store.subscribe(() => { this._tick += 1; }));
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    for (const unsub of this._unsubs.splice(0)) unsub();
  }

  /** Do something to the fleet, saying so while it is under way and what went wrong if it does. */
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

  private _enroll() {
    return this._run('enroll', async () => {
      this._code = await this.api!.post<{ code: string; expiresAt: string }>('/fleet/enroll-codes');
      this._copied = false;
    });
  }

  private async _copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this._copied = true;
    } catch {
      this._copied = false;
    }
  }

  private _rename(member: FleetMember, event: Event) {
    const input = event.target as HTMLInputElement;
    const name = input.value.trim();
    if (!name || name === member.name) {
      input.value = member.name;
      return;
    }
    void this._run(`rename:${member.id}`, () => this.api!.patch(`/fleet/${member.id}`, { name }));
  }

  private _resize(member: FleetMember, event: Event) {
    const input = event.target as HTMLInputElement;
    const maxConcurrency = Number(input.value);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency === member.maxConcurrency) {
      input.value = String(member.maxConcurrency);
      return;
    }
    void this._run(`resize:${member.id}`, () => this.api!.patch(`/fleet/${member.id}`, { maxConcurrency }));
  }

  private _retire(member: FleetMember) {
    const assigned = member.repos.length > 0
      ? ` Its ${member.repos.length === 1 ? 'repository is' : `${member.repos.length} repositories are`} left assigned to no one.`
      : '';
    if (!confirm(`Retire ${member.name}? Its token stops working at once, and the machine stops.${assigned}`)) return;
    void this._run(`retire:${member.id}`, () => this.api!.delete(`/fleet/${member.id}`));
  }

  private _enrollPanel() {
    const code = this._code;
    if (!code) return nothing;
    const expiresMs = Date.parse(code.expiresAt) - (this.store?.now() ?? Date.now());
    const commands = enrollCommands(code.code);
    return html`
      <section class="console-card console-enroll" aria-label="Enroll a machine">
        <header class="console-card-head">
          <h2>Enroll a machine</h2>
          <button class="console-button is-quiet" type="button" @click=${() => { this._code = null; }}>Done</button>
        </header>
        ${expiresMs <= 0
          ? html`<p class="console-note is-down">That code has expired. Make another.</p>`
          : html`
            <p class="console-note">
              On the machine — signed in to the Claude account it is to work with (<code>claude login</code>) — run these.
              The code enrolls one machine, once, and lasts ${formatDuration(expiresMs)} more.
            </p>
            <pre class="console-code">${commands.join('\n')}</pre>
            <div class="console-row">
              <button class="console-button" type="button" @click=${() => this._copy(commands.join('\n'))}>
                ${icons.copy()}<span>${this._copied ? 'Copied' : 'Copy the commands'}</span>
              </button>
              <span class="console-faint">It installs the member as a service, which starts with the machine and keeps itself on Shipyard's commit.</span>
            </div>`}
      </section>`;
  }

  private _member(member: FleetMember, view: ConsoleView, nowMs: number) {
    const standing = memberStanding(member, view.release, nowMs);
    const crew = this.store?.getState().fleet?.find((candidate) => candidate.id === member.id) ?? null;
    // As the member's heading on the dashboard reads it: LIMIT while its usage limit holds its pool.
    const gauge = usageGaugeView(crew?.usage ?? null, nowMs, usageLimitUntilMs(liveHold(crew?.hold ?? null, nowMs)));
    const host = member.host;
    const busy = this._busy?.endsWith(`:${member.id}`) ?? false;
    return html`
      <article class="console-card console-member is-${standing.tone}" aria-busy="${busy ? 'true' : 'false'}">
        <header class="console-card-head">
          <span class="console-dot is-${standing.tone}" aria-hidden="true"></span>
          <input
            class="console-input console-member-name"
            type="text"
            aria-label="Name of ${member.name}"
            maxlength="64"
            .value=${member.name}
            @change=${(event: Event) => this._rename(member, event)}
          >
          <span class="console-standing is-${standing.tone}">${standing.word}</span>
        </header>
        <p class="console-note${standing.tone === 'down' ? ' is-down' : ''}">${standing.detail}</p>

        <dl class="console-facts">
          <div>
            <dt>Claude usage</dt>
            <dd title="${gauge.title}">
              <span class="console-meter" aria-hidden="true"><span class="is-${gauge.tone}" style="width:${gauge.fillPercent}%"></span></span>
              ${gauge.label.replace('CLAUDE', '').trim() || 'window'} ${gauge.percentText}${gauge.resetText === '—' ? '' : html` <span class="console-faint">resets in ${gauge.resetText}</span>`}
            </dd>
          </div>
          <div>
            <dt>Cylinders</dt>
            <dd>
              <input
                class="console-input console-number"
                type="number" min="1" max="32" step="1"
                aria-label="Cylinders ${member.name} has"
                title="How many pieces of work ${member.name} runs at once"
                .value=${String(member.maxConcurrency)}
                @change=${(event: Event) => this._resize(member, event)}
              >
              <span class="console-faint">at once · it restarts between runs to take a new number</span>
            </dd>
          </div>
          <div>
            <dt>Repositories</dt>
            <dd>${member.repos.length === 0
              ? html`<span class="console-standing is-held">none assigned</span> <a class="console-link" href="#/repositories">assign one</a>`
              : member.repos.map((repo) => html`<a class="console-chip" href="https://github.com/${repo}" target="_blank" rel="noopener noreferrer">${repo}</a>`)}</dd>
          </div>
          <div>
            <dt>Machine</dt>
            <dd>${host ? html`${host.hostname || 'unnamed'} <span class="console-faint">${[host.platform, host.arch, host.cpus ? `${host.cpus} cpus` : '', host.node ? `node ${host.node}` : ''].filter(Boolean).join(' · ')}</span>` : html`<span class="console-faint">not said yet</span>`}</dd>
          </div>
          <div>
            <dt>Commit</dt>
            <dd><code>${shortCommit(member.commit) ?? 'unknown'}</code></dd>
          </div>
        </dl>

        <footer class="console-card-foot">
          <span class="console-faint">${member.id} · enrolled ${new Date(member.enrolledAt).toLocaleDateString()}${member.enrolledBy ? ` by ${member.enrolledBy}` : ''}</span>
          <button class="console-button is-danger" type="button" ?disabled=${busy} @click=${() => this._retire(member)}>Retire</button>
        </footer>
      </article>`;
  }

  override render() {
    const view = this._view;
    if (!view) return html``;
    const nowMs = this.store?.now() ?? Date.now();
    return html`
      <div class="console-scroll">
        <header class="console-page-head">
          <div>
            <h1>Fleet</h1>
            <p class="console-lede">
              The machines that host coding agents. One fleet member is one machine and one Claude account;
              each works only the repositories assigned to it.
            </p>
          </div>
          <button class="console-button is-primary" type="button" ?disabled=${this._busy === 'enroll'} @click=${() => this._enroll()}>Enroll a machine</button>
        </header>
        ${this._error ? html`<p class="console-banner" role="alert">${this._error}</p>` : nothing}
        ${this._enrollPanel()}
        ${view.members.length === 0
          ? html`<p class="console-empty">No machine has joined yet. Enroll one to have somewhere for work to be done.</p>`
          : html`<div class="console-grid">${view.members.map((member) => this._member(member, view, nowMs))}</div>`}
      </div>`;
  }
}

customElements.define('shipyard-fleet', ShipyardFleet);
