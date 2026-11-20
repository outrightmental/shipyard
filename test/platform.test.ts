import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, LEGACY_SECRET_NAME, secretNameFor } from "../src/platform/github-app.js";
import { cachedSecrets, type Secrets } from "../src/platform/platform.js";
import { createJwtVerifier } from "../src/platform/jwt.js";
import { cachedEvents } from "../src/platform/relay.js";
import { readRepositoryLifecycle, unassignedRepos } from "../src/platform/tick.js";
import { fleetNotices } from "../src/shared/notices.js";
import { CENTRAL_MEMBER_ID, type ConsoleState, type FleetMember, type GitHubStatus, type MemberConfig } from "../src/shared/protocol.js";
import { isProcessKey, replayOp } from "../src/shared/replay-cache.js";
import { call, connect, enrollMachine, event, pushedTo, send, testPlatform } from "./platform-helpers.js";

// The platform (#2): the fleet, the repositories, the GitHub App and the event
// relay, run against a table in memory.

async function state(t: ReturnType<typeof testPlatform>): Promise<ConsoleState> {
  return (await call(t, "GET", "/api/state")).body as unknown as ConsoleState;
}

async function configOf(t: ReturnType<typeof testPlatform>, token: string): Promise<MemberConfig> {
  return (await call(t, "GET", "/fleet/config", undefined, { token })).body["config"] as MemberConfig;
}

// ── Who may call what ────────────────────────────────────────────────────────

test("healthz says which commit the platform runs, to anyone", async () => {
  const t = testPlatform({ release: "abcdef1234567890abcdef1234567890abcdef12" });
  const res = await call(t, "GET", "/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, service: "shipyard", release: "abcdef1234567890abcdef1234567890abcdef12" });
});

test("the console's API answers only a signed-in operator", async () => {
  const t = testPlatform();
  const res = await call(t, "GET", "/api/state", undefined, { operator: false });
  assert.equal(res.status, 401);
  assert.equal(res.body["code"], "NOT_SIGNED_IN");
});

test("the fleet's API answers only a fleet member's token", async () => {
  const t = testPlatform();
  assert.equal((await call(t, "POST", "/fleet/beat", {})).status, 401);
  assert.equal((await call(t, "POST", "/fleet/beat", {}, { token: "shp_m_0000000000_deadbeef" })).status, 401);
  assert.equal((await call(t, "POST", "/fleet/beat", {}, { token: "not-a-token" })).status, 401);
});

test("a path nothing answers is a 404 that says so", async () => {
  const t = testPlatform();
  const res = await call(t, "GET", "/nowhere");
  assert.equal(res.status, 404);
  assert.equal(res.body["ok"], false);
});

// ── Enrolling ────────────────────────────────────────────────────────────────

test("a code enrolls one machine, once, as a member assigned to nothing", async () => {
  const t = testPlatform();
  const code = (await call(t, "POST", "/api/fleet/enroll-codes")).body["code"] as string;
  assert.match(code, /^enr_[0-9a-f]{32}$/);

  const first = await call(t, "POST", "/enroll", { code, name: "atlas", host: { hostname: "atlas.local", platform: "darwin", cpus: 10 }, commit: "abc1234" });
  assert.equal(first.status, 200);
  assert.equal(first.body["name"], "atlas");
  assert.equal(first.body["reenrolled"], false);
  assert.equal(first.body["platformUrl"], "https://shipyard.test");
  assert.equal(first.body["wsUrl"], "wss://ws.shipyard.test");

  const again = await call(t, "POST", "/enroll", { code, name: "another" });
  assert.equal(again.status, 403);
  assert.equal(again.body["code"], "CODE_UNKNOWN");

  const { members } = await state(t);
  assert.equal(members.length, 1);
  assert.equal(members[0]!.name, "atlas");
  assert.deepEqual(members[0]!.repos, []);
  assert.equal(members[0]!.host?.hostname, "atlas.local");
  assert.equal(members[0]!.commit, "abc1234");
  assert.equal(members[0]!.enrolledBy, "operator@example.com");
});

test("the table never holds a code or a token, only their hashes", async () => {
  const t = testPlatform();
  const code = (await call(t, "POST", "/api/fleet/enroll-codes")).body["code"] as string;
  assert.ok(!JSON.stringify(t.table.all()).includes(code), "the code itself is not kept");
  const { token } = (await call(t, "POST", "/enroll", { code, name: "atlas" })).body as { token: string };
  assert.match(token, /^shp_m_[0-9a-f]+_[0-9a-f]{64}$/);
  const secret = token.split("_").pop()!;
  assert.ok(!JSON.stringify(t.table.all()).includes(secret), "the token's secret is not kept");
});

test("a code that has expired, or was never given out, enrolls no one", async () => {
  const t = testPlatform();
  const code = (await call(t, "POST", "/api/fleet/enroll-codes")).body["code"] as string;
  t.advance(15 * 60_000 + 1);
  const late = await call(t, "POST", "/enroll", { code, name: "atlas" });
  assert.equal(late.status, 403);
  assert.equal(late.body["code"], "CODE_EXPIRED");

  const unknown = await call(t, "POST", "/enroll", { code: "enr_00000000000000000000000000000000", name: "atlas" });
  assert.equal(unknown.body["code"], "CODE_UNKNOWN");
  assert.equal((await call(t, "POST", "/enroll", { name: "atlas" })).body["code"], "CODE_REQUIRED");
  assert.equal((await state(t)).members.length, 0);
});

test("a machine enrolling again stays the member it was: its name and repositories kept, its old token dead", async () => {
  const t = testPlatform();
  const first = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: first.memberId });

  const code = (await call(t, "POST", "/api/fleet/enroll-codes")).body["code"] as string;
  const second = await call(t, "POST", "/enroll", { code, previous: { memberId: first.memberId, token: first.token } });
  assert.equal(second.body["memberId"], first.memberId);
  assert.equal(second.body["reenrolled"], true);
  assert.equal(second.body["name"], "atlas");
  assert.notEqual(second.body["token"], first.token);

  assert.equal((await call(t, "GET", "/fleet/config", undefined, { token: first.token })).status, 401);
  const config = await configOf(t, second.body["token"] as string);
  assert.deepEqual(config.repos.map((repo) => repo.repo), ["acme/widgets"]);
  assert.equal((await state(t)).members.length, 1);
});

test("a machine offering someone else's enrollment becomes a new member, not that one", async () => {
  const t = testPlatform();
  const first = await enrollMachine(t, "atlas");
  const code = (await call(t, "POST", "/api/fleet/enroll-codes")).body["code"] as string;
  const second = await call(t, "POST", "/enroll", { code, name: "imposter", previous: { memberId: first.memberId, token: "shp_m_0000000000_00" } });
  assert.notEqual(second.body["memberId"], first.memberId);
  assert.equal((await call(t, "GET", "/fleet/config", undefined, { token: first.token })).status, 200);
});

// ── What a member is told ────────────────────────────────────────────────────

test("hello answers with the member's configuration, and its version moves when anything in it does", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  const hello = await call(t, "POST", "/fleet/hello", { boot: "b1", commit: "abc1234" }, { token: atlas.token });
  const config = hello.body["config"] as MemberConfig;
  assert.deepEqual(config.member, { id: atlas.memberId, name: "atlas" });
  assert.equal(config.maxConcurrency, 6, "six cylinders, until an operator says otherwise");
  assert.deepEqual(config.repos, []);
  assert.equal(config.github.ready, false);
  assert.equal(config.git, null, "no app yet, so no one for its commits to be by");
  assert.equal(config.wsUrl, "wss://ws.shipyard.test");
  assert.equal(config.release, t.p.settings.release);

  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId, settings: { maxConcurrency: 2, focusMode: true } });
  const assigned = await configOf(t, atlas.token);
  assert.notEqual(assigned.configVersion, config.configVersion);
  assert.deepEqual(assigned.repos, [{ repo: "acme/widgets", maxConcurrency: 2, focusMode: true }]);

  // A heartbeat's answer carries the version, so a member with no socket still hears.
  const beat = await call(t, "POST", "/fleet/beat", { boot: "b1" }, { token: atlas.token });
  assert.deepEqual(beat.body, { ok: true, release: t.p.settings.release, configVersion: assigned.configVersion });

  await call(t, "PATCH", `/api/fleet/${atlas.memberId}`, { maxConcurrency: 9, name: "atlas-2" });
  const resized = await configOf(t, atlas.token);
  assert.equal(resized.maxConcurrency, 9);
  assert.equal(resized.member.name, "atlas-2");
  assert.notEqual(resized.configVersion, assigned.configVersion);
});

test("how many cylinders a member has is its own: six to begin with, and set for it alone from the console", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  const borealis = await enrollMachine(t, "borealis");
  const sizes = async () => Object.fromEntries((await state(t)).members.map((member) => [member.name, member.maxConcurrency]));
  assert.deepEqual(await sizes(), { atlas: 6, borealis: 6 });

  const before = await configOf(t, borealis.token);
  const answer = await call(t, "PATCH", `/api/fleet/${atlas.memberId}`, { maxConcurrency: 2 });
  assert.deepEqual(answer.body["member"], { id: atlas.memberId, name: "atlas", maxConcurrency: 2 });

  // The console shows each member's own number, and each member is told its own.
  assert.deepEqual(await sizes(), { atlas: 2, borealis: 6 });
  assert.equal((await configOf(t, atlas.token)).maxConcurrency, 2);
  const after = await configOf(t, borealis.token);
  assert.equal(after.maxConcurrency, 6);
  assert.equal(after.configVersion, before.configVersion, "another member's size is no change to this one");

  // Enrolling the machine again keeps the number it was given.
  const code = (await call(t, "POST", "/api/fleet/enroll-codes")).body["code"] as string;
  const again = await call(t, "POST", "/enroll", { code, name: "atlas", previous: { memberId: atlas.memberId, token: atlas.token } });
  assert.equal(again.body["memberId"], atlas.memberId);
  assert.deepEqual(await sizes(), { atlas: 2, borealis: 6 });
});

test("a pool size that is not one is refused", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  for (const maxConcurrency of [0, 33, 2.5, "4"]) {
    const res = await call(t, "PATCH", `/api/fleet/${atlas.memberId}`, { maxConcurrency });
    assert.equal(res.status, 400, `${String(maxConcurrency)} is refused`);
  }
  assert.equal((await call(t, "PATCH", "/api/fleet/m_0000000000", { name: "x" })).status, 404);
});

test("a member's socket is poked when its configuration changes", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  assert.equal(await connect(t, "member-1", { memberToken: atlas.token }), 200);
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  assert.deepEqual(pushedTo(t, "member-1"), [{ t: "poke" }]);
});

// ── Repositories ─────────────────────────────────────────────────────────────

test("a repository is subscribed unassigned, and assigned to at most one member", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  const borealis = await enrollMachine(t, "borealis");

  const subscribed = await call(t, "PUT", "/api/repos/acme/widgets", {});
  assert.equal((subscribed.body["repo"] as { memberId: string | null }).memberId, null);

  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: borealis.memberId });
  assert.deepEqual((await configOf(t, atlas.token)).repos, []);
  assert.deepEqual((await configOf(t, borealis.token)).repos.map((repo) => repo.repo), ["acme/widgets"]);

  const { repos, members } = await state(t);
  assert.deepEqual(repos.map((repo) => [repo.repo, repo.memberId]), [["acme/widgets", borealis.memberId]]);
  assert.deepEqual(members.map((member) => [member.name, member.repos]), [["atlas", []], ["borealis", ["acme/widgets"]]]);
});

test("a repository cannot be assigned to a member that does not exist, nor named what a repository is not", async () => {
  const t = testPlatform();
  assert.equal((await call(t, "PUT", "/api/repos/acme/widgets", { memberId: "m_0000000000" })).status, 404);
  assert.equal((await call(t, "PUT", "/api/repos/acme/wid%20gets", {})).status, 400);
  assert.equal((await state(t)).repos.length, 0);
});

test("taking a repository from a member takes its work off that member's screen, online or not", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  const borealis = await enrollMachine(t, "borealis");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await call(t, "PUT", "/api/repos/acme/gadgets", { memberId: atlas.memberId });
  await connect(t, "console-1", { console: true });

  await call(t, "POST", "/fleet/events", {
    boot: "b1",
    events: [
      event("lifecycle-update", { repo: "acme/widgets", pairs: [{ issue: { number: 7 } }] }),
      event("lifecycle-update", { repo: "acme/gadgets", pairs: [{ issue: { number: 9 } }] }),
    ],
  }, { token: atlas.token });
  assert.equal((await cachedEvents(t.p, atlas.memberId)).length, 2);

  t.pushed.length = 0;
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: borealis.memberId });
  assert.deepEqual((await cachedEvents(t.p, atlas.memberId)).map((e) => e.data["repo"]), ["acme/gadgets"]);
  const toConsole = pushedTo(t, "console-1");
  const removal = toConsole.find((message) => message["t"] === "events") as { member: string; events: Array<{ type: string; data: { repo: string } }> };
  assert.equal(removal.member, atlas.memberId);
  assert.deepEqual(removal.events.map((e) => [e.type, e.data.repo]), [["project-removed", "acme/widgets"]]);
  assert.ok(toConsole.some((message) => message["t"] === "changed"));
});

test("a member speaks only for the repositories assigned to it", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await connect(t, "console-1", { console: true });
  t.pushed.length = 0;

  // A report for a repository taken from it a moment ago, already on its way.
  await call(t, "POST", "/fleet/events", {
    boot: "b1",
    events: [
      event("lifecycle-update", { repo: "acme/elsewhere", pairs: [] }),
      event("lifecycle-update", { repo: "acme/widgets", pairs: [] }),
      event("log-message", { message: "hello" }),
    ],
  }, { token: atlas.token });
  assert.deepEqual((await cachedEvents(t.p, atlas.memberId)).map((e) => e.data["repo"]), ["acme/widgets"]);
  const relayed = pushedTo(t, "console-1").find((message) => message["t"] === "events") as { events: Array<{ type: string; data: Record<string, unknown> }> };
  assert.deepEqual(relayed.events.map((e) => e.data["repo"] ?? e.type), ["acme/widgets", "log-message"]);
});

test("unsubscribing a repository stops its member working it", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await connect(t, "member-1", { memberToken: atlas.token });
  t.pushed.length = 0;
  assert.equal((await call(t, "DELETE", "/api/repos/acme/widgets")).status, 200);
  assert.deepEqual((await configOf(t, atlas.token)).repos, []);
  assert.deepEqual(pushedTo(t, "member-1"), [{ t: "poke" }]);
  assert.equal((await state(t)).repos.length, 0);
  // Unsubscribing from one that was never subscribed to is nothing, not an error.
  assert.equal((await call(t, "DELETE", "/api/repos/acme/never")).status, 200);
});

// ── The relay ────────────────────────────────────────────────────────────────

test("a member's events reach every open console, and the replayable ones a console opened later", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await connect(t, "console-1", { console: true });
  await connect(t, "console-2", { console: true });
  t.pushed.length = 0;

  const events = [
    event("iteration-start", { engineIndex: 0, iterationNumber: 3, maxConcurrency: 3 }),
    event("action-start", { actionIndex: 2, type: "self-review", repo: "acme/widgets", pullRequestNumber: 12 }),
    event("log-message", { message: "thinking" }),
    event("usage-update", { status: "ok", window: "five_hour", usedPercent: 41 }),
    event("lifecycle-update", { repo: "acme/widgets", pairs: [] }),
  ];
  const res = await call(t, "POST", "/fleet/events", { boot: "b1", events }, { token: atlas.token });
  assert.equal(res.status, 200);
  assert.equal(res.body["ok"], true);

  for (const connectionId of ["console-1", "console-2"]) {
    const relayed = pushedTo(t, connectionId).filter((message) => message["t"] === "events");
    assert.equal(relayed.length, 1);
    assert.equal(relayed[0]!["member"], atlas.memberId);
    assert.deepEqual((relayed[0]!["events"] as Array<{ type: string }>).map((e) => e.type), events.map((e) => e.type));
  }

  // A console opened now is brought up to date with what is state, not with what is history.
  const cached = (await state(t)).cached[atlas.memberId]!;
  assert.deepEqual(cached.map((e) => e.type).sort(), ["action-start", "iteration-start", "lifecycle-update", "usage-update"]);
});

test("only the last event under a key is kept, and a clearing event clears it", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "POST", "/fleet/events", {
    boot: "b1",
    events: [
      event("engine-idle", { engineIndex: 1, reason: "first" }),
      event("engine-idle", { engineIndex: 1, reason: "second" }),
      event("work-hold", { kind: "claude-usage-limit", untilMs: 1 }),
    ],
  }, { token: atlas.token });
  let cached = await cachedEvents(t.p, atlas.memberId);
  assert.deepEqual(cached.map((e) => e.data["reason"] ?? e.type), ["second", "work-hold"]);

  await call(t, "POST", "/fleet/events", { boot: "b1", events: [event("work-hold-cleared")] }, { token: atlas.token });
  cached = await cachedEvents(t.p, atlas.memberId);
  assert.deepEqual(cached.map((e) => e.type), ["engine-idle"]);
});

test("a member that starts again forgets what its last process was doing, and keeps its work", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await call(t, "POST", "/fleet/events", {
    boot: "b1",
    events: [
      event("action-start", { actionIndex: 1, type: "implementation" }),
      event("shutdown-requested"),
      event("work-hold", { kind: "claude-usage-limit", untilMs: 1 }),
      event("usage-update", { status: "ok" }),
      event("lifecycle-update", { repo: "acme/widgets", pairs: [] }),
    ],
  }, { token: atlas.token });
  await connect(t, "console-1", { console: true });
  t.pushed.length = 0;

  await call(t, "POST", "/fleet/hello", { boot: "b2" }, { token: atlas.token });
  assert.deepEqual((await cachedEvents(t.p, atlas.memberId)).map((e) => e.type).sort(), ["lifecycle-update", "usage-update"]);
  assert.ok(pushedTo(t, "console-1").some((message) => message["t"] === "member-reset" && message["member"] === atlas.memberId));

  // The same process again is not a restart.
  t.pushed.length = 0;
  await call(t, "POST", "/fleet/beat", { boot: "b2" }, { token: atlas.token });
  assert.ok(!pushedTo(t, "console-1").some((message) => message["t"] === "member-reset"));
});

test("a console whose socket has gone is forgotten, and the others still hear", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await connect(t, "console-1", { console: true });
  await connect(t, "console-2", { console: true });
  t.gone.add("console-1");
  t.pushed.length = 0;
  await call(t, "POST", "/fleet/events", { boot: "b1", events: [event("log-message", { message: "one" })] }, { token: atlas.token });
  await call(t, "POST", "/fleet/events", { boot: "b1", events: [event("log-message", { message: "two" })] }, { token: atlas.token });
  assert.equal(pushedTo(t, "console-2").filter((message) => message["t"] === "events").length, 2);
  assert.equal(t.table.all().filter((row) => row.PK === "CONN").length, 1);
});

test("what is not an event is dropped, and too many at once are refused", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await connect(t, "console-1", { console: true });
  t.pushed.length = 0;
  await call(t, "POST", "/fleet/events", { boot: "b1", events: [{ type: "usage-update" }, "nope", null, event("usage-update", { status: "ok" })] }, { token: atlas.token });
  const relayed = pushedTo(t, "console-1").find((message) => message["t"] === "events") as { events: unknown[] };
  assert.equal(relayed.events.length, 1);

  const many = Array.from({ length: 501 }, () => event("log-message", { message: "x" }));
  assert.equal((await call(t, "POST", "/fleet/events", { boot: "b1", events: many }, { token: atlas.token })).status, 413);
});

test("an event too large for a socket is kept for the consoles to read, and they are told to", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await connect(t, "console-1", { console: true });
  await call(t, "POST", "/fleet/hello", { boot: "b1" }, { token: atlas.token });
  t.pushed.length = 0;
  const pairs = Array.from({ length: 900 }, (_, i) => ({ issue: { number: i, title: `issue ${i} ${"x".repeat(120)}`, state: "open" }, prPhase: "absent" }));
  await call(t, "POST", "/fleet/events", { boot: "b1", events: [event("lifecycle-update", { repo: "acme/widgets", pairs })] }, { token: atlas.token });
  assert.deepEqual(pushedTo(t, "console-1").map((message) => message["t"]), ["resync"]);
  const cached = (await state(t)).cached[atlas.memberId]!;
  assert.equal((cached[0]!.data["pairs"] as unknown[]).length, 900);
});

// ── Presence, and what a member says about itself ────────────────────────────

test("a member is seen when it posts, and what it says is wrong with it is kept until it says otherwise", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  assert.equal((await state(t)).members[0]!.lastSeenAt, null);

  await call(t, "POST", "/fleet/beat", { boot: "b1", commit: "abc1234def", notes: [{ code: "UPDATE_BLOCKED", message: "local changes to src/index.ts" }] }, { token: atlas.token });
  let member = (await state(t)).members[0]!;
  assert.equal(member.lastSeenAt, new Date(t.nowMs()).toISOString());
  assert.equal(member.commit, "abc1234def");
  assert.deepEqual(member.notes.map((note) => [note.code, note.message]), [["UPDATE_BLOCKED", "local changes to src/index.ts"]]);

  // A beat that says nothing of notes leaves them; one that says there are none clears them.
  await call(t, "POST", "/fleet/beat", { boot: "b1" }, { token: atlas.token });
  assert.equal((await state(t)).members[0]!.notes.length, 1);
  await call(t, "POST", "/fleet/beat", { boot: "b1", notes: [] }, { token: atlas.token });
  member = (await state(t)).members[0]!;
  assert.deepEqual(member.notes, []);

  const status = await call(t, "GET", "/enroll/status", undefined, { token: atlas.token });
  assert.equal((status.body["member"] as { online: boolean }).online, true);
});

test("an open console is told each time a member is heard from, without having to read the fleet again", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await connect(t, "console-1", { console: true });

  // Heard from for the first time: that is the fleet changing, and the console reads it again.
  await call(t, "POST", "/fleet/beat", { boot: "b1" }, { token: atlas.token });
  assert.ok(pushedTo(t, "console-1").some((message) => message["t"] === "changed"));
  t.pushed.length = 0;

  // A working member posts every few seconds. When it was last heard from is
  // written every fifteen at most, and said as often as it is written.
  t.advance(5_000);
  await call(t, "POST", "/fleet/beat", { boot: "b1" }, { token: atlas.token });
  assert.deepEqual(pushedTo(t, "console-1"), []);

  t.advance(10_000);
  await call(t, "POST", "/fleet/events", { boot: "b1", events: [event("log-message", { message: "working" })] }, { token: atlas.token });
  const heardAt = new Date(t.nowMs()).toISOString();
  assert.deepEqual(pushedTo(t, "console-1").map((message) => message["t"]), ["seen", "events"]);
  assert.deepEqual(pushedTo(t, "console-1")[0], { t: "seen", member: atlas.memberId, at: heardAt });
  assert.equal((await state(t)).members[0]!.lastSeenAt, heardAt, "what the console is told is what the table holds");

  // An hour of nothing but heartbeats: nothing about the fleet changes, so the
  // console is never told to read it again, and is told every time all the same.
  t.pushed.length = 0;
  for (let beat = 0; beat < 180; beat++) {
    t.advance(20_000);
    await call(t, "POST", "/fleet/beat", { boot: "b1" }, { token: atlas.token });
  }
  const told = pushedTo(t, "console-1");
  assert.equal(told.length, 180);
  assert.ok(told.every((message) => message["t"] === "seen" && message["member"] === atlas.memberId));
  assert.equal(told.at(-1)!["at"], new Date(t.nowMs()).toISOString());

  // A console whose socket has gone holds no member's post up.
  t.gone.add("console-1");
  t.advance(20_000);
  assert.equal((await call(t, "POST", "/fleet/beat", { boot: "b1" }, { token: atlas.token })).status, 200);
});

test("a member holding a socket is connected, and is not once it lets go", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await connect(t, "member-1", { memberToken: atlas.token });
  assert.equal((await state(t)).members[0]!.connected, true);
  await (await import("../src/platform/ws.js")).handleSocket(t.p, { routeKey: "$disconnect", connectionId: "member-1", headers: {}, query: {}, body: "" });
  assert.equal((await state(t)).members[0]!.connected, false);
});

// ── Retiring ─────────────────────────────────────────────────────────────────

test("a retired member's token is dead, its repositories are no one's, and it is told to stop", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await call(t, "POST", "/fleet/events", { boot: "b1", events: [event("usage-update", { status: "ok" })] }, { token: atlas.token });
  await connect(t, "member-1", { memberToken: atlas.token });
  t.pushed.length = 0;

  const retired = await call(t, "DELETE", `/api/fleet/${atlas.memberId}`);
  assert.deepEqual(retired.body["released"], ["acme/widgets"]);
  assert.deepEqual(pushedTo(t, "member-1"), [{ t: "retired" }]);

  const after = await call(t, "POST", "/fleet/beat", {}, { token: atlas.token });
  assert.equal(after.status, 401);
  const { members, repos, cached } = await state(t);
  assert.equal(members.length, 0);
  assert.deepEqual(repos.map((repo) => [repo.repo, repo.memberId]), [["acme/widgets", null]]);
  assert.equal(cached[atlas.memberId], undefined);
  assert.equal((await cachedEvents(t.p, atlas.memberId)).length, 0);
  assert.equal(await connect(t, "member-2", { memberToken: atlas.token }), 401);
});

// ── The socket ───────────────────────────────────────────────────────────────

test("a socket is opened only by an operator's token or a fleet member's", async () => {
  const t = testPlatform();
  const { handleSocket } = await import("../src/platform/ws.js");
  const open = (query: Record<string, string>, headers: Record<string, string> = {}) =>
    handleSocket(t.p, { routeKey: "$connect", connectionId: "c", headers, query, body: "" });
  assert.equal((await open({})).statusCode, 401);
  assert.equal((await open({ token: "forged" })).statusCode, 401);
  assert.equal((await open({}, { authorization: "Bearer shp_m_0000000000_00" })).statusCode, 401);
  assert.equal(t.table.all().filter((row) => row.PK === "CONN").length, 0);
  assert.equal(await connect(t, "c", { console: true }), 200);
  assert.equal(await send(t, "c", { t: "ping" }), 200);
  assert.deepEqual(pushedTo(t, "c"), [{ t: "pong" }]);
  // A socket the platform does not know says nothing it acts on.
  assert.equal(await send(t, "stranger", { t: "approve", repo: "acme/widgets", pullRequestNumber: 1 }), 410);
});

test("an Approve press goes to the member the repository is assigned to", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  const borealis = await enrollMachine(t, "borealis");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await call(t, "PUT", "/api/repos/acme/gadgets", { memberId: borealis.memberId });
  await connect(t, "atlas-socket", { memberToken: atlas.token });
  await connect(t, "borealis-socket", { memberToken: borealis.token });
  await connect(t, "console-1", { console: true });
  t.pushed.length = 0;

  await send(t, "console-1", { t: "approve", repo: "acme/gadgets", pullRequestNumber: 44 });
  assert.deepEqual(pushedTo(t, "borealis-socket"), [
    { t: "command", command: "pull-request-approve", repo: "acme/gadgets", pullRequestNumber: 44, by: "operator@example.com" },
  ]);
  assert.deepEqual(pushedTo(t, "atlas-socket"), []);
  assert.deepEqual(pushedTo(t, "console-1"), []);
});

test("an Approve press no member can be handed is answered as refused, to the console that pressed", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await call(t, "PUT", "/api/repos/acme/orphan", {});
  await connect(t, "console-1", { console: true });
  await connect(t, "console-2", { console: true });
  t.pushed.length = 0;

  const refusalOf = (connectionId: string): Record<string, unknown> => {
    const message = pushedTo(t, connectionId).at(-1) as { t: string; member: string; events: Array<{ type: string; data: Record<string, unknown> }> };
    return { ...message.events[0]!.data, member: message.member, type: message.events[0]!.type };
  };

  // Its member is not connected.
  await send(t, "console-1", { t: "approve", repo: "acme/widgets", pullRequestNumber: 5 });
  let refusal = refusalOf("console-1");
  assert.equal(refusal["type"], "pull-request-approval");
  assert.equal(refusal["member"], atlas.memberId);
  assert.equal(refusal["state"], "refused");
  assert.match(String(refusal["reason"]), /not connected/);

  // It is assigned to no one.
  await send(t, "console-1", { t: "approve", repo: "acme/orphan", pullRequestNumber: 6 });
  refusal = refusalOf("console-1");
  assert.equal(refusal["member"], CENTRAL_MEMBER_ID);
  assert.match(String(refusal["reason"]), /no fleet member/);

  // It is not subscribed to at all.
  await send(t, "console-1", { t: "approve", repo: "acme/unknown", pullRequestNumber: 7 });
  assert.match(String(refusalOf("console-1")["reason"]), /not one Shipyard is subscribed to/);

  assert.deepEqual(pushedTo(t, "console-2"), [], "only the console that pressed is answered");
  // A press that names no PR is no card's.
  await send(t, "console-1", { t: "approve", repo: "acme/widgets", pullRequestNumber: "5" });
  assert.equal(pushedTo(t, "console-1").length, 3);
});

test("a fleet member's socket cannot make decisions", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  const borealis = await enrollMachine(t, "borealis");
  await call(t, "PUT", "/api/repos/acme/gadgets", { memberId: borealis.memberId });
  await connect(t, "atlas-socket", { memberToken: atlas.token });
  await connect(t, "borealis-socket", { memberToken: borealis.token });
  t.pushed.length = 0;
  await send(t, "atlas-socket", { t: "approve", repo: "acme/gadgets", pullRequestNumber: 44 });
  await send(t, "atlas-socket", { t: "cancel", member: borealis.memberId, engineIndex: 0 });
  assert.deepEqual(t.pushed, []);
});

test("a cancel goes to the member whose engine it is", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await connect(t, "atlas-socket", { memberToken: atlas.token });
  await connect(t, "console-1", { console: true });
  t.pushed.length = 0;
  await send(t, "console-1", { t: "cancel", member: atlas.memberId, engineIndex: 2 });
  assert.deepEqual(pushedTo(t, "atlas-socket"), [{ t: "command", command: "cylinder-cancel", engineIndex: 2, by: "operator@example.com" }]);
});

// ── GitHub ───────────────────────────────────────────────────────────────────

const { privateKey: APP_KEY, publicKey: APP_PUBLIC } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PEM = APP_KEY.export({ type: "pkcs1", format: "pem" }).toString();

/** A GitHub that has one app, installed on acme, seeing two repositories. */
function fakeGithub(t: ReturnType<typeof testPlatform>, options: { installed?: boolean; listing?: boolean } = {}) {
  const minted: Array<{ repositories?: string[] }> = [];
  t.onFetch((url, init) => {
    if (url.endsWith("/app-manifests/the-code/conversions")) {
      return new Response(JSON.stringify({
        id: 4242, slug: "shipyard-acme", name: "shipyard-acme", html_url: "https://github.com/apps/shipyard-acme",
        client_id: "Iv1.abc", client_secret: "client-secret", webhook_secret: "hook-secret", pem: APP_PEM, owner: { login: "acme" },
      }), { status: 201 });
    }
    if (url.endsWith("/users/shipyard-acme%5Bbot%5D")) return { id: 777, login: "shipyard-acme[bot]" };
    if (url.includes("/app/installations?")) {
      return options.installed === false ? [] : [{ id: 99, account: { login: "acme" }, repository_selection: "selected", html_url: "https://github.com/organizations/acme/settings/installations/99" }];
    }
    if (url.endsWith("/app/installations/99/access_tokens")) {
      const body = JSON.parse(init.body || "{}") as { repositories?: string[] };
      minted.push(body);
      // One name it cannot see among them, and GitHub mints nothing for the lot. It does not say which.
      if (body.repositories?.some((name) => name === "not-installed" || name === "formerly-widgets")) {
        return new Response(JSON.stringify({ message: "There is at least one repository that does not exist or is not accessible to the parent installation." }), { status: 422 });
      }
      return new Response(JSON.stringify({ token: `ghs_${minted.length}`, expires_at: "2026-11-15T13:00:00Z" }), { status: 201 });
    }
    // A name a repository was renamed from still answers a read, as the repository it now is.
    if (url.endsWith("/repos/acme/formerly-widgets")) return { full_name: "acme/widgets" };
    if (url.includes("/installation/repositories")) {
      if (options.listing === false) return new Response("{}", { status: 500 });
      return {
        repositories: [
          { full_name: "acme/widgets", private: true, archived: false, description: "Widgets", default_branch: "main", html_url: "https://github.com/acme/widgets" },
          { full_name: "acme/Gadgets", private: false, archived: false, description: null, default_branch: "trunk", html_url: "https://github.com/acme/Gadgets" },
        ],
      };
    }
    return undefined;
  });
  return { minted };
}

async function connectGithub(t: ReturnType<typeof testPlatform>): Promise<GitHubStatus> {
  const begun = await call(t, "POST", "/api/github/manifest", { org: "acme" });
  const done = await call(t, "POST", "/api/github/app", { code: "the-code", state: begun.body["state"] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body["github"] as GitHubStatus;
}

test("connecting GitHub: a manifest for the organization, redeemed only with the state it was sent with", async () => {
  const t = testPlatform();
  fakeGithub(t);
  const begun = await call(t, "POST", "/api/github/manifest", { org: "acme" });
  assert.equal(begun.body["action"], `https://github.com/organizations/acme/settings/apps/new?state=${String(begun.body["state"])}`);
  const manifest = begun.body["manifest"] as Record<string, unknown>;
  assert.equal(manifest["name"], "shipyard-acme");
  assert.equal(manifest["redirect_url"], "https://shipyard.test/");
  assert.equal(manifest["public"], false);
  assert.deepEqual(manifest["hook_attributes"], { url: "https://shipyard.test/hooks/github", active: true });
  const permissions = manifest["default_permissions"] as Record<string, string>;
  assert.equal(permissions["contents"], "write");
  assert.equal(permissions["pull_requests"], "write");
  assert.equal(permissions["workflows"], "write");

  const forged = await call(t, "POST", "/api/github/app", { code: "the-code", state: "not-the-state" });
  assert.equal(forged.status, 403);
  assert.equal(forged.body["code"], "STATE_MISMATCH");
  assert.equal((await state(t)).github.connected, false);

  const done = await call(t, "POST", "/api/github/app", { code: "the-code", state: begun.body["state"] });
  const github = done.body["github"] as GitHubStatus;
  assert.equal(github.connected, true);
  assert.equal(github.org, "acme");
  assert.deepEqual(github.app, { id: 4242, slug: "shipyard-acme", name: "shipyard-acme", htmlUrl: "https://github.com/apps/shipyard-acme", installUrl: "https://github.com/apps/shipyard-acme/installations/new" });
  assert.equal(github.installation, null);

  // The code is good once: the state it came with is spent.
  assert.equal((await call(t, "POST", "/api/github/app", { code: "the-code", state: begun.body["state"] })).status, 403);
  assert.equal((await call(t, "POST", "/api/github/manifest", { org: "acme" })).status, 409);
});

test("the app's key and secrets are kept out of the table", async () => {
  const t = testPlatform();
  fakeGithub(t);
  await connectGithub(t);
  const rows = JSON.stringify(t.table.all());
  assert.ok(!rows.includes("BEGIN RSA PRIVATE KEY"));
  assert.ok(!rows.includes("hook-secret"));
  assert.ok(!rows.includes("client-secret"));
  // Under a name of the app's own, so what is kept under a name never changes.
  assert.deepEqual([...t.secrets.keys()], [secretNameFor(4242)]);
  const kept = JSON.parse(t.secrets.get(secretNameFor(4242))!) as { pem: string; webhookSecret: string };
  assert.equal(kept.pem, APP_PEM);
  assert.equal(kept.webhookSecret, "hook-secret");
  assert.ok(!JSON.stringify(await state(t)).includes("hook-secret"));
});

test("an organization that is not a name is refused before anything is sent to GitHub", async () => {
  const t = testPlatform();
  for (const org of ["", "acme/widgets", "a b", undefined]) {
    assert.equal((await call(t, "POST", "/api/github/manifest", { org })).status, 400);
  }
  assert.equal(t.fetched.length, 0);
});

test("the installation is found once the operator has installed the app, and its repositories listed", async () => {
  const t = testPlatform();
  fakeGithub(t);
  await connectGithub(t);
  const refreshed = await call(t, "POST", "/api/github/refresh");
  const github = refreshed.body["github"] as GitHubStatus;
  assert.deepEqual(github.installation, { id: 99, account: "acme", repositorySelection: "selected", htmlUrl: "https://github.com/organizations/acme/settings/installations/99" });

  const listed = await call(t, "GET", "/api/github/repositories");
  assert.deepEqual((listed.body["available"] as Array<{ repo: string }>).map((repo) => repo.repo), ["acme/Gadgets", "acme/widgets"]);

  // The request for the installations was signed as the app.
  const asApp = t.fetched.find((request) => request.url.includes("/app/installations?"))!;
  const jwt = asApp.headers["authorization"]!.replace("Bearer ", "");
  const [header, payload, signature] = jwt.split(".") as [string, string, string];
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.ok(verifier.verify(APP_PUBLIC, Buffer.from(signature, "base64url")));
  assert.equal((JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss: string }).iss, "4242");
});

test("an app that is not installed anywhere mints nothing, and says what to do", async () => {
  const t = testPlatform();
  fakeGithub(t, { installed: false });
  await connectGithub(t);
  await call(t, "POST", "/api/github/refresh");
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  const res = await call(t, "POST", "/fleet/github-token", {}, { token: atlas.token });
  assert.equal(res.status, 409);
  assert.equal(res.body["code"], "GITHUB_NOT_INSTALLED");
  assert.equal((await configOf(t, atlas.token)).github.ready, false);
});

test("a member is minted a token for the repositories assigned to it, and no others", async () => {
  const t = testPlatform();
  const { minted } = fakeGithub(t);
  await connectGithub(t);
  await call(t, "POST", "/api/github/refresh");
  const atlas = await enrollMachine(t, "atlas");
  const borealis = await enrollMachine(t, "borealis");

  const none = await call(t, "POST", "/fleet/github-token", {}, { token: atlas.token });
  assert.equal(none.status, 409);
  assert.equal(none.body["code"], "NO_REPOSITORIES");
  assert.equal(minted.length, 0, "nothing is asked of GitHub for a member with no repositories");

  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await call(t, "PUT", "/api/repos/acme/Gadgets", { memberId: atlas.memberId });
  await call(t, "PUT", "/api/repos/acme/other", { memberId: borealis.memberId });
  minted.length = 0;
  const res = await call(t, "POST", "/fleet/github-token", {}, { token: atlas.token });
  assert.equal(res.status, 200);
  assert.equal(res.body["token"], "ghs_1");
  assert.equal(res.body["expiresAt"], "2026-11-15T13:00:00Z");
  assert.deepEqual(res.body["repos"], ["acme/Gadgets", "acme/widgets"]);
  assert.deepEqual(minted, [{ repositories: ["Gadgets", "widgets"] }]);
  const config = await configOf(t, atlas.token);
  assert.equal(config.github.ready, true);
  // Its commits are the app's own: the bot user, by the no-reply address GitHub links to it.
  assert.deepEqual(config.git, { name: "shipyard-acme[bot]", email: "777+shipyard-acme[bot]@users.noreply.github.com" });
});

test("a repository the app is not installed on is said, not passed over", async () => {
  const t = testPlatform();
  fakeGithub(t);
  await connectGithub(t);
  await call(t, "POST", "/api/github/refresh");
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/not-installed", { memberId: atlas.memberId });
  const res = await call(t, "POST", "/fleet/github-token", {}, { token: atlas.token });
  assert.equal(res.status, 502);
  assert.equal(res.body["code"], "GITHUB_REPO_NOT_INSTALLED");
  assert.match(String(res.body["remedy"]), /installation settings/);
});

test("a token GitHub will not mint names the repository it will not mint for, and what that is called now", async () => {
  const t = testPlatform();
  fakeGithub(t);
  await connectGithub(t);
  await call(t, "POST", "/api/github/refresh");
  const atlas = await enrollMachine(t, "atlas");
  const ask = () => call(t, "POST", "/fleet/github-token", {}, { token: atlas.token });
  await call(t, "PUT", "/api/repos/acme/widgets", { memberId: atlas.memberId });
  await call(t, "PUT", "/api/repos/acme/Gadgets", { memberId: atlas.memberId });

  // One the app is not installed on, among two it is: GitHub says only "at least one". Shipyard says which.
  await call(t, "PUT", "/api/repos/acme/not-installed", { memberId: atlas.memberId });
  let res = await ask();
  assert.equal(res.status, 502);
  assert.equal(res.body["error"], "GitHub would not mint a token: acme/not-installed is not a repository the app can see");
  assert.match(String(res.body["remedy"]), /installation settings/);
  await call(t, "DELETE", "/api/repos/acme/not-installed");

  // One subscribed to by a name it has been renamed from. The app can see the repository; not by that name.
  await call(t, "PUT", "/api/repos/acme/formerly-widgets", { memberId: atlas.memberId });
  res = await ask();
  assert.equal(res.status, 502);
  assert.equal(res.body["code"], "GITHUB_REPO_NOT_INSTALLED");
  assert.equal(res.body["error"], "GitHub would not mint a token: acme/formerly-widgets is called acme/widgets now");
  assert.match(String(res.body["remedy"]), /under the name it has now/);
  assert.doesNotMatch(String(res.body["remedy"]), /installation settings/, "the app is installed where it should be: nothing there needs changing");

  // Both at once: each is named, with what is wrong with it, and neither of the two that are fine.
  await call(t, "PUT", "/api/repos/acme/not-installed", { memberId: atlas.memberId });
  res = await ask();
  assert.equal(
    res.body["error"],
    "GitHub would not mint a token: acme/formerly-widgets is called acme/widgets now; acme/not-installed is not a repository the app can see",
  );
  assert.match(String(res.body["remedy"]), /under the name it has now/);
  assert.match(String(res.body["remedy"]), /installation settings/);

  // Taken away, the member is minted its token again.
  await call(t, "DELETE", "/api/repos/acme/not-installed");
  await call(t, "DELETE", "/api/repos/acme/formerly-widgets");
  assert.equal((await ask()).status, 200);
});

test("when which repository cannot be found out, GitHub's own words are passed on as they were", async () => {
  const t = testPlatform();
  fakeGithub(t, { listing: false });
  await connectGithub(t);
  await call(t, "POST", "/api/github/refresh");
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/not-installed", { memberId: atlas.memberId });
  const res = await call(t, "POST", "/fleet/github-token", {}, { token: atlas.token });
  assert.equal(res.status, 502);
  assert.equal(res.body["code"], "GITHUB_REPO_NOT_INSTALLED");
  assert.match(String(res.body["error"]), /^GitHub would not mint a token \(422\): .*at least one repository/);
  assert.match(String(res.body["remedy"]), /installation settings/);
});

test("disconnecting GitHub forgets the app and its key", async () => {
  const t = testPlatform();
  fakeGithub(t);
  await connectGithub(t);
  const res = await call(t, "DELETE", "/api/github");
  assert.equal((res.body["github"] as GitHubStatus).connected, false);
  assert.equal(t.secrets.size, 0);
  assert.equal((await call(t, "GET", "/api/github/repositories")).status, 409);
});

test("a webhook is taken only with the app's signature", async () => {
  const t = testPlatform();
  fakeGithub(t);
  await connectGithub(t);
  await connect(t, "console-1", { console: true });
  t.pushed.length = 0;
  const raw = JSON.stringify({ action: "created" });
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const hook = (signature: string | undefined, name = "installation") =>
    call(t, "POST", "/hooks/github", undefined, { raw, headers: { "x-github-event": name, ...(signature ? { "x-hub-signature-256": signature } : {}) } });

  assert.equal((await hook(undefined)).status, 401);
  assert.equal((await hook(sign("another-secret"))).status, 401);
  assert.equal((await hook("sha256=zz")).status, 401);
  assert.equal(pushedTo(t, "console-1").length, 0);

  // Installed: the platform finds the installation by itself, and the consoles are told.
  assert.equal((await hook(sign("hook-secret"))).status, 202);
  assert.equal((await state(t)).github.installation?.id, 99);
  assert.deepEqual(pushedTo(t, "console-1"), [{ t: "changed" }]);
  // An event it does nothing with is still taken.
  assert.equal((await hook(sign("hook-secret"), "ping")).status, 202);
});

test("the app's JWT is signed with its key, names it, and lasts under ten minutes", () => {
  const nowMs = Date.parse("2026-11-15T12:00:00Z");
  const [header, payload, signature] = appJwt(7, APP_PEM, nowMs).split(".") as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iat: number; exp: number; iss: string };
  assert.equal(claims.iss, "7");
  assert.equal(claims.iat, nowMs / 1000 - 60);
  assert.ok(claims.exp - nowMs / 1000 <= 600);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.ok(verifier.verify(APP_PUBLIC, Buffer.from(signature, "base64url")));
});

// ── Connecting again ─────────────────────────────────────────────────────────

/** Two apps on GitHub, each with a key of its own: a request is taken only when it is signed with the key of the app it says it is. */
function twoAppGithub(t: ReturnType<typeof testPlatform>) {
  const keys = new Map([1001, 1002].map((id) => [id, generateKeyPairSync("rsa", { modulusLength: 2048 })]));
  const pemOf = (id: number) => keys.get(id)!.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const refused = () => new Response(JSON.stringify({ message: "A JSON web token could not be decoded" }), { status: 401 });
  /** The app a request's JWT is truly from, or null when its signature is not that app's. */
  const signedBy = (authorization: string | undefined): number | null => {
    const [header, payload, signature] = (authorization ?? "").replace("Bearer ", "").split(".");
    if (!header || !payload || !signature) return null;
    const id = Number((JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss: string }).iss);
    const key = keys.get(id);
    if (!key) return null;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    return verifier.verify(key.publicKey, Buffer.from(signature, "base64url")) ? id : null;
  };
  t.onFetch((url) => {
    const conversion = /app-manifests\/code-(\d+)\/conversions$/.exec(url);
    if (conversion) {
      const id = Number(conversion[1]);
      return new Response(JSON.stringify({
        id, slug: `app-${id}`, name: `app-${id}`, html_url: `https://github.com/apps/app-${id}`,
        client_id: `c${id}`, client_secret: `s${id}`, webhook_secret: `hook-${id}`, pem: pemOf(id), owner: { login: "acme" },
      }), { status: 201 });
    }
    const authorization = t.fetched.at(-1)?.headers["authorization"];
    if (url.includes("/app/installations?")) {
      const id = signedBy(authorization);
      return id === null ? refused() : [{ id: id * 10, account: { login: "acme" }, repository_selection: "all", html_url: "" }];
    }
    const mint = /app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (mint) {
      const id = signedBy(authorization);
      if (id === null || id * 10 !== Number(mint[1])) return refused();
      return new Response(JSON.stringify({ token: `ghs_for_${id}`, expires_at: "2026-11-15T13:00:00Z" }), { status: 201 });
    }
    if (url.includes("/installation/repositories")) return { repositories: [] };
    return undefined;
  });
  return { pemOf };
}

/** `t`, as another instance of the function sees it: the same table and the same secret store, a memory of its own. */
function instanceOf(t: ReturnType<typeof testPlatform>): ReturnType<typeof testPlatform> {
  return { ...t, p: { ...t.p, secrets: cachedSecrets(t.p.secrets) } };
}

async function connectApp(t: ReturnType<typeof testPlatform>, id: number): Promise<void> {
  const begun = await call(t, "POST", "/api/github/manifest", { org: "acme" });
  const done = await call(t, "POST", "/api/github/app", { code: `code-${id}`, state: begun.body["state"] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
}

test("an app connected after another was disconnected is signed for with its own key, on every instance, at once", async () => {
  const t = testPlatform();
  twoAppGithub(t);
  // Two instances of the function, each remembering the secrets it has read.
  const [one, two] = [instanceOf(t), instanceOf(t)];

  await connectApp(one, 1001);
  // Both instances have now read, and remember, the first app's key.
  assert.equal((await call(one, "POST", "/api/github/refresh")).status, 200);
  assert.equal((await call(two, "POST", "/api/github/refresh")).status, 200);

  // The operator disconnects it and connects another, and each call lands on whichever instance it lands on.
  assert.equal((await call(one, "DELETE", "/api/github")).status, 200);
  await connectApp(one, 1002);

  // The instance that connected nothing still remembers the first app's key. It must not sign with it.
  const onTheOther = await call(two, "POST", "/api/github/refresh");
  assert.equal(onTheOther.status, 200, JSON.stringify(onTheOther.body));
  assert.equal((onTheOther.body["github"] as GitHubStatus).installation?.id, 10020);
  assert.equal((await call(two, "GET", "/api/github/repositories")).status, 200);
  assert.equal((await call(one, "GET", "/api/github/repositories")).status, 200);

  // And a webhook is checked against the second app's secret there too, not the first's.
  const raw = JSON.stringify({ action: "created" });
  const hook = (secret: string) => call(two, "POST", "/hooks/github", undefined, {
    raw, headers: { "x-github-event": "ping", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` },
  });
  assert.equal((await hook("hook-1002")).status, 202);
  assert.equal((await hook("hook-1001")).status, 401);

  // Only the second app's credentials are kept; the first's went when it was disconnected.
  assert.deepEqual([...t.secrets.keys()], [secretNameFor(1002)]);
});

test("an app whose credentials were kept under the one old name is still found, and is forgotten whole", async () => {
  const t = testPlatform();
  const { pemOf } = twoAppGithub(t);
  await connectApp(t, 1001);
  // As the build before this left it: under the one name, with none of the app's own.
  t.secrets.set(LEGACY_SECRET_NAME, t.secrets.get(secretNameFor(1001))!);
  t.secrets.delete(secretNameFor(1001));
  assert.equal(JSON.parse(t.secrets.get(LEGACY_SECRET_NAME)!).pem, pemOf(1001));

  assert.equal((await call(t, "POST", "/api/github/refresh")).status, 200);
  assert.equal((await call(t, "DELETE", "/api/github")).status, 200);
  assert.equal(t.secrets.size, 0);
});

test("a secret that was found is remembered for a while; that one is missing never is", async () => {
  let now = 0;
  const store = new Map<string, string>();
  let reads = 0;
  const inner: Secrets = {
    async get(name) { reads += 1; return store.get(name) ?? null; },
    async put(name, value) { store.set(name, value); },
    async delete(name) { store.delete(name); },
  };
  const secrets = cachedSecrets(inner, { keepMs: 1_000, now: () => now });

  // Missing is asked again every time: another instance may write it at any moment.
  assert.equal(await secrets.get("key"), null);
  store.set("key", "written elsewhere");
  assert.equal(await secrets.get("key"), "written elsewhere");
  assert.equal(reads, 2);

  // Found is kept, and not asked for again until it has aged out.
  assert.equal(await secrets.get("key"), "written elsewhere");
  assert.equal(reads, 2);
  now = 1_001;
  assert.equal(await secrets.get("key"), "written elsewhere");
  assert.equal(reads, 3);

  // What this instance writes and deletes it knows without asking.
  await secrets.put("key", "written here");
  assert.equal(await secrets.get("key"), "written here");
  await secrets.delete("key");
  assert.equal(await secrets.get("key"), null);
});

// ── The unassigned repositories ──────────────────────────────────────────────

test("an unassigned repository is read lightly: two listings, never a request per issue", async () => {
  const t = testPlatform();
  const issue = (number: number, extra: Record<string, unknown> = {}) => ({
    number, title: `Issue ${number}`, body: "", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", labels: [], milestone: null, ...extra,
  });
  // A hundred and thirty open issues, over two pages, and what the issue listing lists that is really a pull request.
  const issues = [
    ...Array.from({ length: 130 }, (_, i) => issue(i + 1)),
    issue(900, { pull_request: {} }),
    issue(131, { labels: [{ name: "manual" }] }),
    issue(132, { body: "blocked by #1" }),
  ];
  const pulls = [{
    number: 900, title: "Do the first thing", body: "Closes #1", created_at: "2026-11-03T00:00:00Z", updated_at: "2026-11-03T00:00:00Z",
    draft: true, labels: [], head: { sha: "abc", ref: "shipyard/issue-1" }, base: { ref: "main" },
  }];
  t.onFetch((url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    if (url.includes("/repos/acme/big/issues?state=open")) return issues.slice((page - 1) * 100, page * 100);
    if (url.includes("/repos/acme/big/pulls?state=open")) return page === 1 ? pulls : [];
    return undefined;
  });

  const event = await readRepositoryLifecycle(t.p, "acme/big", "ghs_token");
  assert.equal(t.fetched.length, 3, "two pages of issues and one of pull requests, however many issues there are");
  assert.ok(t.fetched.every((request) => request.headers["authorization"] === "Bearer ghs_token"));

  assert.equal(event?.type, "lifecycle-update");
  assert.equal(event?.data["repo"], "acme/big");
  assert.equal(event?.data["unassigned"], true, "said on the event, so a dashboard draws it as waiting on a fleet member");
  const pairs = event!.data["pairs"] as Array<{ issue: { number: number } | null; pr: { number: number; draft: boolean } | null; prPhase: string; blockedByIssueNumbers?: number[] }>;
  const byIssue = new Map(pairs.map((pair) => [pair.issue?.number, pair]));
  assert.equal(pairs.length, 131, "every open issue but the one labelled manual, and the pull request with the issue it closes");
  assert.deepEqual([byIssue.get(1)?.pr?.number, byIssue.get(1)?.pr?.draft, byIssue.get(1)?.prPhase], [900, true, "active"]);
  assert.equal(byIssue.get(2)?.pr, null);
  assert.equal(byIssue.has(131), false);
  assert.deepEqual(byIssue.get(132)?.blockedByIssueNumbers, [1], "a dependency written in an issue is read from it, with nothing asked of GitHub");
});

test("subscribing to a repository puts its work on the dashboard at once, as no one's", async () => {
  const t = testPlatform();
  fakeGithub(t);
  await connectGithub(t);
  await call(t, "POST", "/api/github/refresh");
  const github = t.fetched.length;
  await connect(t, "console-1", { console: true });
  t.pushed.length = 0;

  const subscribed = await call(t, "PUT", "/api/repos/acme/widgets", {});
  assert.equal(subscribed.status, 200);
  // A token, then the two listings (the fake GitHub has neither: the repository is read as empty or not at all).
  assert.ok(t.fetched.length - github <= 3, `subscribing asked GitHub ${t.fetched.length - github} things`);
  assert.ok(pushedTo(t, "console-1").some((message) => message["t"] === "changed"));
});

test("a repository is the platform's own to read while no active member has it", async () => {
  const t = testPlatform();
  const atlas = await enrollMachine(t, "atlas");
  await call(t, "PUT", "/api/repos/acme/assigned", { memberId: atlas.memberId });
  await call(t, "PUT", "/api/repos/acme/orphan", {});
  assert.deepEqual(await unassignedRepos(t.p), ["acme/orphan"]);
  await call(t, "DELETE", `/api/fleet/${atlas.memberId}`);
  assert.deepEqual(await unassignedRepos(t.p), ["acme/assigned", "acme/orphan"]);
});

test("with GitHub not connected the platform reads nothing, and says so without failing", async () => {
  const t = testPlatform();
  await call(t, "PUT", "/api/repos/acme/orphan", {});
  const res = await call(t, "POST", "/api/central/refresh");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body["read"], []);
  assert.equal(t.fetched.length, 0);
});

// ── Cognito id tokens ────────────────────────────────────────────────────────

test("a console's token is taken only if the user pool signed it, for this client, as an id token, and it has not expired", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
  const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test";
  const nowMs = Date.parse("2026-11-15T12:00:00Z");
  const verify = createJwtVerifier({ issuer, audience: "client-1", jwks: { keys: [jwk as never] }, now: () => nowMs });

  const sign = (claims: Record<string, unknown>, options: { kid?: string; key?: typeof privateKey } = {}) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: options.kid ?? "key-1" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(options.key ?? privateKey).toString("base64url")}`;
  };
  const good = { iss: issuer, aud: "client-1", token_use: "id", exp: nowMs / 1000 + 600, sub: "user-1", email: "operator@example.com" };

  assert.deepEqual(await verify(sign(good)), { sub: "user-1", email: "operator@example.com" });

  const refused = async (token: string, code: string) => {
    await assert.rejects(verify(token), (error: { code?: string }) => error.code === code, code);
  };
  await refused("not.a.token", "JWT_MALFORMED");
  await refused("nonsense", "JWT_MALFORMED");
  await refused(sign({ ...good, exp: nowMs / 1000 - 600 }), "JWT_EXPIRED");
  await refused(sign({ ...good, aud: "another-client" }), "JWT_AUDIENCE");
  await refused(sign({ ...good, iss: "https://example.com" }), "JWT_ISSUER");
  await refused(sign({ ...good, token_use: "access" }), "JWT_USE");
  await refused(sign(good, { kid: "key-2" }), "JWT_KEY");
  await refused(sign(good, { key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey }), "JWT_SIGNATURE");
  // The claims changed after signing.
  const [h, , s] = sign(good).split(".") as [string, string, string];
  await refused(`${h}.${Buffer.from(JSON.stringify({ ...good, sub: "user-2" })).toString("base64url")}.${s}`, "JWT_SIGNATURE");
});

// ── The replay cache's rule ──────────────────────────────────────────────────

test("the replay cache keeps state under a key of its own, and nothing that is only history", () => {
  assert.deepEqual(replayOp(event("lifecycle-update", { repo: "acme/widgets" })), { set: "lifecycle-update:acme/widgets" });
  assert.deepEqual(replayOp(event("snapshot-update", { repo: "acme/widgets" })), { set: "snapshot-update:acme/widgets" });
  assert.deepEqual(replayOp(event("action-start", { actionIndex: 3 })), { set: "cylinder-2" });
  assert.deepEqual(replayOp(event("action-error", {})), { set: "cylinder-0" });
  assert.deepEqual(replayOp(event("engine-idle", { engineIndex: 4 })), { set: "cylinder-4" });
  assert.deepEqual(replayOp(event("iteration-start", {})), { set: "cylinder-0" });
  assert.deepEqual(replayOp(event("work-hold")), { set: "work-hold" });
  assert.deepEqual(replayOp(event("work-hold-cleared")), { delete: ["work-hold"] });
  assert.deepEqual(replayOp(event("github-rate-limit-cleared")), { delete: ["github-rate-limit"] });
  assert.deepEqual(replayOp(event("pull-request-approval", { repo: "acme/widgets", pullRequestNumber: 9 })), { set: "pull-request-approval:acme/widgets#9" });
  assert.deepEqual(replayOp(event("project-removed", { repo: "acme/widgets" })), { delete: ["lifecycle-update:acme/widgets", "snapshot-update:acme/widgets"] });
  for (const type of ["log-message", "broadcast-commit", "phase-update", "cylinder-cancel", "pull-request-approve"]) {
    assert.deepEqual(replayOp(event(type)), {}, `${type} is not kept`);
  }
});

test("what a process was doing is told from the work it was doing it on", () => {
  for (const key of ["cylinder-0", "work-hold", "github-rate-limit", "shutdown-requested", "app-shutdown", "disk-space", "pull-request-approval:acme/widgets#9"]) {
    assert.ok(isProcessKey(key), `${key} goes with the process`);
  }
  for (const key of ["lifecycle-update:acme/widgets", "snapshot-update:acme/widgets", "usage-update"]) {
    assert.ok(!isProcessKey(key), `${key} outlives the process`);
  }
});

// ── Notices ──────────────────────────────────────────────────────────────────

test("the fleet says what is stopping work: nothing connected, nothing assigned, no one there", () => {
  const nowMs = Date.parse("2026-11-15T12:00:00Z");
  const member = (id: string, name: string, lastSeenAt: string | null, notes: FleetMember["notes"] = []): FleetMember => ({
    id, name, status: "active", enrolledAt: "2026-11-01T00:00:00Z", enrolledBy: null, lastSeenAt, commit: null, host: null,
    maxConcurrency: 3, repos: [], notes, connected: false,
  });
  const repo = (name: string, memberId: string | null) => ({ repo: name, memberId, subscribedAt: "2026-11-01T00:00:00Z", subscribedBy: null, settings: {} });
  const connected: GitHubStatus = {
    connected: true, org: "acme",
    app: { id: 1, slug: "s", name: "s", htmlUrl: "https://github.com/apps/s", installUrl: "https://github.com/apps/s/installations/new" },
    installation: { id: 9, account: "acme", repositorySelection: "all", htmlUrl: "" },
  };
  const kinds = (notices: ReturnType<typeof fleetNotices>) => notices.map((notice) => notice.kind);

  // Nothing set up at all.
  assert.deepEqual(kinds(fleetNotices({ members: [], repos: [], github: { connected: false, org: null, app: null, installation: null } }, nowMs)), ["github-not-connected", "no-fleet"]);
  // The app exists and is installed nowhere.
  assert.deepEqual(kinds(fleetNotices({ members: [member("m_1", "atlas", null)], repos: [], github: { ...connected, installation: null } }, nowMs)), ["github-not-installed", "member-unassigned"]);

  const fresh = new Date(nowMs - 10_000).toISOString();
  const stale = new Date(nowMs - 10 * 60_000).toISOString();
  const notices = fleetNotices({
    members: [
      member("m_1", "atlas", fresh),
      member("m_2", "borealis", stale),
      member("m_3", "cirrus", fresh),
      member("m_4", "dune", fresh, [{ code: "CLAUDE_AUTH", message: "log in with claude", at: fresh }]),
    ],
    repos: [repo("acme/a", "m_1"), repo("acme/b", "m_2"), repo("acme/c", null), repo("acme/d", "m_retired"), repo("acme/e", "m_4")],
    github: connected,
  }, nowMs);
  assert.deepEqual(notices, [
    { kind: "repo-unassigned", repo: "acme/c" },
    { kind: "repo-unassigned", repo: "acme/d" },
    { kind: "member-offline", memberId: "m_2", name: "borealis", repos: ["acme/b"], lastSeenAt: stale },
    { kind: "member-unassigned", memberId: "m_3", name: "cirrus" },
    { kind: "member-note", memberId: "m_4", name: "dune", code: "CLAUDE_AUTH", message: "log in with claude" },
  ]);

  // All in order: nothing to say.
  assert.deepEqual(fleetNotices({ members: [member("m_1", "atlas", fresh)], repos: [repo("acme/a", "m_1")], github: connected }, nowMs), []);
});
