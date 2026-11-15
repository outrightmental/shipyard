/**
 * The sign-in pages: draws each step of flow.js in the card under the
 * mark, and sends the browser back to the console once signed in. Every
 * node is built with textContent, never markup, and nothing is inline: the
 * pages' Content-Security-Policy (infra/auth.tf) allows only this origin's
 * files and Cognito's API.
 */
import { createFlow, handOffUrl, listOf, messageOf, normalizeAuthConfig, passwordHint, passwordProblems, readRequest, rememberedElsewhere } from './flow.js';

/** An element: `h('input', { type: 'email', required: true })`; `on…` props are listeners. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  el.append(...children.flat().filter(c => c != null && c !== false));
  return el;
}

const MFA_NAMES = { SOFTWARE_TOKEN_MFA: 'Authenticator app', SMS_MFA: 'Text message', EMAIL_OTP: 'Email' };

let card = null;
let flow = null;
let request = null;
let config = null;
let leaving = false;

function show(...nodes) {
  card.replaceChildren(...nodes.filter(n => n != null));
  card.querySelector('[autofocus]')?.focus();
}

function busy(text) {
  show(h('p', { class: 'busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text));
}

function field({ label, name, hint = null, ...input }) {
  const id = `f-${name}`;
  return h('div', { class: 'field' },
    h('label', { for: id }, label),
    h('input', { id, name, ...input }),
    hint ? h('p', { class: 'hint' }, hint) : null);
}

const banner = error => error ? h('p', { class: 'banner', role: 'alert' }, error) : null;
const link = (text, onclick) => h('button', { type: 'button', class: 'link', onclick }, text);

/**
 * A step's card: its title, a line under it, the error, a form of fields with
 * one primary action, and the links under it. `submit(values)` resolves to the
 * next step; a rejection is shown on this card (or, when Cognito has dropped
 * the challenge, on the sign-in card).
 */
function screen({ title, lede = null, error = null, fields = [], action, submit, links = [], extra = null }) {
  const button = h('button', { type: 'submit', class: 'primary' }, action);
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      if (button.disabled) return;
      const values = Object.fromEntries(new FormData(form));
      button.disabled = true;
      try {
        await submit(values);
      } finally {
        button.disabled = false;
      }
    },
  }, banner(error), extra, fields.map(field), h('div', { class: 'actions' }, button));
  show(h('h2', {}, title), lede ? h('p', { class: 'lede' }, lede) : null, form, links.length ? h('div', { class: 'links' }, links) : null);
}

/** Go to a step, or back to the console when signed in. */
function go(step, error = null) {
  if (step.kind === 'done') {
    if (leaving) return;
    leaving = true;
    busy('Signed in. Back to the console…');
    location.replace(handOffUrl(request.redirectUri, request.state, step.tokens));
    return;
  }
  (SCREENS[step.kind] ?? SCREENS['sign-in'])(step, error);
}

/** Run a flow call; its next step, or this step again with the error. */
async function attempt(step, run) {
  try {
    go(await run());
  } catch (err) {
    const dropped = err.code === 'NotAuthorizedException' && step.session;
    go(dropped ? { kind: 'sign-in', email: step.email } : step, messageOf(err));
  }
}

/** A new password and its confirmation, checked against the pool's policy before Cognito is asked. */
function newPasswordFields() {
  return [
    { label: 'New password', name: 'password', type: 'password', autocomplete: 'new-password', required: true, hint: passwordHint(config.passwordPolicy) },
    { label: 'Confirm the password', name: 'confirm', type: 'password', autocomplete: 'new-password', required: true },
  ];
}
function passwordError({ password, confirm }) {
  const lacks = passwordProblems(config.passwordPolicy, password);
  if (lacks.length) return `The password needs ${listOf(lacks)}.`;
  if (password !== confirm) return 'The two passwords differ.';
  return null;
}

const SCREENS = {
  'sign-in': (step, error) => screen({
    title: 'Sign in',
    lede: 'to the Shipyard console',
    error,
    fields: [
      { label: 'Email', name: 'email', type: 'email', autocomplete: 'username', required: true, value: step.email ?? '', autofocus: !step.email },
      { label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', required: true, autofocus: !!step.email },
    ],
    action: 'Sign in',
    // The email stays typed when the card is drawn again with an error.
    submit: ({ email, password }) => attempt({ ...step, email }, () => flow.signIn(email, password)),
    links: [link('Forgot your password?', () => go({ kind: 'forgot', email: card.querySelector('[name=email]')?.value ?? step.email }))],
  }),

  'new-password': (step, error) => screen({
    title: 'Choose your password',
    lede: `Welcome${step.email ? `, ${step.email}` : ''}. Choose the password you will sign in with from now on.`,
    error,
    fields: newPasswordFields().map((f, i) => ({ ...f, autofocus: i === 0 })),
    action: 'Set password',
    submit: values => {
      const problem = passwordError(values);
      return problem ? go(step, problem) : attempt(step, () => flow.newPassword(step, values.password));
    },
  }),

  code: (step, error) => screen({
    title: 'Enter your code',
    lede: step.challenge === 'SOFTWARE_TOKEN_MFA' ? 'Enter the code your authenticator app shows for Shipyard.'
      : `Enter the code we ${step.challenge === 'SMS_MFA' ? 'texted' : 'emailed'} to ${step.destination ?? 'you'}.`,
    error,
    fields: [{ label: 'Code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, autofocus: true }],
    action: 'Continue',
    submit: ({ code }) => attempt(step, () => flow.code(step, code)),
    links: [link('Back to sign in', () => go({ kind: 'sign-in', email: step.email }))],
  }),

  'choose-mfa': (step, error) => {
    const choices = step.options.map(option => h('button', {
      type: 'button', class: 'choice', onclick: () => attempt(step, () => flow.chooseMfa(step, option)),
    }, MFA_NAMES[option] ?? option));
    show(h('h2', {}, 'How should we check it is you?'), banner(error), h('div', { class: 'choices' }, choices),
      h('div', { class: 'links' }, link('Back to sign in', () => go({ kind: 'sign-in', email: step.email }))));
  },

  'mfa-setup': (step, error) => screen({
    title: 'Set up your authenticator app',
    lede: 'This account signs in with a second step. Add it to your authenticator app with this key, then enter the code the app shows.',
    error,
    extra: h('div', { class: 'secret' },
      h('code', {}, step.secret.replace(/(.{4})/g, '$1 ').trim()),
      h('a', { href: step.uri }, 'Open in an authenticator app')),
    fields: [{ label: 'Code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, autofocus: true }],
    action: 'Continue',
    submit: ({ code }) => attempt(step, () => flow.setUpMfa(step, code)),
  }),

  forgot: (step, error) => screen({
    title: 'Reset your password',
    lede: 'Enter your email and we will send you a code to choose a new password with.',
    error,
    fields: [{ label: 'Email', name: 'email', type: 'email', autocomplete: 'username', required: true, value: step.email ?? '', autofocus: true }],
    action: 'Send code',
    submit: ({ email }) => attempt({ ...step, email }, () => flow.forgotPassword(email)),
    links: [link('Back to sign in', () => go({ kind: 'sign-in', email: card.querySelector('[name=email]')?.value ?? step.email }))],
  }),

  reset: (step, error) => screen({
    title: 'Choose a new password',
    lede: step.required ? 'Your password was reset. Enter the code we emailed you and choose a new password.'
      : `We sent a code to ${step.destination ?? 'your email'}. Enter it and choose a new password.`,
    error,
    fields: [
      { label: 'Code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, autofocus: true },
      ...newPasswordFields(),
    ],
    action: 'Set password and sign in',
    submit: values => {
      const problem = passwordError(values);
      return problem ? go(step, problem) : attempt(step, () => flow.resetPassword(step, values.code, values.password));
    },
    links: [
      link('Send a new code', () => attempt(step, () => flow.forgotPassword(step.email))),
      link('Back to sign in', () => go({ kind: 'sign-in', email: step.email })),
    ],
  }),
};

async function boot() {
  card = document.getElementById('card');
  busy('One moment…');
  try {
    const res = await fetch('config.json', { cache: 'no-store', headers: { accept: 'application/json' } });
    config = normalizeAuthConfig(res.ok ? await res.json() : null);
    request = readRequest(config, location);
  } catch (err) {
    show(h('h2', {}, 'Sign-in unavailable'), banner(err.code === 'REDIRECT_NOT_ALLOWED' || err.code === 'CONFIG' ? err.message : 'The sign-in pages could not start.'));
    return;
  }
  flow = createFlow(config);

  if (request.action === 'sign-out') {
    busy('Signing out…');
    await flow.signOut();
    location.replace(request.redirectUri);
    return;
  }
  // Opened by hand, not by the console: the console starts its own sign-in, with a state, and comes back.
  if (!request.state) {
    location.replace(request.redirectUri);
    return;
  }
  const resumed = await flow.resume();
  go(resumed ?? { kind: 'sign-in' });
  // Signed in in another tab meanwhile: this one is too, back to its own console tab, without the password again.
  addEventListener('storage', async e => {
    if (leaving || !rememberedElsewhere(e)) return;
    const step = await flow.resume();
    if (step) go(step);
  });
}

boot();
