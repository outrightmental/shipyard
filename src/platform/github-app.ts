import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { AvailableRepo, GitHubStatus } from "../shared/protocol.js";
import { iso, refuse, type Platform } from "./platform.js";
import type { Row } from "./store.js";

/**
 * Shipyard on GitHub: a GitHub App the operator creates from the console and
 * installs on the organization.
 *
 * An app, rather than a person's token, for three reasons. Its access is the
 * repositories it is installed on and the permissions it asks for, not
 * everything its owner can reach. Its work is its own on GitHub — the pull
 * requests and comments are the app's, not a person's. And its credentials
 * can be minted short: a fleet member holds no GitHub credential at all, and
 * asks the platform for a token that lasts an hour and reaches only the
 * repositories assigned to it.
 *
 * Connecting is GitHub's manifest flow, so nothing secret is ever typed or
 * pasted:
 *
 *   1. the console posts a manifest (what the app is and what it may do) to
 *      GitHub, in the operator's browser, with a state the platform remembers;
 *   2. the operator confirms; GitHub sends the browser back with a code;
 *   3. the platform redeems the code for the app: its id, its private key,
 *      its webhook secret. The key and secrets go to SSM, the ids to the table;
 *   4. the operator installs the app on the organization, choosing which
 *      repositories it sees, and the platform finds the installation.
 *
 * Rows: `CONFIG/github` (the app's ids, its installation), `CONFIG/github-pending`
 * (the state of a manifest sent and not yet redeemed).
 */

const CONFIG = "CONFIG";
const APP = "github";
const PENDING = "github-pending";
/**
 * Where an app's credentials are kept among the platform's secrets: under a
 * name of the app's own, so what is kept under a name never changes.
 *
 * It was one name for whichever app was connected, and the function keeps a
 * secret it has read in memory for a few minutes. On 2026-11-15 an operator
 * connected an app, disconnected it, and connected another: for five minutes
 * every instance of the function that had read the first app's key went on
 * signing the second app's requests with it, and GitHub refused them all
 * ("A JSON web token could not be decoded"). With a name per app there is
 * nothing to go stale: a different app is a different name, read afresh.
 */
export const secretNameFor = (appId: number): string => `github-app-${appId}`;

/**
 * The one name the app's credentials were kept under before each had its own.
 * Read for an app that has none under its own name — the one connected
 * before this — and never written.
 */
export const LEGACY_SECRET_NAME = "github-app";
const GITHUB_API = "https://api.github.com";
const PENDING_MS = 60 * 60_000;

/**
 * What the app may do, which is what Shipyard does with a token today:
 * read and write code, issues and pull requests; read checks and statuses;
 * approve and cancel workflow runs, and push a branch that changes a workflow;
 * and, for Project SDLC, move items on the organization's project boards and
 * ask its members for review.
 */
export const APP_PERMISSIONS: Readonly<Record<string, string>> = {
  metadata: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
  actions: "write",
  workflows: "write",
  organization_projects: "write",
  members: "read",
};

interface AppRow extends Row {
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  org: string;
  clientId: string;
  installationId: number | null;
  installationAccount: string | null;
  repositorySelection: string | null;
  installationUrl: string | null;
  connectedAt: string;
  connectedBy: string | null;
  /** The id of the app's bot user, which is not the app's id: what GitHub attributes its commits by. */
  botUserId?: number | null;
}

interface AppSecrets {
  pem: string;
  webhookSecret: string;
  clientSecret: string;
}

function cleanOrg(value: unknown): string {
  const org = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org)) {
    return refuse(400, "ORG_REQUIRED", "name the GitHub organization the app is for, as it is spelled in its URL");
  }
  return org;
}

async function appRow(p: Platform): Promise<AppRow | null> {
  return (await p.table.get(CONFIG, APP)) as AppRow | null;
}

async function appSecrets(p: Platform, app: Pick<AppRow, "appId">): Promise<AppSecrets | null> {
  const raw = (await p.secrets.get(secretNameFor(app.appId))) ?? (await p.secrets.get(LEGACY_SECRET_NAME));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AppSecrets;
  } catch {
    return null;
  }
}

export function statusOf(row: AppRow | null): GitHubStatus {
  if (!row) return { connected: false, org: null, app: null, installation: null };
  return {
    connected: true,
    org: row.org,
    app: {
      id: row.appId,
      slug: row.slug,
      name: row.name,
      htmlUrl: row.htmlUrl,
      installUrl: `${row.htmlUrl.replace(/\/+$/, "")}/installations/new`,
    },
    installation: row.installationId === null || row.installationId === undefined ? null : {
      id: row.installationId,
      account: row.installationAccount ?? row.org,
      repositorySelection: row.repositorySelection ?? "selected",
      htmlUrl: row.installationUrl ?? "",
    },
  };
}

export async function githubStatus(p: Platform): Promise<GitHubStatus> {
  return statusOf(await appRow(p));
}

/** Whether the platform can mint a token: the app exists and is installed somewhere. */
export async function githubReady(p: Platform): Promise<boolean> {
  const row = await appRow(p);
  return row !== null && row.installationId !== null && row.installationId !== undefined;
}

/**
 * What a fleet member is told of GitHub: whether a token can be minted for
 * it, and who its commits are by. The app's bot user, `<slug>[bot]`, with the
 * no-reply address GitHub links to it — which carries the bot's user id when
 * that is known, as GitHub's own does.
 */
export async function githubForMembers(p: Platform): Promise<{ ready: boolean; git: { name: string; email: string } | null }> {
  const row = await appRow(p);
  if (!row) return { ready: false, git: null };
  const name = `${row.slug}[bot]`;
  const email = typeof row.botUserId === "number"
    ? `${row.botUserId}+${name}@users.noreply.github.com`
    : `${name}@users.noreply.github.com`;
  return { ready: row.installationId !== null && row.installationId !== undefined, git: { name, email } };
}

/** The id of the app's bot user, asked of GitHub's public API; null when it cannot be had. */
async function botUserId(p: Platform, slug: string): Promise<number | null> {
  try {
    const res = await p.fetch(`${GITHUB_API}/users/${encodeURIComponent(`${slug}[bot]`)}`, { headers: githubHeaders() });
    if (!res.ok) return null;
    const user = await res.json() as { id?: unknown };
    return typeof user.id === "number" ? user.id : null;
  } catch {
    return null;
  }
}

// ── Connecting: the manifest flow ────────────────────────────────────────────

/**
 * The manifest for the organization's app, and where the operator's browser
 * posts it. The state is remembered for an hour: only a code that comes back
 * with it is redeemed.
 */
export async function beginManifest(p: Platform, input: { org?: unknown }): Promise<{ action: string; manifest: Record<string, unknown>; state: string }> {
  if (await appRow(p)) {
    return refuse(409, "ALREADY_CONNECTED", "Shipyard is already connected to GitHub", "disconnect it first to connect a different app");
  }
  const org = cleanOrg(input.org);
  const state = p.random(16);
  await p.table.put({
    PK: CONFIG,
    SK: PENDING,
    state,
    org,
    ttl: Math.floor((p.now() + PENDING_MS) / 1000),
    expiresAtMs: p.now() + PENDING_MS,
  });
  const url = p.settings.publicUrl.replace(/\/+$/, "");
  const manifest = {
    // App names are GitHub-wide; the organization's makes this one its own.
    name: `shipyard-${org}`.slice(0, 34),
    description: "Shipyard: coding agents working this organization's issue queues.",
    url,
    hook_attributes: { url: `${url}/hooks/github`, active: true },
    redirect_url: `${url}/`,
    setup_url: `${url}/?github=installed`,
    setup_on_update: true,
    public: false,
    default_permissions: APP_PERMISSIONS,
    // Installation events arrive whatever is listed; nothing else is asked for yet.
    default_events: [],
  };
  return {
    action: `https://github.com/organizations/${org}/settings/apps/new?state=${state}`,
    manifest,
    state,
  };
}

/** Redeem the code GitHub sent the operator back with for the app itself. */
export async function completeManifest(p: Platform, input: { code?: unknown; state?: unknown }, by: string | null): Promise<GitHubStatus> {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  const state = typeof input.state === "string" ? input.state : "";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) return refuse(400, "CODE_REQUIRED", "GitHub's code is missing");
  const pending = await p.table.get(CONFIG, PENDING);
  const expiresAtMs = pending?.["expiresAtMs"];
  if (!pending || pending["state"] !== state || typeof expiresAtMs !== "number" || expiresAtMs <= p.now()) {
    return refuse(403, "STATE_MISMATCH", "this is not the answer to a connection Shipyard started", "start again from Repositories, Connect GitHub");
  }
  if (await appRow(p)) return refuse(409, "ALREADY_CONNECTED", "Shipyard is already connected to GitHub");

  const res = await p.fetch(`${GITHUB_API}/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: githubHeaders(),
  });
  if (!res.ok) {
    return refuse(502, "GITHUB_REFUSED", `GitHub would not create the app (${res.status})`, "the code lasts an hour and works once: start again from Repositories, Connect GitHub");
  }
  const app = await res.json() as {
    id: number; slug: string; name: string; html_url: string; client_id: string; client_secret: string;
    webhook_secret: string | null; pem: string; owner?: { login?: string };
  };
  const secrets: AppSecrets = { pem: app.pem, webhookSecret: app.webhook_secret ?? "", clientSecret: app.client_secret };
  // The key first: an app in the table whose key was never kept could do nothing.
  await p.secrets.put(secretNameFor(app.id), JSON.stringify(secrets));
  const row: AppRow = {
    PK: CONFIG,
    SK: APP,
    appId: app.id,
    slug: app.slug,
    name: app.name,
    htmlUrl: app.html_url,
    org: app.owner?.login ?? String(pending["org"]),
    clientId: app.client_id,
    installationId: null,
    installationAccount: null,
    repositorySelection: null,
    installationUrl: null,
    connectedAt: iso(p.now()),
    connectedBy: by,
    botUserId: await botUserId(p, app.slug),
  };
  await p.table.put(row);
  await p.table.delete(CONFIG, PENDING);
  return statusOf(row);
}

/**
 * Forget the app: its ids and its key. The app itself stays on GitHub until
 * the operator deletes it there; this only makes Shipyard stop being it.
 */
export async function disconnectGithub(p: Platform): Promise<void> {
  const row = await appRow(p);
  await p.table.delete(CONFIG, APP);
  await p.table.delete(CONFIG, PENDING);
  if (row) await p.secrets.delete(secretNameFor(row.appId));
  await p.secrets.delete(LEGACY_SECRET_NAME);
}

// ── Being the app ────────────────────────────────────────────────────────────

function githubHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "shipyard",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

const base64Url = (data: Buffer | string): string =>
  Buffer.from(data).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** A token that says "I am the app", good for ten minutes: what GitHub takes to mint an installation's. */
export function appJwt(appId: number, pem: string, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // A minute back, for a clock that runs ahead of GitHub's.
  const payload = base64Url(JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64Url(signer.sign(pem))}`;
}

async function asApp(p: Platform): Promise<{ row: AppRow; jwt: string }> {
  const row = await appRow(p);
  if (!row) return refuse(409, "GITHUB_NOT_CONNECTED", "Shipyard is not connected to GitHub", "connect it in the console: Repositories, Connect GitHub");
  const secrets = await appSecrets(p, row);
  if (!secrets?.pem) return refuse(500, "GITHUB_KEY_MISSING", "the GitHub App's key is missing", "disconnect GitHub in the console and connect it again");
  return { row, jwt: appJwt(row.appId, secrets.pem, p.now()) };
}

/**
 * Find where the app is installed and remember it. The organization's own
 * installation if it has one, else the only one there is.
 */
export async function refreshInstallation(p: Platform): Promise<GitHubStatus> {
  const { row, jwt } = await asApp(p);
  const res = await p.fetch(`${GITHUB_API}/app/installations?per_page=100`, { headers: githubHeaders(jwt) });
  if (!res.ok) return refuse(502, "GITHUB_REFUSED", `GitHub would not list the app's installations (${res.status})`);
  const installations = await res.json() as Array<{
    id: number; account?: { login?: string } | null; repository_selection?: string; html_url?: string; suspended_at?: string | null;
  }>;
  const live = installations.filter((installation) => !installation.suspended_at);
  const found = live.find((installation) => installation.account?.login?.toLowerCase() === row.org.toLowerCase()) ?? live[0] ?? null;
  const patch = {
    installationId: found?.id ?? null,
    installationAccount: found?.account?.login ?? null,
    repositorySelection: found?.repository_selection ?? null,
    installationUrl: found?.html_url ?? null,
  };
  const updated = (await p.table.update(CONFIG, APP, patch)) as AppRow | null;
  return statusOf(updated ?? { ...row, ...patch });
}

export interface InstallationToken {
  token: string;
  /** ISO time it stops working: an hour from when it was minted. */
  expiresAt: string;
}

/**
 * A token for the installation, which reaches only `repos` when they are
 * named ("owner/repo"; the owner is the installation's). GitHub mints it for
 * an hour.
 */
export async function installationToken(p: Platform, repos?: readonly string[]): Promise<InstallationToken> {
  const { row, jwt } = await asApp(p);
  if (row.installationId === null || row.installationId === undefined) {
    return refuse(409, "GITHUB_NOT_INSTALLED", "the GitHub App is not installed on the organization yet", "install it from the console: Repositories");
  }
  const names = repos?.map((repo) => repo.slice(repo.indexOf("/") + 1));
  const res = await p.fetch(`${GITHUB_API}/app/installations/${row.installationId}/access_tokens`, {
    method: "POST",
    headers: { ...githubHeaders(jwt), "content-type": "application/json" },
    body: JSON.stringify(names && names.length > 0 ? { repositories: names } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // 404: the installation is gone. 422: a repository named is not one it can see.
    if (res.status === 422 && repos && repos.length > 0) {
      // Which one, GitHub does not say. Finding out must never be what fails:
      // if it cannot be found out, GitHub's own words are passed on below.
      const refused = await refusedRepos(p, repos).catch(() => [] as RefusedRepo[]);
      if (refused.length > 0) {
        return refuse(502, "GITHUB_REPO_NOT_INSTALLED", `GitHub would not mint a token: ${refusedLine(refused)}`, refusedRemedy(refused));
      }
    }
    return refuse(
      502,
      res.status === 422 ? "GITHUB_REPO_NOT_INSTALLED" : "GITHUB_REFUSED",
      `GitHub would not mint a token (${res.status}): ${detail.slice(0, 200)}`,
      res.status === 422
        ? "the app is not installed on one of those repositories: add it on GitHub, in the app's installation settings"
        : "check the app is still installed on the organization",
    );
  }
  const body = await res.json() as { token: string; expires_at: string };
  return { token: body.token, expiresAt: body.expires_at };
}

/** As many pages of a hundred as are read of the installation's repositories. */
const REPO_PAGES = 20;

/**
 * The repositories a token for the installation reaches, by name, and whether
 * that is all of them: an installation with more than are read is not known
 * to be without the ones that were not.
 */
async function reposSeenWith(p: Platform, token: string): Promise<{ repos: AvailableRepo[]; all: boolean }> {
  const repos: AvailableRepo[] = [];
  let all = false;
  for (let page = 1; page <= REPO_PAGES; page++) {
    const res = await p.fetch(`${GITHUB_API}/installation/repositories?per_page=100&page=${page}`, { headers: githubHeaders(token) });
    if (!res.ok) return refuse(502, "GITHUB_REFUSED", `GitHub would not list the installation's repositories (${res.status})`);
    const body = await res.json() as {
      repositories: Array<{ full_name: string; private: boolean; archived: boolean; description: string | null; default_branch: string; html_url: string }>;
    };
    for (const repo of body.repositories) {
      repos.push({
        repo: repo.full_name,
        private: repo.private,
        archived: repo.archived,
        description: repo.description,
        defaultBranch: repo.default_branch,
        htmlUrl: repo.html_url,
      });
    }
    if (body.repositories.length < 100) {
      all = true;
      break;
    }
  }
  return { repos: repos.sort((a, b) => (a.repo.toLowerCase() < b.repo.toLowerCase() ? -1 : 1)), all };
}

/** Every repository the installation can see, by name. */
export async function listAvailableRepos(p: Platform): Promise<AvailableRepo[]> {
  const { token } = await installationToken(p);
  return (await reposSeenWith(p, token)).repos;
}

// ── Which repository a token was refused for ─────────────────────────────────

/**
 * A repository GitHub would not mint a token for, and the name it has now if
 * the one asked for is a name it was renamed from.
 *
 * GitHub mints nothing for a list with one name in it that the installation
 * cannot see, and says only that there is "at least one". On 2026-11-20 that
 * was all a fleet member's note could say, of five repositories; by the time
 * an operator read it the one at fault had been taken away, and the four that
 * were left were looked over and found to be in order. It had been subscribed
 * to by a name it no longer had: the app could see the repository, not by
 * that name, and nothing about the installation needed changing.
 */
interface RefusedRepo {
  repo: string;
  now: string | null;
}

/** At most this many are named in one line: a note is short. */
const REFUSED_NAMED = 4;

/**
 * Which of `repos` the installation cannot see. Asked of GitHub with a token
 * for the whole installation, which is minted whatever was asked for before.
 * Empty when every one of them is there to be seen, or when not all of the
 * installation's repositories could be read.
 */
async function refusedRepos(p: Platform, repos: readonly string[]): Promise<RefusedRepo[]> {
  const { token } = await installationToken(p);
  const { repos: seen, all } = await reposSeenWith(p, token);
  if (!all) return [];
  const names = new Set(seen.map((repo) => repo.repo.toLowerCase()));
  const refused = repos.filter((repo) => !names.has(repo.toLowerCase()));
  return Promise.all(refused.map(async (repo) => ({ repo, now: await nameNow(p, token, repo) })));
}

/**
 * What a repository asked for by `repo` is called now, when that is something
 * else: GitHub answers a read of a name a repository was renamed from as the
 * repository it now is. Null when it is called that, is not there, or cannot be asked.
 */
async function nameNow(p: Platform, token: string, repo: string): Promise<string | null> {
  try {
    const res = await p.fetch(`${GITHUB_API}/repos/${repo}`, { headers: githubHeaders(token) });
    if (!res.ok) return null;
    const body = await res.json() as { full_name?: unknown };
    const name = typeof body.full_name === "string" ? body.full_name : "";
    return name && name.toLowerCase() !== repo.toLowerCase() ? name : null;
  } catch {
    return null;
  }
}

function refusedLine(refused: readonly RefusedRepo[]): string {
  const named = refused.slice(0, REFUSED_NAMED).map(({ repo, now }) =>
    now ? `${repo} is called ${now} now` : `${repo} is not a repository the app can see`);
  const more = refused.length - named.length;
  return more > 0 ? `${named.join("; ")}; and ${more} more` : named.join("; ");
}

function refusedRemedy(refused: readonly RefusedRepo[]): string {
  const remedies: string[] = [];
  if (refused.some((repo) => repo.now !== null)) {
    remedies.push("unsubscribe from a repository that was renamed and subscribe to it under the name it has now");
  }
  if (refused.some((repo) => repo.now === null)) {
    remedies.push("add a repository the app cannot see on GitHub, in the app's installation settings, or unsubscribe from it");
  }
  return remedies.join("; ");
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

/** Whether `signature` (the `X-Hub-Signature-256` header) is GitHub's over `body` with the app's webhook secret. */
export async function verifyWebhook(p: Platform, body: string, signature: string | undefined): Promise<boolean> {
  const row = await appRow(p);
  const secrets = row ? await appSecrets(p, row) : null;
  if (!secrets?.webhookSecret || !signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secrets.webhookSecret).update(body).digest();
  const given = Buffer.from(signature.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
