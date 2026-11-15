import type { CognitoConfig } from './config.js';

/**
 * Who is signed in: the console's own sign-in pages at the sign-in host
 * (console/auth/), which sign in against the Cognito user pool and hand the
 * tokens back, and Cognito's API for the rest.
 *
 *   sign in    → `${domain}/?redirect_uri=…&state=…` (the state and the hash to
 *                return to are kept in this tab's sessionStorage)
 *   hand-back  → `#state=…&id_token=…&refresh_token=…`: the state must be the
 *                kept one; the tokens go in localStorage and the URL is
 *                cleaned at once, the hash restored
 *   requests   → the id token is the bearer on every call; it is refreshed with
 *                the refresh token shortly before it expires (InitiateAuth)
 *   sign out   → the session is cleared, the refresh token revoked, and the
 *                browser sent to `${domain}/logout`, which forgets the pages'
 *                own sign-in and returns
 *
 * The session is the browser's, not the tab's: every console tab reads the one
 * in localStorage and follows it (the `storage` event) as another tab signs
 * in, refreshes or signs out. One tab at a time refreshes (a Web Lock), and
 * the tabs waiting on it take its answer, so the refresh token is used once.
 */

/** The browser's session, in localStorage: every tab shares it. */
export const SESSION_KEY = 'shipyard.console.session';
/** This tab's sign-in attempt (its state and the hash to return to), in sessionStorage. */
export const SIGN_IN_KEY = 'shipyard.console.sign-in';
/** The Web Lock a tab holds while it refreshes the session. */
export const REFRESH_LOCK = 'shipyard.console.refresh';
/** A token this close to expiry is refreshed before it is used. */
export const REFRESH_AHEAD_MS = 60_000;
/** How long sign-out waits for Cognito to revoke the refresh token before it leaves anyway. */
export const REVOKE_WAIT_MS = 3_000;

export interface Operator {
  sub: string;
  email: string | null;
  name: string;
}

export interface Session {
  idToken: string;
  accessToken: string | null;
  refreshToken: string | null;
  /** Epoch millis the id token expires. */
  expiresAt: number;
  operator: Operator | null;
}

interface Tokens {
  id_token: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  expires_in?: string | number | null;
}

// ── Cognito's user pool API, from the browser ────────────────────────────────

interface CognitoError extends Error {
  code?: string;
}

async function cognitoCall(region: string, action: string, body: unknown, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${action}` },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw Object.assign(new Error(`Cognito could not be reached: ${(error as Error).message}`), { code: 'NETWORK' });
  }
  let json: Record<string, unknown> | null = null;
  try { json = await res.json() as Record<string, unknown>; } catch { /* no body */ }
  if (!res.ok) {
    const type = String(json?.['__type'] ?? res.headers.get('x-amzn-errortype') ?? '').split('#').pop()!.split(':')[0];
    throw Object.assign(new Error(String(json?.['message'] ?? json?.['Message'] ?? `Cognito answered ${res.status}`)), { code: type || `HTTP_${res.status}` });
  }
  return json ?? {};
}

/** Fresh tokens for a refresh token (Cognito answers no new refresh token, so the one given is kept). */
async function refreshTokens(cognito: CognitoConfig, refreshToken: string, fetchImpl: typeof fetch): Promise<Tokens> {
  const answer = await cognitoCall(cognito.region, 'InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: cognito.clientId, AuthParameters: { REFRESH_TOKEN: refreshToken },
  }, fetchImpl);
  const result = answer['AuthenticationResult'] as Record<string, unknown> | undefined;
  if (!result?.['IdToken']) throw Object.assign(new Error('Cognito answered no tokens'), { code: 'NO_TOKENS' });
  return {
    id_token: String(result['IdToken']),
    access_token: typeof result['AccessToken'] === 'string' ? result['AccessToken'] : null,
    refresh_token: typeof result['RefreshToken'] === 'string' ? result['RefreshToken'] : refreshToken,
    expires_in: Number(result['ExpiresIn']) || 3600,
  };
}

/** End a refresh token, and every token it gave, everywhere. */
function revokeToken(cognito: CognitoConfig, refreshToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  return cognitoCall(cognito.region, 'RevokeToken', { Token: refreshToken, ClientId: cognito.clientId }, fetchImpl);
}

// ── The session ──────────────────────────────────────────────────────────────

/** A JWT's payload, without verifying it (the platform verifies; the console only reads who it is). */
export function decodeClaims(token: string | null | undefined): Record<string, unknown> | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The operator an id token's claims name. The pool signs in by email, which is what names the person. */
export function operatorOf(claims: Record<string, unknown> | null): Operator | null {
  const sub = typeof claims?.['sub'] === 'string' ? claims['sub'] : null;
  const email = typeof claims?.['email'] === 'string' ? claims['email'] : null;
  if (!sub && !email) return null;
  return { sub: sub ?? email!, email, name: email ?? sub! };
}

/** The session the sign-in pages' tokens (or a refresh) become. */
export function sessionFromTokens(tokens: Tokens | null, now: number, previous: Session | null = null): Session | null {
  const idToken = tokens?.id_token ?? null;
  if (!idToken) return null;
  const claims = decodeClaims(idToken);
  const exp = typeof claims?.['exp'] === 'number' ? claims['exp'] * 1000 : now + (Number(tokens?.expires_in) || 3600) * 1000;
  return {
    idToken,
    accessToken: tokens?.access_token ?? null,
    refreshToken: tokens?.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: exp,
    operator: operatorOf(claims),
  };
}

export const isExpiring = (session: Session | null, now: number): boolean => session !== null && session.expiresAt - REFRESH_AHEAD_MS <= now;
export const isExpired = (session: Session | null, now: number): boolean => session !== null && session.expiresAt <= now;

/** The tokens the sign-in pages handed back in the fragment (`#state=…&id_token=…`), else null. A console route (`#/…`) is none. */
export function readHandOff(hash: string | null | undefined): { state: string | null; tokens: Tokens } | null {
  const h = String(hash ?? '');
  if (!h.startsWith('#') || h.startsWith('#/')) return null;
  const q = new URLSearchParams(h.slice(1));
  if (!q.get('id_token')) return null;
  return {
    state: q.get('state'),
    tokens: { id_token: q.get('id_token'), access_token: q.get('access_token'), refresh_token: q.get('refresh_token'), expires_in: q.get('expires_in') },
  };
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type StartOutcome =
  /** Signed in: tokens handed back, or the browser's session. */
  | { ok: true; operator: Operator | null }
  /** Sent to the sign-in pages; the page is leaving. */
  | { redirected: true }
  /** The hand-back was refused and the browser has no session. */
  | { ok: false; error: string };

export interface Auth {
  readonly operator: Operator | null;
  start(): Promise<StartOutcome>;
  /** The id token to send, refreshed first when it is about to expire; null when no one is signed in. */
  idToken(): Promise<string | null>;
  /** Sign in again (a 401, or Try again after a refused hand-back), returning to `returnTo`. */
  signIn(returnTo?: string | null): Promise<StartOutcome>;
  signOut(): Promise<void>;
  /** Follow the operator as the session changes, here or in another tab; returns the unsubscribe. */
  onChange(listener: (operator: Operator | null) => void): () => void;
}

export function createAuth(cognito: CognitoConfig, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Auth {
  const storage = globalThis.localStorage;
  const tabStorage = globalThis.sessionStorage;
  const listeners = new Set<(operator: Operator | null) => void>();
  let session = readSession();
  let refreshing: Promise<string | null> | null = null;
  /** The browser had no room for the session: this page keeps its own. */
  let pageOnly = false;

  function readSession(): Session | null {
    try {
      const raw = storage?.getItem(SESSION_KEY);
      const stored = raw ? JSON.parse(raw) as Session : null;
      if (!stored?.idToken) return null;
      // Read from the token each time, so the operator is always who the token says.
      stored.operator = operatorOf(decodeClaims(stored.idToken)) ?? stored.operator ?? null;
      return stored;
    } catch {
      return null;
    }
  }
  function notify(): void {
    for (const listener of listeners) { try { listener(session?.operator ?? null); } catch { /* a listener's problem */ } }
  }
  function writeSession(next: Session | null): void {
    session = next;
    try {
      if (next) storage?.setItem(SESSION_KEY, JSON.stringify(next));
      else storage?.removeItem(SESSION_KEY);
      pageOnly = false;
    } catch {
      pageOnly = next !== null;
    }
    notify();
  }

  const redirectUri = (): string => cognito.redirectUri ?? `${location.origin}${location.pathname}`;
  const signInUrl = (state: string): string => `${cognito.domain}/?${new URLSearchParams({ redirect_uri: redirectUri(), state }).toString()}`;
  const logoutUrl = (): string => `${cognito.domain}/logout?${new URLSearchParams({ redirect_uri: redirectUri() }).toString()}`;

  /**
   * Follow the browser's session as another tab left it; true when it had
   * moved on. Signed out there, this tab leaves too, through the sign-in
   * pages' logout.
   */
  function follow(): boolean {
    if (!storage || pageOnly) return false;
    const was = session;
    const next = readSession();
    if ((next?.idToken ?? null) === (was?.idToken ?? null)) return false;
    session = next;
    notify();
    if (was && !next) location.assign(logoutUrl());
    return true;
  }
  globalThis.addEventListener?.('storage', (event) => {
    if (event.key === SESSION_KEY || event.key === null) follow();
  });

  /** `fn` under the refresh lock, so one tab refreshes at a time. */
  const underLock = <T>(fn: () => Promise<T>): Promise<T> =>
    (navigator.locks?.request ? navigator.locks.request(REFRESH_LOCK, () => fn()) as Promise<T> : fn());

  async function refresh(): Promise<string | null> {
    follow();
    const tried = session;
    if (!tried?.refreshToken || !isExpiring(tried, Date.now())) return tried?.idToken ?? null;
    // Another tab signed in or out while Cognito answered: that is newer than this refresh.
    const movedOn = (): boolean => follow() || session?.idToken !== tried.idToken;
    try {
      const fresh = sessionFromTokens(await refreshTokens(cognito, tried.refreshToken, fetchImpl), Date.now(), tried);
      if (!movedOn()) writeSession(fresh);
    } catch (error) {
      if (!movedOn()) {
        // A refresh token Cognito refuses ends the session; Cognito out of reach ends nothing.
        if ((error as CognitoError).code !== 'NotAuthorizedException') throw error;
        writeSession(null);
      }
    }
    return session?.idToken ?? null;
  }

  function beginSignIn(returnTo: string | null = null): StartOutcome {
    const state = randomState();
    try { tabStorage?.setItem(SIGN_IN_KEY, JSON.stringify({ state, returnTo: returnTo ?? location.hash ?? '', at: Date.now() })); } catch { /* no storage */ }
    location.assign(signInUrl(state));
    return { redirected: true };
  }

  function finishHandOff(handOff: { state: string | null; tokens: Tokens }): void {
    const readKept = (): { state?: string; returnTo?: string } | null => {
      try { return JSON.parse(tabStorage?.getItem(SIGN_IN_KEY) ?? 'null') as { state?: string; returnTo?: string } | null; } catch { return null; }
    };
    const kept = readKept();
    try { tabStorage?.removeItem(SIGN_IN_KEY); } catch { /* no storage */ }
    // The tokens leave the URL before anything else: the page's history keeps only the cleaned address.
    const returnTo = kept?.returnTo && kept.returnTo !== '#' ? kept.returnTo : '';
    try { history.replaceState(null, '', `${location.pathname}${location.search}${returnTo}`); } catch { /* no history */ }
    if (!kept?.state) throw new Error('the sign-in was not started from this browser tab');
    if (handOff.state !== kept.state) throw new Error('the sign-in answer does not match the request');
    const next = sessionFromTokens(handOff.tokens, Date.now());
    if (!next) throw new Error('the sign-in pages handed back no id token');
    writeSession(next);
  }

  const auth: Auth = {
    get operator() { return session?.operator ?? null; },

    async start() {
      const handOff = readHandOff(location.hash);
      if (handOff) {
        try {
          finishHandOff(handOff);
          return { ok: true, operator: session?.operator ?? null };
        } catch (error) {
          // Refused tokens sign no one in; a browser already signed in (another tab) stays so.
          if (!session) return { ok: false, error: (error as Error).message };
        }
      }
      if (session && (!isExpired(session, Date.now()) || session.refreshToken)) {
        try { await auth.idToken(); } catch { /* Cognito out of reach: a token not yet expired still serves */ }
        if (session && !isExpired(session, Date.now())) return { ok: true, operator: session.operator };
      }
      return beginSignIn();
    },

    async idToken() {
      follow();
      if (!session) return null;
      if (!isExpiring(session, Date.now())) return session.idToken;
      if (!session.refreshToken) return isExpired(session, Date.now()) ? null : session.idToken;
      refreshing ??= underLock(refresh).finally(() => { refreshing = null; });
      return refreshing;
    },

    async signIn(returnTo = null) {
      return beginSignIn(returnTo);
    },

    async signOut() {
      const refreshToken = session?.refreshToken ?? null;
      writeSession(null);
      if (refreshToken) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          revokeToken(cognito, refreshToken, fetchImpl).catch(() => undefined),
          new Promise((resolve) => { timer = setTimeout(resolve, REVOKE_WAIT_MS); }),
        ]);
        clearTimeout(timer);
      }
      location.assign(logoutUrl());
    },

    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return auth;
}
