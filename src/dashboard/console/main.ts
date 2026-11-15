import '../styles/global.css';
import '../styles/inbox.css';
import '../styles/drawer.css';
import './console.css';
import { Api, errorLine } from './api.js';
import { createAuth, type Auth } from './auth.js';
import { loadConfig } from './config.js';
import { FleetStore } from './fleet-store.js';
import './shipyard-app.js';
import type { ShipyardApp } from './shipyard-app.js';

/**
 * The console's entry: read config.json, settle who is signed in, and mount
 * the console with a store that is already reading the fleet.
 *
 * GitHub sends the operator's browser back here twice while Shipyard is being
 * connected to it: once with the code the new app is redeemed with
 * (`?code=…&state=…`), and once when the app has been installed
 * (`?installation_id=…&setup_action=…`). Either can arrive in a tab that has
 * to sign in first, and a sign-in comes back to the console's bare address —
 * so what GitHub said is taken out of the address before anything else and
 * kept for this tab until someone is signed in to act on it.
 */

/** What GitHub sent the browser back with, kept for this tab until it is acted on. */
const GITHUB_RETURN_KEY = 'shipyard.console.github-return';

interface GitHubReturn {
  /** The manifest's code, with the state it was sent with. */
  code?: string;
  state?: string;
  /** The app was installed, or its installation changed. */
  installed?: boolean;
}

/** Take what GitHub said out of the address, and keep it. */
export function stashGitHubReturn(search: string, storage: Pick<Storage, 'getItem' | 'setItem'>): GitHubReturn | null {
  const query = new URLSearchParams(search);
  const code = query.get('code');
  const state = query.get('state');
  const found: GitHubReturn | null =
    code && state ? { code, state }
      : query.has('installation_id') || query.has('setup_action') || query.get('github') === 'installed' ? { installed: true }
        : null;
  if (found) {
    try { storage.setItem(GITHUB_RETURN_KEY, JSON.stringify(found)); } catch { /* no storage: acted on in this page load or not at all */ }
    return found;
  }
  try { return JSON.parse(storage.getItem(GITHUB_RETURN_KEY) ?? 'null') as GitHubReturn | null; } catch { return null; }
}

/** Act on what GitHub sent the browser back with. Returns what to tell the operator if it went wrong. */
async function finishGitHubReturn(api: Api, returned: GitHubReturn): Promise<string | null> {
  try {
    if (returned.code) await api.post('/github/app', { code: returned.code, state: returned.state });
    // Either way the app may be installed by now: look.
    await api.post('/github/refresh').catch(() => undefined);
    return null;
  } catch (error) {
    return `GitHub was not connected: ${errorLine(error)}`;
  }
}

function say(root: HTMLElement, text: string, again?: { label: string; action: () => void }): void {
  const line = document.createElement('div');
  line.className = 'console-starting';
  line.setAttribute('role', 'status');
  line.textContent = text;
  if (again) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'console-button is-primary';
    button.textContent = again.label;
    button.addEventListener('click', again.action);
    line.append(button);
  }
  root.replaceChildren(line);
}

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  say(root, 'Shipyard');

  const returned = stashGitHubReturn(location.search, sessionStorage);
  if (location.search) history.replaceState(null, '', `${location.pathname}${location.hash}`);

  const config = await loadConfig();
  const auth: Auth = createAuth(config.cognito);
  const outcome = await auth.start();
  if ('redirected' in outcome) return; // leaving for the sign-in pages
  if (!outcome.ok) {
    say(root, `Sign-in failed: ${outcome.error}`, { label: 'Sign in again', action: () => { void auth.signIn(); } });
    return;
  }

  const api = new Api(config.apiBase, auth);
  let notice: string | null = null;
  if (returned) {
    try { sessionStorage.removeItem(GITHUB_RETURN_KEY); } catch { /* no storage */ }
    say(root, 'Connecting to GitHub…');
    notice = await finishGitHubReturn(api, returned);
    // Where the connection is finished: the app installed, repositories subscribed to.
    location.hash = '#/repositories';
  }

  const store = new FleetStore(api, auth, config.wsUrl);
  store.start();

  const app = document.createElement('shipyard-app') as ShipyardApp;
  app.store = store;
  app.api = api;
  app.auth = auth;
  app.notice = notice;
  root.replaceChildren(app);
}

boot().catch((error: unknown) => {
  const root = document.getElementById('app');
  if (root) say(root, `The console could not start: ${error instanceof Error ? error.message : String(error)}`);
});
