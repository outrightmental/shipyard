import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { EventEmitter, type DashboardEvent } from "../src/event-emitter.js";
import { enrollMachine, EnrollRefused, waitUntilOnline } from "../src/fleet/enroll.js";
import { GitHubTokenKeeper, RENEW_WITH_LESS_THAN_MS } from "../src/fleet/github-token.js";
import { hostInfo, readEnrollment, readToken } from "../src/fleet/machine.js";
import { diffRepos, envConfigOf, FleetMember, machineSettings, NOTE_GITHUB, NOTE_UPDATE, NotEnrolled, type FleetHooks } from "../src/fleet/member.js";
import { installService, launchdPlist, systemdUnit, windowsServiceCommand, windowsServiceScript } from "../src/fleet/service.js";
import { availableFromVmStat, cpuUse, LoopLag, SystemMonitor, type CoreTimes, type SystemProbe } from "../src/fleet/system-monitor.js";
import { fastForwardTo, needsUpdate, RESTART_EXIT_CODE, type GitRunner, type UpdateResult } from "../src/fleet/update.js";
import { compactQueue } from "../src/fleet/uplink.js";
import { startLocalPlatform, type LocalPlatform } from "../src/platform/local.js";
import { cachedEvents } from "../src/platform/relay.js";
import type { ConsoleState, MemberConfig } from "../src/shared/protocol.js";
import { systemReadingOf, type SystemReading } from "../src/shared/system.js";

// A fleet member (#4), tried the way it runs: a real member, over real HTTP
// and a real socket, against the platform's own code on a port of this
// machine with its table in memory.

const RELEASE = "0123456789abcdef0123456789abcdef01234567";
const NEXT_RELEASE = "89abcdef0123456789abcdef0123456789abcdef";
const HOST = hostInfo();

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

/** A repository subscribed to by a name it has since been renamed from. */
const FORMER_NAME = "formerly-widgets";

/** A GitHub with one app, installed on acme: what the platform asks of GitHub, answered. */
function fakeGithub(minted: Array<{ repositories?: string[] }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/app-manifests/the-code/conversions")) {
      return answer({ id: 4242, slug: "shipyard-acme", name: "shipyard-acme", html_url: "https://github.com/apps/shipyard-acme", client_id: "c", client_secret: "s", webhook_secret: "h", pem: APP_PEM, owner: { login: "acme" } }, 201);
    }
    if (url.includes("/users/shipyard-acme")) return answer({ id: 777 });
    if (url.includes("/app/installations?")) return answer([{ id: 99, account: { login: "acme" }, repository_selection: "all", html_url: "" }]);
    if (url.endsWith("/app/installations/99/access_tokens")) {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { repositories?: string[] };
      // A name the repository no longer has is one the installation cannot see: GitHub mints nothing for the lot.
      if (body.repositories?.includes(FORMER_NAME)) {
        return answer({ message: "There is at least one repository that does not exist or is not accessible to the parent installation." }, 422);
      }
      // A token for every repository of the installation's is asked for only to find out which one that was.
      if (body.repositories === undefined) return answer({ token: "ghs_to_look_with", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      minted.push(body);
      return answer({ token: `ghs_token_${minted.length}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (url.includes("/installation/repositories")) {
      const repo = (name: string) => ({ full_name: `acme/${name}`, private: true, archived: false, description: null, default_branch: "main", html_url: `https://github.com/acme/${name}` });
      return answer({ repositories: [repo("widgets"), repo("gadgets")] });
    }
    // The name it was renamed from answers a read, as the repository it now is.
    if (url.endsWith(`/repos/acme/${FORMER_NAME}`)) return answer({ full_name: "acme/widgets" });
    return answer({ message: "Not Found" }, 404);
  }) as typeof fetch;
}

interface Harness {
  platform: LocalPlatform;
  minted: Array<{ repositories?: string[] }>;
  home: string;
  /** Call the console's API as the operator. */
  operator<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T>;
  state(): Promise<ConsoleState>;
}

async function harness(t: { after: (fn: () => void | Promise<void>) => void }, options: { github?: boolean; release?: string | null } = {}): Promise<Harness> {
  const minted: Array<{ repositories?: string[] }> = [];
  const platform = await startLocalPlatform({ release: options.release === undefined ? RELEASE : options.release, fetchImpl: fakeGithub(minted) });
  const home = mkdtempSync(join(os.tmpdir(), "shipyard-member-"));
  t.after(async () => {
    await platform.close();
    rmSync(home, { recursive: true, force: true });
  });
  const operator = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${platform.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${platform.operatorToken}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return await res.json() as T;
  };
  if (options.github !== false) {
    const begun = await operator<{ state: string }>("POST", "/api/github/manifest", { org: "acme" });
    await operator("POST", "/api/github/app", { code: "the-code", state: begun.state });
    await operator("POST", "/api/github/refresh");
  }
  return { platform, minted, home, operator, state: () => operator<ConsoleState>("GET", "/api/state") };
}

async function enroll(h: Harness, name = "atlas") {
  const { code } = await h.operator<{ code: string }>("POST", "/api/fleet/enroll-codes");
  return enrollMachine({ platformUrl: h.platform.url, code, name, home: h.home, host: HOST, commit: RELEASE });
}

/** Wait until `check` says so, or fail saying what was being waited for. */
async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface Started {
  member: FleetMember;
  emitter: EventEmitter;
  logs: string[];
  /** Everything the engine pool was told, in order. */
  told: Array<{ what: "repos"; added: string[]; removed: string[] } | { what: "restart" | "stop"; reason: string }>;
  updates: Array<{ target: string | null; dryRun: boolean }>;
}

/** A member of `h`'s platform, joined and started, with hooks that remember what they were told. */
async function startMember(
  t: { after: (fn: () => void | Promise<void>) => void },
  h: Harness,
  options: {
    commit?: string | null;
    update?: (target: string | null, dryRun: boolean) => UpdateResult;
    /** How it measures its machine; a member of these tests does not, unless the test is about that. */
    system?: ConstructorParameters<typeof FleetMember>[0]["system"];
  } = {},
): Promise<Started & { joined: { restart: boolean } }> {
  const emitter = new EventEmitter();
  const logs: string[] = [];
  const told: Started["told"] = [];
  const updates: Started["updates"] = [];
  const member = new FleetMember({
    emitter,
    log: (line) => logs.push(line),
    home: h.home,
    commit: options.commit === undefined ? RELEASE : options.commit,
    system: options.system ?? false,
    update: async ({ target, dryRun }) => {
      updates.push({ target, dryRun: dryRun === true });
      return options.update?.(target, dryRun === true) ?? { ok: true, head: RELEASE, to: RELEASE, moved: false };
    },
  });
  t.after(() => member.finish());
  const joined = await member.join();
  const hooks: FleetHooks = {
    async reposChanged({ added, removed }) { told.push({ what: "repos", added: added.map((repo) => repo.repo), removed }); },
    restart(reason) { told.push({ what: "restart", reason }); },
    stop(reason) { told.push({ what: "stop", reason }); },
  };
  if (!joined.restart) member.start(hooks);
  return { member, emitter, logs, told, updates, joined };
}

const event = (type: string, data: Record<string, unknown> = {}): DashboardEvent => ({ type: type as DashboardEvent["type"], timestamp: new Date().toISOString(), data });

// ── Enrolling ────────────────────────────────────────────────────────────────

test("enrolling redeems the code for a token only this machine's user can read, and never shows it", async (t) => {
  const h = await harness(t);
  const enrolled = await enroll(h);

  assert.match(enrolled.memberId, /^m_[0-9a-f]+$/);
  assert.equal(enrolled.name, "atlas");
  assert.equal(enrolled.reenrolled, false);
  assert.equal(enrolled.platformUrl, h.platform.url);
  assert.equal(enrolled.wsUrl, h.platform.wsUrl);
  assert.ok(!("token" in enrolled), "what enrolling returns has no token in it to print");

  assert.match(readToken(h.home, {})!, /^shp_m_[0-9a-f]+_[0-9a-f]{64}$/);
  assert.deepEqual(readEnrollment(h.home), {
    memberId: enrolled.memberId, name: "atlas", platformUrl: h.platform.url, wsUrl: h.platform.wsUrl, enrolledAt: enrolled.enrolledAt,
  });
  assert.ok(!readFileSync(enrolled.files.enrollment, "utf8").includes("shp_"), "the enrollment file does not hold the token");
  if (process.platform !== "win32") {
    assert.equal(statSync(enrolled.files.token).mode & 0o777, 0o600);
    assert.equal(statSync(enrolled.files.enrollment).mode & 0o777, 0o600);
  }
});

test("a machine enrolling again stays the member it was, and a spent or unknown code says what to do", async (t) => {
  const h = await harness(t);
  const first = await enroll(h);
  const firstToken = readToken(h.home, {});
  const second = await enroll(h, "atlas");
  assert.equal(second.memberId, first.memberId);
  assert.equal(second.reenrolled, true);
  assert.notEqual(readToken(h.home, {}), firstToken);

  await assert.rejects(
    enrollMachine({ platformUrl: h.platform.url, code: "enr_00000000000000000000000000000000", home: h.home, host: HOST, commit: null }),
    (error: unknown) => error instanceof EnrollRefused && error.code === "CODE_UNKNOWN" && /make a new one/.test(error.remedy ?? ""),
  );
  await assert.rejects(
    enrollMachine({ platformUrl: "http://127.0.0.1:9", code: "enr_x", home: h.home, host: HOST, commit: null }),
    (error: unknown) => error instanceof EnrollRefused && error.code === "UNREACHABLE",
  );
  // A refusal leaves the enrollment it had as it was.
  assert.equal(readEnrollment(h.home)?.memberId, first.memberId);
});

test("a machine that was never enrolled is not a member, and is told how to become one", () => {
  const home = mkdtempSync(join(os.tmpdir(), "shipyard-none-"));
  try {
    assert.throws(
      () => new FleetMember({ emitter: new EventEmitter(), log: () => undefined, home }),
      (error: unknown) => error instanceof NotEnrolled && /npm run enroll -- --code/.test(error.message),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Joining ──────────────────────────────────────────────────────────────────

test("a member is told what to be: a pool, and no repositories until it is assigned some", async (t) => {
  const h = await harness(t);
  const enrolled = await enroll(h);
  const { member, joined } = await startMember(t, h);

  assert.equal(joined.restart, false);
  assert.deepEqual(member.config.member, { id: enrolled.memberId, name: "atlas" });
  assert.deepEqual(member.repos, []);
  assert.deepEqual(member.envConfig(), { max_concurrency: 6, dashboard_title: "atlas", github_tokens: [], projects: [] });
  assert.equal(member.tokens.current(), "", "with nothing to work on there is no token to ask for");
  assert.equal(h.minted.length, 0);

  // The platform has heard from it: its commit, and the machine it is.
  const [seen] = (await h.state()).members;
  assert.equal(seen?.commit, RELEASE);
  assert.equal(seen?.host?.hostname, HOST.hostname);
  await until("its socket", async () => (await h.state()).members[0]?.connected === true);
  assert.equal(await waitUntilOnline({ platformUrl: h.platform.url, token: readToken(h.home, {})!, timeoutMs: 2_000, everyMs: 50 }), true);
});

test("Shipyard says what a member works on; the machine says only how its own engines run", () => {
  const home = mkdtempSync(join(os.tmpdir(), "shipyard-env-"));
  try {
    assert.deepEqual(machineSettings(home), {}, "no env.yaml is no settings");
    writeFileSync(join(home, "env.yaml"), [
      "claude_code_initial_model: claude-fable-5-2",
      "claude_timeout_seconds: 7200",
      "dashboard_port: 3100",
      "max_concurrency: 12",
      "github_tokens: [{ name: default, token: nope }]",
      "projects: [{ github_repository: acme/sneaky }]",
    ].join("\n"));
    const machine = machineSettings(home);
    assert.deepEqual(machine, { claude_code_initial_model: "claude-fable-5-2", claude_timeout_seconds: 7200, dashboard_port: 3100 });

    const config: MemberConfig = {
      member: { id: "m_1", name: "atlas" }, release: null, configVersion: "v", maxConcurrency: 5,
      repos: [{ repo: "acme/widgets", maxConcurrency: 2, focusMode: true }, { repo: "acme/gadgets", githubProjectNumber: 4, reviewers: ["alice"] }],
      engineDefaults: {}, github: { ready: true }, git: null, wsUrl: "",
    };
    assert.deepEqual(envConfigOf(config, machine), {
      claude_code_initial_model: "claude-fable-5-2", claude_timeout_seconds: 7200, dashboard_port: 3100,
      max_concurrency: 5, dashboard_title: "atlas", github_tokens: [],
      projects: [
        { github_repository: "acme/widgets", max_concurrency: 2, focus_mode: true },
        { github_repository: "acme/gadgets", github_project_number: 4, reviewers: ["alice"] },
      ],
    });

    // Platform engine defaults are applied below machine settings; machine wins when both set the same field.
    const configWithDefaults: MemberConfig = {
      ...config,
      engineDefaults: { initialModel: "claude-sonnet-5-5", reviewModel: "claude-opus-5-5", initialEffort: "xhigh", reviewEffort: "medium", describeModel: "claude-haiku-5-5" },
      repos: [
        { repo: "acme/widgets", maxConcurrency: 2, focusMode: true },
        { repo: "acme/gadgets", initialModel: "claude-haiku-5-5", reviewEffort: "low" },
      ],
    };
    const withDefaults = envConfigOf(configWithDefaults, machine);
    // Machine's claude_code_initial_model overrides the platform default.
    assert.equal(withDefaults.claude_code_initial_model, "claude-fable-5-2", "machine wins over platform default");
    assert.equal(withDefaults.claude_code_review_model, "claude-opus-5-5", "platform default set");
    assert.equal(withDefaults.claude_code_initial_effort, "xhigh", "platform default set");
    assert.equal(withDefaults.claude_code_review_effort, "medium", "platform default set");
    assert.equal(withDefaults.claude_describe_model, "claude-haiku-5-5", "platform default set");
    // Per-repo overrides are in projects.
    const gadgets = withDefaults.projects.find((p) => p.github_repository === "acme/gadgets");
    assert.equal(gadgets?.claude_code_initial_model, "claude-haiku-5-5", "per-repo initial model");
    assert.equal(gadgets?.claude_code_review_effort, "low", "per-repo review effort");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Reporting ────────────────────────────────────────────────────────────────

test("what a member's engines emit reaches the platform in order, and the consoles with it", async (t) => {
  const h = await harness(t);
  const enrolled = await enroll(h);
  await h.operator("PUT", "/api/repos/acme/widgets", { memberId: enrolled.memberId });
  const { emitter } = await startMember(t, h);

  const console_ = new WebSocket(`${h.platform.wsUrl}?token=${h.platform.operatorToken}`);
  t.after(() => console_.close());
  const pushed: Array<{ t: string; member?: string; events?: DashboardEvent[] }> = [];
  console_.on("message", (data) => pushed.push(JSON.parse(data.toString()) as typeof pushed[number]));
  await new Promise<void>((resolve) => console_.once("open", () => resolve()));

  emitter.emit("iteration-start", { engineIndex: 0, iterationNumber: 1, maxConcurrency: 3 });
  emitter.emit("lifecycle-update", { repo: "acme/widgets", pairs: [{ issue: { number: 7, title: "Seven", state: "open" }, prPhase: "absent" }] });
  emitter.emit("log-message", { message: "first" });
  emitter.emit("log-message", { message: "second" });

  await until("the events to be relayed", () => pushed.some((push) => push.t === "events"));
  const relayed = pushed.filter((push) => push.t === "events").flatMap((push) => push.events ?? []);
  assert.deepEqual(relayed.map((e) => e.data["message"] ?? e.type), ["iteration-start", "lifecycle-update", "first", "second"]);
  assert.ok(pushed.filter((push) => push.t === "events").every((push) => push.member === enrolled.memberId));

  const cached = await cachedEvents(h.platform.p, enrolled.memberId);
  assert.deepEqual(cached.map((e) => e.type).sort(), ["iteration-start", "lifecycle-update"]);
});

test("a platform out of reach holds nothing up: the member keeps what matters and sends it when it is back", async (t) => {
  const h = await harness(t);
  const enrolled = await enroll(h);
  await h.operator("PUT", "/api/repos/acme/widgets", { memberId: enrolled.memberId });

  let down = false;
  const emitter = new EventEmitter();
  const logs: string[] = [];
  const member = new FleetMember({
    emitter, log: (line) => logs.push(line), home: h.home, commit: RELEASE,
    update: async () => ({ ok: true, head: RELEASE, to: RELEASE, moved: false }),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (down) throw new Error("getaddrinfo ENOTFOUND");
      return fetch(input, init);
    }) as typeof fetch,
  });
  t.after(() => member.finish());
  await member.join();
  member.start({ async reposChanged() {}, restart() {}, stop() {} });

  down = true;
  emitter.emit("lifecycle-update", { repo: "acme/widgets", pairs: [] });
  emitter.emit("engine-idle", { engineIndex: 0, reason: "idle" });
  await until("it to notice", () => logs.some((line) => /could not be reached/.test(line)));
  assert.ok(logs.some((line) => /Work carries on/.test(line)));
  assert.equal((await cachedEvents(h.platform.p, enrolled.memberId)).length, 0);

  down = false;
  await until("the events to arrive", async () => (await cachedEvents(h.platform.p, enrolled.memberId)).length === 2, 6_000);
  assert.ok(logs.some((line) => /reachable again/.test(line)));
});

test("a queue grown past what will be sent in good time keeps what a dashboard needs, and the last of the log", () => {
  const queue = [
    event("log-message", { message: "old" }),
    event("lifecycle-update", { repo: "acme/a", pairs: [1] }),
    event("work-hold", { kind: "claude-usage-limit" }),
    event("lifecycle-update", { repo: "acme/a", pairs: [2] }),
    event("log-message", { message: "middle" }),
    event("work-hold-cleared"),
    event("lifecycle-update", { repo: "acme/b", pairs: [3] }),
    event("log-message", { message: "newest" }),
  ];
  const kept = compactQueue(queue, 2);
  assert.deepEqual(kept.map((e) => e.data["message"] ?? e.data["pairs"] ?? e.type), [
    "work-hold", [2], "middle", "work-hold-cleared", [3], "newest",
  ]);
});

// ── Orders ───────────────────────────────────────────────────────────────────

test("a repository assigned while a member runs is worked with no restart, with a token that reaches it", async (t) => {
  const h = await harness(t);
  const enrolled = await enroll(h);
  const { member, told } = await startMember(t, h);
  await until("its socket", async () => (await h.state()).members[0]?.connected === true);

  await h.operator("PUT", "/api/repos/acme/widgets", { memberId: enrolled.memberId, settings: { maxConcurrency: 2 } });
  await until("it to be told", () => told.length === 1);
  assert.deepEqual(told, [{ what: "repos", added: ["acme/widgets"], removed: [] }]);
  assert.deepEqual(member.config.repos, [{ repo: "acme/widgets", maxConcurrency: 2 }]);
  // The token was asked for before the engine pool was told, and reaches exactly what is assigned.
  assert.deepEqual(h.minted, [{ repositories: ["widgets"] }]);
  assert.equal(member.tokens.current(), "ghs_token_1");
  // Its commits are the app's own.
  assert.equal(process.env["GIT_AUTHOR_NAME"], "shipyard-acme[bot]");
  assert.equal(process.env["GIT_COMMITTER_EMAIL"], "777+shipyard-acme[bot]@users.noreply.github.com");

  await h.operator("PUT", "/api/repos/acme/gadgets", { memberId: enrolled.memberId });
  await until("the second", () => told.length === 2);
  assert.deepEqual(told[1], { what: "repos", added: ["acme/gadgets"], removed: [] });
  assert.deepEqual(h.minted.at(-1), { repositories: ["gadgets", "widgets"] });

  // Other settings for one it already has: it is taken away and added again as it now is.
  await h.operator("PUT", "/api/repos/acme/widgets", { settings: { focusMode: true } });
  await until("the change of settings", () => told.length === 3);
  assert.deepEqual(told[2], { what: "repos", added: ["acme/widgets"], removed: ["acme/widgets"] });

  await h.operator("PUT", "/api/repos/acme/widgets", { memberId: null });
  await until("it to be taken away", () => told.length === 4);
  assert.deepEqual(told[3], { what: "repos", added: [], removed: ["acme/widgets"] });
  assert.deepEqual(member.repos, ["acme/gadgets"]);
});

test("a decision made in Shipyard reaches the engine pool as a press on its own dashboard would", async (t) => {
  const h = await harness(t);
  const enrolled = await enroll(h);
  await h.operator("PUT", "/api/repos/acme/widgets", { memberId: enrolled.memberId });
  const { emitter } = await startMember(t, h);
  await until("its socket", async () => (await h.state()).members[0]?.connected === true);
  const heard: DashboardEvent[] = [];
  emitter.subscribe((e) => { if (e.type === "pull-request-approve" || e.type === "cylinder-cancel") heard.push(e); });

  const console_ = new WebSocket(`${h.platform.wsUrl}?token=${h.platform.operatorToken}`);
  t.after(() => console_.close());
  await new Promise<void>((resolve) => console_.once("open", () => resolve()));
  console_.send(JSON.stringify({ t: "approve", repo: "acme/widgets", pullRequestNumber: 12 }));
  console_.send(JSON.stringify({ t: "cancel", member: enrolled.memberId, engineIndex: 1 }));

  await until("both to arrive", () => heard.length === 2);
  // Two things said at once are taken in whichever order they are dealt with.
  assert.deepEqual(heard.map((e) => [e.type, e.data]).sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)), [
    ["cylinder-cancel", { engineIndex: 1 }],
    ["pull-request-approve", { repo: "acme/widgets", pullRequestNumber: 12 }],
  ]);
});

test("a pool resized in Shipyard restarts the member to take the new size, once what it runs has finished", async (t) => {
  const h = await harness(t);
  const enrolled = await enroll(h);
  const { told, logs } = await startMember(t, h);
  await until("its socket", async () => (await h.state()).members[0]?.connected === true);
  await h.operator("PATCH", `/api/fleet/${enrolled.memberId}`, { maxConcurrency: 4 });
  await until("it to be told", () => told.length === 1);
  assert.deepEqual(told, [{ what: "restart", reason: "its engine pool was resized" }]);
  assert.ok(logs.some((line) => /engine pool is now 4 \(was 6\)/.test(line)));
});

test("a member an operator retires is told to stop, and does not come back", async (t) => {
  const h = await harness(t);
  const enrolled = await enroll(h);
  const { told, logs } = await startMember(t, h);
  await until("its socket", async () => (await h.state()).members[0]?.connected === true);
  await h.operator("DELETE", `/api/fleet/${enrolled.memberId}`);
  await until("it to be told", () => told.length === 1);
  assert.equal(told[0]?.what, "stop");
  assert.ok(logs.some((line) => /retired this machine/.test(line)));

  // And one whose token simply stopped working finds out the next time it speaks.
  const again = new FleetMember({ emitter: new EventEmitter(), log: () => undefined, home: h.home, commit: RELEASE });
  await assert.rejects(again.join(), (error: unknown) => error instanceof NotEnrolled && /enroll it again/.test(error.message));
});

// ── Staying on Shipyard's commit ─────────────────────────────────────────────

test("started on another commit with nothing running, a member moves its checkout and asks to be started again", async (t) => {
  const h = await harness(t, { release: NEXT_RELEASE });
  await enroll(h);
  const { joined, updates, logs } = await startMember(t, h, {
    commit: RELEASE,
    update: () => ({ ok: true, head: RELEASE, to: NEXT_RELEASE, moved: true }),
  });
  assert.equal(joined.restart, true);
  assert.deepEqual(updates, [{ target: NEXT_RELEASE, dryRun: false }]);
  assert.ok(logs.some((line) => /updated this checkout to 89abcde/.test(line)));
  assert.equal(RESTART_EXIT_CODE, 75);
});

test("a deploy while a member works: it checks it can move, winds down, and moves only once nothing is running", async (t) => {
  const h = await harness(t);
  await enroll(h);
  const { member, emitter, told, updates } = await startMember(t, h, {
    update: (target) => ({ ok: true, head: RELEASE, to: target ?? RELEASE, moved: target !== RELEASE }),
  });
  assert.deepEqual(updates, [], "on the platform's commit there is nothing to check");

  h.platform.setRelease(NEXT_RELEASE);
  // Every answer from the platform names its commit: the next thing the member says is answered with the new one.
  emitter.emit("log-message", { message: "still working" });
  await until("it to wind down", () => told.length === 1);
  assert.deepEqual(told, [{ what: "restart", reason: "updating to 89abcde" }]);
  assert.deepEqual(updates, [{ target: NEXT_RELEASE, dryRun: true }], "checked, and not yet moved: its agents are still running");

  await member.finish();
  assert.deepEqual(updates.at(-1), { target: NEXT_RELEASE, dryRun: false }, "moved as the last thing before it exits");
});

test("a member that cannot update itself says why where an operator will see it, and carries on working", async (t) => {
  const h = await harness(t);
  await enroll(h);
  const { emitter, told, logs } = await startMember(t, h, {
    update: () => ({ ok: false, code: "DIRTY_CHECKOUT", message: "local changes to src/index.ts: commit, stash or discard them", head: RELEASE }),
  });
  h.platform.setRelease(NEXT_RELEASE);
  emitter.emit("log-message", { message: "still working" });

  await until("the note", async () => ((await h.state()).members[0]?.notes.length ?? 0) > 0);
  const [note] = (await h.state()).members[0]!.notes;
  assert.equal(note?.code, NOTE_UPDATE);
  assert.equal(note?.message, "cannot update itself to 89abcde: local changes to src/index.ts: commit, stash or discard them");
  assert.deepEqual(told, [], "it is not stopped for something it cannot do");
  assert.ok(logs.some((line) => /carries on with the commit it has/.test(line)));
});

test("a platform that announces no commit moves no one", () => {
  assert.equal(needsUpdate(null, RELEASE), false);
  assert.equal(needsUpdate("local", RELEASE), false);
  assert.equal(needsUpdate(RELEASE, RELEASE), false);
  assert.equal(needsUpdate(RELEASE, RELEASE.slice(0, 7)), false, "a short SHA is its full one");
  assert.equal(needsUpdate(NEXT_RELEASE, RELEASE), true);
  assert.equal(needsUpdate(NEXT_RELEASE, null), true);
});

/** A git that answers from a script: what each command says, or that it fails. */
function scriptedGit(script: {
  head?: string; branch?: string | null; status?: string; fetch?: "ok" | "fail"; known?: boolean;
  onRemote?: boolean; headHasTarget?: boolean; targetHasHead?: boolean;
}): { git: GitRunner; ran: string[] } {
  const ran: string[] = [];
  const exit1 = () => Object.assign(new Error("exit 1"), { code: 1 });
  const git: GitRunner = async (args) => {
    ran.push(args.join(" "));
    const [command, ...rest] = args;
    if (command === "rev-parse" && rest[0] === "HEAD") return script.head ?? RELEASE;
    if (command === "symbolic-ref") { if (script.branch === null) throw exit1(); return script.branch ?? "main"; }
    if (command === "status") return script.status ?? "";
    if (command === "fetch") { if (script.fetch === "fail") throw Object.assign(new Error("fetch"), { stderr: "fatal: unable to access" }); return ""; }
    if (command === "rev-parse") { if (script.known === false) throw exit1(); return NEXT_RELEASE; }
    if (command === "merge-base") {
      const [, ancestor, of] = rest;
      const yes = of === "FETCH_HEAD" ? script.onRemote !== false : of === "HEAD" ? script.headHasTarget === true : ancestor === "HEAD" && script.targetHasHead !== false;
      if (!yes) throw exit1();
      return "";
    }
    if (command === "merge") return "";
    throw new Error(`unscripted: git ${args.join(" ")}`);
  };
  return { git, ran };
}

test("a checkout is moved only forward, only to the platform's commit, and only when it is clean and on its branch", async () => {
  const run = (script: Parameters<typeof scriptedGit>[0], dryRun = false) => {
    const { git, ran } = scriptedGit(script);
    return fastForwardTo({ target: NEXT_RELEASE, root: "/checkout", git, dryRun }).then((result) => ({ result, ran }));
  };

  const moved = await run({});
  assert.deepEqual(moved.result, { ok: true, head: RELEASE, to: NEXT_RELEASE, moved: true });
  assert.ok(moved.ran.includes(`merge --ff-only --quiet ${NEXT_RELEASE}`));
  assert.ok(moved.ran.includes("fetch --quiet origin main"));

  const checked = await run({}, true);
  assert.deepEqual(checked.result, { ok: true, head: RELEASE, to: NEXT_RELEASE, moved: true });
  assert.ok(!checked.ran.some((command) => command.startsWith("merge --ff-only")), "a dry run moves nothing");

  const refused = async (script: Parameters<typeof scriptedGit>[0], code: string, message: RegExp) => {
    const { result, ran } = await run(script);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.code : null, code);
    assert.match(result.ok === false ? result.message : "", message);
    assert.ok(!ran.some((command) => command.startsWith("merge --ff-only")), `${code} moves nothing`);
  };
  await refused({ branch: "feature" }, "NOT_ON_BRANCH", /on branch feature, not main/);
  await refused({ branch: null }, "NOT_ON_BRANCH", /detached HEAD/);
  await refused({ status: " M src/index.ts\n M package.json" }, "DIRTY_CHECKOUT", /local changes to src\/index.ts, package.json/);
  await refused({ fetch: "fail" }, "FETCH_FAILED", /unable to access/);
  await refused({ known: false }, "UNKNOWN_COMMIT", /89abcde is not on origin\/main/);
  await refused({ onRemote: false }, "UNKNOWN_COMMIT", /not on origin\/main/);
  await refused({ targetHasHead: false }, "DIVERGED", /commits of its own/);

  // Already past it: never moved back.
  const ahead = await run({ headHasTarget: true });
  assert.deepEqual(ahead.result, { ok: true, ahead: true, head: RELEASE, to: NEXT_RELEASE, moved: false });
  // Already on it: nothing to do, and nothing fetched twice.
  const there = await run({ head: NEXT_RELEASE });
  assert.deepEqual(there.result, { ok: true, head: NEXT_RELEASE, to: NEXT_RELEASE, moved: false });
  assert.equal((await fastForwardTo({ target: "local", root: "/checkout", git: scriptedGit({}).git })).ok, false);
});

// ── The GitHub token ─────────────────────────────────────────────────────────

test("the GitHub token is renewed before it runs out, and when it does not reach what is now assigned", async () => {
  let now = Date.parse("2026-11-15T12:00:00Z");
  let minted = 0;
  let fail = false;
  const problems: Array<string | null> = [];
  const keeper = new GitHubTokenKeeper({
    now: () => now,
    onProblem: (problem) => problems.push(problem),
    mint: async () => {
      if (fail) throw new Error("the app is not installed");
      minted += 1;
      return { token: `token-${minted}`, expiresAtMs: now + 3_600_000, repos: minted === 1 ? ["acme/widgets"] : ["acme/widgets", "acme/gadgets"] };
    },
  });

  assert.equal(keeper.current(), "");
  assert.equal(await keeper.ensure([]), true);
  assert.equal(minted, 0, "nothing to work on, nothing asked for");

  assert.equal(await keeper.ensure(["acme/widgets"]), true);
  assert.equal(keeper.current(), "token-1");
  assert.equal(await keeper.ensure(["acme/Widgets"]), true);
  assert.equal(minted, 1, "one in hand that reaches it and has time left is kept");

  // Something newly assigned is not reached by the token in hand.
  assert.equal(await keeper.ensure(["acme/widgets", "acme/gadgets"]), true);
  assert.equal(keeper.current(), "token-2");

  // Renewed with twenty minutes left, well before a run that started with it pushes.
  now += 3_600_000 - RENEW_WITH_LESS_THAN_MS + 1;
  assert.equal(keeper.covers(["acme/widgets"]), false);
  assert.equal(await keeper.ensure(["acme/widgets"]), true);
  assert.equal(keeper.current(), "token-3");

  // One that cannot be had is said, and the one in hand is kept for as long as it lasts.
  fail = true;
  now += 3_600_000 - RENEW_WITH_LESS_THAN_MS + 1;
  assert.equal(await keeper.ensure(["acme/widgets"]), false);
  assert.equal(keeper.current(), "token-3");
  assert.equal(problems.at(-1), "the app is not installed");
  fail = false;
  assert.equal(await keeper.ensure(["acme/widgets"]), true);
  assert.equal(problems.at(-1), null);
});

test("a token that could not be had is no longer a problem once the one in hand reaches all that is assigned", async () => {
  const now = Date.parse("2026-11-20T05:07:53Z");
  let asked = 0;
  let refuse = false;
  const problems: Array<string | null> = [];
  const keeper = new GitHubTokenKeeper({
    now: () => now,
    onProblem: (problem) => problems.push(problem),
    mint: async () => {
      asked += 1;
      if (refuse) throw new Error("GitHub would not mint a token (422)");
      return { token: "token-1", expiresAtMs: now + 3_600_000, repos: ["acme/widgets"] };
    },
  });
  assert.equal(await keeper.ensure(["acme/widgets"]), true);

  // One more is assigned, by a name GitHub does not know: no token for the two, and that is said.
  refuse = true;
  assert.equal(await keeper.ensure(["acme/widgets", "acme/formerly-widgets"]), false);
  assert.equal(problems.at(-1), "GitHub would not mint a token (422)");
  assert.equal(keeper.current(), "token-1", "the one in hand is kept");

  // It is taken away again. Nothing more is asked of GitHub, so no answer of its will say the trouble is over.
  assert.equal(await keeper.ensure(["acme/widgets"]), true);
  assert.equal(asked, 2);
  assert.equal(problems.at(-1), null, "what was said is taken back, not left standing until the next renewal");
});

test("a member refused a token for a repository says so only for as long as that repository is assigned to it", async (t) => {
  const h = await harness(t);
  const enrolled = await enroll(h);
  const { member, told } = await startMember(t, h);
  await until("its socket", async () => (await h.state()).members[0]?.connected === true);
  const notes = async () => (await h.state()).members[0]?.notes ?? [];

  await h.operator("PUT", "/api/repos/acme/widgets", { memberId: enrolled.memberId });
  await until("it to be told", () => told.length === 1);
  assert.equal(member.tokens.current(), "ghs_token_1");
  assert.deepEqual(await notes(), []);

  // Assigned one more, by a name it no longer has: GitHub refuses a token for the two together.
  await h.operator("PUT", `/api/repos/acme/${FORMER_NAME}`, { memberId: enrolled.memberId });
  await until("the refusal to be said", async () => (await notes()).length === 1);
  const [note] = await notes();
  assert.equal(note?.code, NOTE_GITHUB);
  // Said with the repository it is about, and what to call it: GitHub's own words name neither.
  assert.equal(note?.message, `no GitHub token: GitHub would not mint a token: acme/${FORMER_NAME} is called acme/widgets now`);
  assert.equal(member.tokens.current(), "ghs_token_1", "and goes on working what it could already reach");

  // Taken away again, well inside the hour the token in hand lasts.
  await h.operator("PUT", `/api/repos/acme/${FORMER_NAME}`, { memberId: null });
  await until("the note to be taken back", async () => (await notes()).length === 0);
  assert.equal(member.tokens.current(), "ghs_token_1");
  assert.deepEqual(h.minted, [{ repositories: ["widgets"] }], "with no token asked for that GitHub could have answered");
});

test("which repositories changed between two configurations", () => {
  const before = [{ repo: "acme/a" }, { repo: "acme/b", maxConcurrency: 2 }, { repo: "acme/c" }];
  const after = [{ repo: "acme/a" }, { repo: "acme/b", maxConcurrency: 3 }, { repo: "acme/d" }];
  assert.deepEqual(diffRepos(before, after), {
    added: [{ repo: "acme/b", maxConcurrency: 3 }, { repo: "acme/d" }],
    removed: ["acme/b", "acme/c"],
  });
  assert.deepEqual(diffRepos(before, before), { added: [], removed: [] });
});

// ── As a service ─────────────────────────────────────────────────────────────

test("the service starts the member again unless it stopped for good, at once after an update", () => {
  const windows = windowsServiceScript({ home: "C:\\Users\\O'Brien\\.shipyard", repoRoot: "C:\\src\\shipyard", nodePath: "C:\\Program Files\\nodejs\\node.exe" });
  assert.match(windows, /while \(\$true\)/);
  assert.match(windows, /if \(\$code -eq 0\) \{ break \}/);
  assert.match(windows, /if \(\$code -ne 75\) \{ Start-Sleep -Seconds 15 \}/);
  assert.match(windows, /& 'C:\\Program Files\\nodejs\\node\.exe' 'C:\\src\\shipyard\\tools\\fleet-runner\.mjs' \*>> \$log/);
  assert.ok(windows.includes("$env:SHIPYARD_HOME = 'C:\\Users\\O''Brien\\.shipyard'"), "a quote in a path is doubled, not left to end the string");
  assert.deepEqual(windowsServiceCommand("C:\\h\\fleet-service.ps1").args.slice(-2), ["-File", "C:\\h\\fleet-service.ps1"]);

  const plist = launchdPlist({ home: "/Users/a&b/.shipyard", repoRoot: "/src/shipyard", nodePath: "/opt/node", path: "/opt/homebrew/bin:/usr/bin" });
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(plist, /<string>\/src\/shipyard\/tools\/fleet-runner\.mjs<\/string>/);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.match(plist, /\/Users\/a&amp;b\/\.shipyard\/fleet\.log/);

  const unit = systemdUnit({ home: "/home/a/.shipyard", repoRoot: "/src/shipyard", nodePath: "/usr/bin/node", path: "/usr/bin", display: { DISPLAY: ":0" } });
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/src\/shipyard\/tools\/fleet-runner\.mjs"$/m);
  assert.match(unit, /^Environment=DISPLAY=:0$/m);
  assert.match(unit, /^TimeoutStopSec=infinity$/m, "a member told to stop finishes what its agents are running");
});

test("installing the service writes it and starts it, and a dry run does neither", () => {
  const home = mkdtempSync(join(os.tmpdir(), "shipyard-service-"));
  try {
    const ran: string[] = [];
    const launched: string[] = [];
    const exec = (command: string, args: string[]) => { ran.push(`${command} ${args.join(" ")}`); return ""; };
    const launch = (command: string, args: string[]) => { launched.push(`${command} ${args.join(" ")}`); };

    const planned = installService({ home, platform: "win32", repoRoot: "C:\\src\\shipyard", nodePath: "node.exe", dryRun: true, exec, launch });
    assert.equal(planned.planned, true);
    assert.deepEqual([ran, launched], [[], []]);

    const windows = installService({ home, platform: "win32", repoRoot: "C:\\src\\shipyard", nodePath: "node.exe", exec, launch });
    assert.deepEqual([windows.installed, windows.kind], [true, "windows-run"]);
    assert.ok(readFileSync(windows.files[0]!, "utf8").includes("fleet-runner.mjs"));
    assert.ok(ran.some((command) => command.startsWith("reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v ShipyardFleet")), "started at sign-in, with no administrator");
    assert.equal(launched.length, 1, "and started now");

    ran.length = 0;
    const mac = installService({ home, platform: "darwin", osHome: home, repoRoot: "/src/shipyard", nodePath: "/opt/node", path: "/usr/bin", exec, launch });
    assert.deepEqual([mac.installed, mac.kind], [true, "launchd"]);
    assert.deepEqual(ran.map((command) => command.split(" ").slice(0, 2).join(" ")), ["launchctl bootout", "launchctl bootstrap"]);

    ran.length = 0;
    const linux = installService({ home, platform: "linux", osHome: home, repoRoot: "/src/shipyard", nodePath: "/usr/bin/node", path: "/usr/bin", exec, launch });
    assert.deepEqual([linux.installed, linux.kind], [true, "systemd"]);
    assert.ok(ran.includes("systemctl --user enable shipyard-fleet.service"));
    assert.ok(ran.includes("systemctl --user restart shipyard-fleet.service"));

    const unknown = installService({ home, platform: "aix", exec, launch });
    assert.deepEqual([unknown.installed, unknown.kind], [false, "manual"]);
    assert.match(unknown.hints[0]!, /fleet-runner\.mjs/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Its machine ──────────────────────────────────────────────────────────────

const GB = 2 ** 30;
const core = (user: number, sys: number, idle: number): CoreTimes => ({ user, nice: 0, sys, idle, irq: 0 });

/** A machine that reads what the test says: four cores, 16 GB with 4 GB to be had, a disk a quarter free. */
function fakeMachine(of: Partial<SystemProbe> & { times?: CoreTimes[][] } = {}): Partial<SystemProbe> {
  const times = of.times ?? [[core(0, 0, 0), core(0, 0, 0), core(0, 0, 0), core(0, 0, 0)]];
  let reading = 0;
  return {
    platform: "linux",
    cpuTimes: () => times[Math.min(reading++, times.length - 1)]!.map((time) => ({ ...time })),
    loadavg: () => [1.26, 0.84, 0.5],
    totalMemory: () => 16 * GB,
    availableMemory: async () => 4 * GB,
    uptime: () => 90_061.4,
    disk: async () => ({ freeBytes: 250 * GB, totalBytes: 1000 * GB }),
    rss: () => 200 * 2 ** 20,
    processUptime: () => 3_600.6,
    ...of,
  };
}

test("how busy the processor was is the share of its cores' time that was not idle, and its busiest core's", () => {
  const before = [core(100, 50, 850), core(100, 50, 850)];
  // The first core worked 300 of its next 1000, the second 900 of them.
  const after = [core(300, 150, 1550), core(800, 250, 950)];
  assert.deepEqual(cpuUse(before, after), { percent: 60, busiestPercent: 90 });
  assert.deepEqual(cpuUse(before, before), { percent: null, busiestPercent: null }, "no time passed");
  // A machine that slept: a counter that ran backwards is left out, not counted as work.
  assert.deepEqual(cpuUse(before, [core(300, 150, 1550), core(0, 0, 0)]), { percent: 30, busiestPercent: 30 });
  assert.deepEqual(cpuUse([], after), { percent: null, busiestPercent: null });
});

test("on a Mac the memory to be had counts what would be given up, not only what nothing is using", () => {
  const printed = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                               10000.",
    "Pages active:                            400000.",
    "Pages inactive:                          200000.",
    "Pages speculative:                         5000.",
    "Pages wired down:                        150000.",
    "Pages purgeable:                           9000.",
  ].join("\n");
  assert.equal(availableFromVmStat(printed), (10_000 + 200_000 + 5_000) * 16_384);
  assert.equal(availableFromVmStat("vm_stat: command not found"), null);
  assert.equal(availableFromVmStat(""), null);
});

test("the event loop's lag is how late its timer ran at worst, and is asked for afresh each time", () => {
  let now = 0;
  const lag = new LoopLag(500, () => now);
  lag.start();
  lag.stop();
  // Due at 500: ran on time, then 240 late, then 30 late.
  now = 500; lag.tick();
  now = 1240; lag.tick();
  now = 1770; lag.tick();
  assert.equal(lag.take(), 240);
  assert.equal(lag.take(), 0, "what was said is not said again");
  now = 2265; lag.tick();
  assert.equal(lag.take(), 0, "a timer that ran early is not late");
});

test("a reading is everything measured at once, and says so where the machine keeps no such number", async () => {
  const emitter = new EventEmitter();
  const seen: DashboardEvent[] = [];
  emitter.subscribe((event) => seen.push(event));
  let now = 0;
  const lag = new LoopLag(500, () => now);
  const monitor = new SystemMonitor({
    emitter, diskPath: "/checkouts", platformMs: () => 48, clock: () => 1_700_000_000_000, lag,
    probe: fakeMachine({ times: [
      [core(0, 0, 0), core(0, 0, 0), core(0, 0, 0), core(0, 0, 0)],
      [core(500, 100, 400), core(100, 0, 900), core(0, 0, 1000), core(200, 100, 700)],
    ] }),
  });

  // The first has nothing before it to say how busy the processor was.
  const first = await monitor.read();
  assert.deepEqual([first.cpu.percent, first.cpu.busiestPercent, first.cpu.cores], [null, null, 4]);

  now = 800; lag.tick();
  const reading = (await monitor.report())!;
  assert.deepEqual(reading, {
    atMs: 1_700_000_000_000,
    cpu: { percent: 25, busiestPercent: 60, cores: 4, load: [1.3, 0.8, 0.5] },
    memory: { usedBytes: 12 * GB, totalBytes: 16 * GB },
    disk: { freeBytes: 250 * GB, totalBytes: 1000 * GB },
    process: { rssBytes: 200 * 2 ** 20, loopLagMs: 800, uptimeSeconds: 3601 },
    platformMs: 48,
    uptimeSeconds: 90_061,
  } satisfies SystemReading);
  // It is reported as it was read, and is a reading to whoever receives it.
  assert.deepEqual(seen.map((event) => event.type), ["system-update"]);
  assert.deepEqual(systemReadingOf(seen[0]!.data), reading);

  // Windows keeps no load average; a disk that cannot be read is not a disk with nothing on it.
  const windows = new SystemMonitor({
    emitter: new EventEmitter(), diskPath: "C:/checkouts",
    probe: fakeMachine({ platform: "win32", loadavg: () => [0, 0, 0], disk: async () => { throw new Error("EPERM"); } }),
  });
  const there = await windows.read();
  assert.deepEqual([there.cpu.load, there.disk, there.platformMs], [null, null, null]);

  // Measuring is never what stops a member: a reading that cannot be taken is not reported.
  const broken = new SystemMonitor({
    emitter, diskPath: "/checkouts",
    probe: fakeMachine({ cpuTimes: () => { throw new Error("no such thing"); } }),
  });
  assert.equal(await broken.report(), null);
  assert.equal(seen.length, 1);
});

test("this machine can be measured", async () => {
  const monitor = new SystemMonitor({ emitter: new EventEmitter(), diskPath: os.tmpdir() });
  await monitor.read();
  const reading = await monitor.read();
  assert.ok(reading.cpu.cores >= 1);
  assert.ok(reading.memory.totalBytes > 0 && reading.memory.usedBytes > 0 && reading.memory.usedBytes <= reading.memory.totalBytes);
  assert.ok(reading.disk !== null && reading.disk.totalBytes >= reading.disk.freeBytes, "the disk the temporary directory is on");
  assert.equal(reading.cpu.load === null, process.platform === "win32");
  assert.ok(reading.process.rssBytes > 0 && reading.uptimeSeconds > 0);
  assert.deepEqual(systemReadingOf(JSON.parse(JSON.stringify(reading))), reading, "and survives the journey");
});

test("a member reports its machine with everything else, and a console is brought up to date with it", async (t) => {
  const h = await harness(t);
  const enrolled = await enroll(h);
  const { member } = await startMember(t, h, { system: { intervalMs: 40, probe: fakeMachine() } });
  assert.ok(member.system !== null);

  await until("its machine to reach the platform", async () =>
    (await cachedEvents(h.platform.p, enrolled.memberId)).some((event) => event.type === "system-update"));
  const cached = (await h.state()).cached[enrolled.memberId] ?? [];
  const reading = systemReadingOf(cached.find((event) => event.type === "system-update")?.data);
  assert.equal(reading?.memory.totalBytes, 16 * GB);
  assert.deepEqual(reading?.disk, { freeBytes: 250 * GB, totalBytes: 1000 * GB });
  // How far away Shipyard is is measured on the calls the member makes anyway.
  assert.ok(typeof reading?.platformMs === "number" && reading.platformMs >= 0);
  assert.equal(cached.filter((event) => event.type === "system-update").length, 1, "the platform keeps the latest, not each");

  // Its reports say it is there: a member that measures needs no heartbeat besides.
  assert.equal((await h.state()).members[0]?.lastSeenAt !== null, true);

  // Stopped with the member, so nothing is reported by a process on its way out.
  await member.finish();
  const count = async () => (await h.state()).cached[enrolled.memberId]?.find((event) => event.type === "system-update")?.timestamp;
  const last = await count();
  await new Promise((resolve) => { setTimeout(resolve, 150); });
  assert.equal(await count(), last);
});
