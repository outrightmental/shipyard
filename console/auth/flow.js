/**
 * The sign-in pages' flow, with no DOM: page.js draws each step this
 * returns and calls back with what the operator typed.
 *
 * The console sends the browser here with `?redirect_uri=<console>&state=<random>`.
 * The pages sign in against the user pool with Cognito's API (the password
 * flow, then whatever challenge Cognito answers: the new password an invited
 * operator chooses, an MFA code, setting up an authenticator app), or reset a
 * forgotten password with the code Cognito emails. Signed in, the tokens go
 * back to the console in the URL's fragment, with the state:
 *
 *   <redirect_uri>#state=…&id_token=…&access_token=…&refresh_token=…&expires_in=…
 *
 * A fragment never reaches a server, and the console takes it out of the URL
 * at once. The redirect URI must be one config.json names exactly, so the
 * tokens can only ever go to the console. `/logout?redirect_uri=…` forgets
 * the sign-in and returns.
 *
 * The pages remember a sign-in for as long as its refresh token lives
 * (config.json's `rememberDays`; an hour without it), in this origin's
 * localStorage, as Cognito's hosted pages kept a session cookie: a console tab
 * that arrives without a session is handed tokens straight back, without the
 * password. A tab left on the form signs in as soon as another tab of
 * the pages does (`rememberedElsewhere`).
 */
import { cognitoCall, refreshTokens, revokeToken, tokensOf } from './cognito.js';

export const REMEMBER_KEY = 'shipyard.auth.session';
/** How long a sign-in is remembered when config.json does not say. */
export const REMEMBER_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The MFA challenges answered with a code, and the response each code goes in. */
export const CODE_CHALLENGES = Object.freeze({
  SOFTWARE_TOKEN_MFA: 'SOFTWARE_TOKEN_MFA_CODE',
  SMS_MFA:            'SMS_MFA_CODE',
  EMAIL_OTP:          'EMAIL_OTP_CODE',
});

const coded = (code, message) => Object.assign(new Error(message), { code });

/**
 * config.json as the pages keep it. `redirectUris` are the console URLs the
 * tokens may go to, the first the console itself; `passwordPolicy` is the
 * pool's, so a new password is checked before Cognito is asked; `rememberDays`
 * is how long the app client's refresh token lives, and so how long a sign-in
 * is remembered (`rememberMs`).
 */
export function normalizeAuthConfig(raw) {
  const redirectUris = Array.isArray(raw?.redirectUris) ? raw.redirectUris.map(String).filter(Boolean) : [];
  if (!raw?.region || !raw?.clientId || !redirectUris.length) throw coded('CONFIG', 'The sign-in pages are not configured.');
  const p = raw.passwordPolicy ?? {};
  return {
    region:         String(raw.region),
    clientId:       String(raw.clientId),
    redirectUris,
    rememberMs:     Number(raw.rememberDays) > 0 ? Number(raw.rememberDays) * DAY_MS : REMEMBER_MS,
    passwordPolicy: {
      minimumLength:    Number(p.minimumLength) || 8,
      requireLowercase: p.requireLowercase === true,
      requireUppercase: p.requireUppercase === true,
      requireNumbers:   p.requireNumbers === true,
      requireSymbols:   p.requireSymbols === true,
    },
  };
}

/**
 * What the page was opened for: `{ action: 'sign-in' | 'sign-out', redirectUri, state }`.
 * A redirect URI config.json does not name is refused; none at all is the
 * console's own (the pages opened by hand), with no state.
 */
export function readRequest(config, { pathname = '/', search = '' } = {}) {
  const q = new URLSearchParams(search);
  const asked = q.get('redirect_uri');
  if (asked && !config.redirectUris.includes(asked)) throw coded('REDIRECT_NOT_ALLOWED', 'This sign-in was not asked for by the console.');
  const action = /\/logout\/?$/.test(pathname) ? 'sign-out' : 'sign-in';
  return { action, redirectUri: asked ?? config.redirectUris[0], state: q.get('state') ?? null };
}

/** Where the browser goes with the tokens: the console, the tokens and the state in the fragment. */
export function handOffUrl(redirectUri, state, tokens) {
  const f = new URLSearchParams();
  if (state) f.set('state', state);
  f.set('id_token', tokens.id_token);
  if (tokens.access_token) f.set('access_token', tokens.access_token);
  if (tokens.refresh_token) f.set('refresh_token', tokens.refresh_token);
  f.set('expires_in', String(tokens.expires_in ?? 3600));
  return `${redirectUri.split('#')[0]}#${f}`;
}

/** What a new password still lacks under the pool's policy, as phrases; empty when it is fine. */
export function passwordProblems(policy, password) {
  const p = String(password ?? '');
  const lacks = [];
  if (p.length < policy.minimumLength) lacks.push(`at least ${policy.minimumLength} characters`);
  if (policy.requireLowercase && !/[a-z]/.test(p)) lacks.push('a lower-case letter');
  if (policy.requireUppercase && !/[A-Z]/.test(p)) lacks.push('an upper-case letter');
  if (policy.requireNumbers && !/[0-9]/.test(p)) lacks.push('a number');
  if (policy.requireSymbols && !/[\^$*.[\]{}()?"!@#%&/\\,><':;|_~`=+-]/.test(p)) lacks.push('a symbol');
  return lacks;
}

/** Whether a `storage` event is another tab of the pages remembering a sign-in, which this one can resume. */
export const rememberedElsewhere = event => event?.key === REMEMBER_KEY && Boolean(event.newValue);

/** Phrases as a list in a sentence: `a, b and c`. */
export const listOf = phrases => phrases.join(', ').replace(/, ([^,]*)$/, ' and $1');

/** The policy as one sentence for under a new-password field. */
export function passwordHint(policy) {
  return `Use ${listOf(passwordProblems(policy, ''))}.`;
}

/** A Cognito error as a sentence for the operator. */
export function messageOf(err) {
  switch (err?.code) {
    case 'NotAuthorizedException':
      if (/incorrect username or password/i.test(err.message)) return 'Incorrect email or password.';
      if (/session is expired/i.test(err.message)) return 'This sign-in took too long. Start again.';
      return err.message;
    case 'UserNotFoundException':     return 'Incorrect email or password.';
    case 'CodeMismatchException':     return 'That code is not right. Check it and try again.';
    case 'ExpiredCodeException':      return 'That code has expired. Ask for a new one.';
    case 'EnableSoftwareTokenMFAException': return 'That code is not right. Check the app and try again.';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException': return 'Too many attempts. Wait a few minutes and try again.';
    case 'InvalidPasswordException':  return err.message.replace(/^Password does not conform to policy: /, '');
    case 'NETWORK':                   return 'The sign-in service could not be reached. Check your connection and try again.';
    default:                          return err?.message || 'Something went wrong. Try again.';
  }
}

/**
 * The flow for one page. Every method resolves to the next step:
 *
 *   { kind: 'done', tokens }                              signed in: hand the tokens to the console
 *   { kind: 'new-password', … }                           an invited operator chooses a password
 *   { kind: 'code', challenge, destination, … }           an MFA code (app, SMS or email)
 *   { kind: 'choose-mfa', options, … }                    which MFA to use this time
 *   { kind: 'mfa-setup', secret, uri, … }                 add the account to an authenticator app
 *   { kind: 'reset', email, destination, required }       the emailed code and a new password
 *
 * and rejects with Cognito's coded error (messageOf says it to the operator).
 */
export function createFlow(config, { fetchImpl = globalThis.fetch, storage = globalThis.localStorage, now = Date.now, issuer = 'Shipyard' } = {}) {
  const api = { region: config.region, clientId: config.clientId, fetchImpl };
  const call = (action, body) => cognitoCall(api, action, { ClientId: config.clientId, ...body });

  function stored() {
    try {
      const r = JSON.parse(storage?.getItem(REMEMBER_KEY) ?? 'null');
      return r?.refreshToken ? r : null;
    } catch { return null; }
  }
  const remembered = () => { const r = stored(); return r && r.until > now() ? r : null; };
  function remember(refreshToken) {
    try { if (refreshToken) storage?.setItem(REMEMBER_KEY, JSON.stringify({ refreshToken, until: now() + (config.rememberMs ?? REMEMBER_MS) })); } catch {}
  }
  function forget() {
    try { storage?.removeItem(REMEMBER_KEY); } catch {}
  }

  /** The step an InitiateAuth or RespondToAuthChallenge answer leads to. */
  async function next(answer, email) {
    if (answer.AuthenticationResult) {
      const tokens = tokensOf(answer.AuthenticationResult);
      if (!tokens) throw coded('NO_TOKENS', 'Cognito answered no tokens.');
      remember(tokens.refresh_token);
      return { kind: 'done', tokens };
    }
    const params = answer.ChallengeParameters ?? {};
    const base = { challenge: answer.ChallengeName, session: answer.Session, username: params.USER_ID_FOR_SRP ?? email, email };
    switch (answer.ChallengeName) {
      case 'NEW_PASSWORD_REQUIRED':
        return { ...base, kind: 'new-password' };
      case 'SOFTWARE_TOKEN_MFA':
      case 'SMS_MFA':
      case 'EMAIL_OTP':
        return { ...base, kind: 'code', destination: params.CODE_DELIVERY_DESTINATION ?? null };
      case 'SELECT_MFA_TYPE': {
        let options = [];
        try { options = JSON.parse(params.MFAS_CAN_CHOOSE ?? '[]'); } catch {}
        return { ...base, kind: 'choose-mfa', options: options.filter(o => o in CODE_CHALLENGES) };
      }
      case 'MFA_SETUP': {
        let can = [];
        try { can = JSON.parse(params.MFAS_CAN_SETUP ?? '[]'); } catch {}
        if (can.length && !can.includes('SOFTWARE_TOKEN_MFA')) throw coded('UNSUPPORTED_CHALLENGE', 'This account must set up a kind of MFA these pages do not offer.');
        const { SecretCode, Session } = await cognitoCall(api, 'AssociateSoftwareToken', { Session: answer.Session });
        const label = encodeURIComponent(`${issuer}:${email}`);
        return { ...base, kind: 'mfa-setup', session: Session, secret: SecretCode, uri: `otpauth://totp/${label}?secret=${SecretCode}&issuer=${encodeURIComponent(issuer)}` };
      }
      default:
        throw coded('UNSUPPORTED_CHALLENGE', `Cognito asked for ${answer.ChallengeName ?? 'something'}, which these pages do not offer.`);
    }
  }

  const respond = (step, responses) => call('RespondToAuthChallenge', {
    ChallengeName: step.challenge, Session: step.session, ChallengeResponses: { USERNAME: step.username, ...responses },
  }).then(answer => next(answer, step.email));

  return {
    /** A sign-in remembered from the last hour, refreshed: `{ kind: 'done', tokens }`, else null. */
    async resume() {
      const r = remembered();
      if (!r) { forget(); return null; }
      try {
        return { kind: 'done', tokens: await refreshTokens(api, r.refreshToken) };
      } catch {
        forget();
        return null;
      }
    },

    async signIn(email, password) {
      const e = String(email ?? '').trim();
      try {
        return await next(await call('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: e, PASSWORD: String(password ?? '') } }), e);
      } catch (err) {
        // An operator whose password an administrator reset has been emailed a code: they choose a new one with it.
        if (err.code === 'PasswordResetRequiredException') return { kind: 'reset', email: e, destination: null, required: true };
        throw err;
      }
    },

    newPassword(step, password) {
      return respond(step, { NEW_PASSWORD: String(password ?? '') });
    },

    code(step, code) {
      return respond(step, { [CODE_CHALLENGES[step.challenge]]: String(code ?? '').trim() });
    },

    chooseMfa(step, option) {
      return respond(step, { ANSWER: option });
    },

    async setUpMfa(step, code) {
      const { Session } = await cognitoCall(api, 'VerifySoftwareToken', { Session: step.session, UserCode: String(code ?? '').trim(), FriendlyDeviceName: issuer });
      return respond({ ...step, session: Session }, {});
    },

    async forgotPassword(email) {
      const e = String(email ?? '').trim();
      const answer = await call('ForgotPassword', { Username: e });
      return { kind: 'reset', email: e, destination: answer.CodeDeliveryDetails?.Destination ?? null, required: false };
    },

    /** Set the new password with the emailed code, then sign in with it. */
    async resetPassword(step, code, password) {
      await call('ConfirmForgotPassword', { Username: step.email, ConfirmationCode: String(code ?? '').trim(), Password: String(password ?? '') });
      return this.signIn(step.email, password);
    },

    /** Forget the remembered sign-in and end its refresh token (best effort: the pages leave either way). */
    async signOut() {
      const r = stored();
      forget();
      if (r) { try { await revokeToken(api, r.refreshToken); } catch {} }
    },
  };
}
