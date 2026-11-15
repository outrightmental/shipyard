import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { DashboardServer, READ_ONLY_REASON } from "../src/dashboard-server.js";
import { EventEmitter, type DashboardEvent } from "../src/event-emitter.js";
import { YokeInbox } from "../src/dashboard/components/yoke-inbox.js";
import { ApiError, errorLine, type Api } from "../src/dashboard/console/api.js";
import { decodeClaims, readHandOff, sessionFromTokens, type Auth } from "../src/dashboard/console/auth.js";
import { normalizeConfig } from "../src/dashboard/console/config.js";
import { noticeCard, sumFleet } from "../src/dashboard/console/fleet-merge.js";
import { enrollCommands, memberStanding } from "../src/dashboard/console/fleet-page.js";
import { FleetStore } from "../src/dashboard/console/fleet-store.js";
import { repoRows } from "../src/dashboard/console/repos-page.js";
import { noticeCounts, pageOf } from "../src/dashboard/console/shipyard-app.js";
import { hitTest, layoutField, type HeaderNode } from "../src/dashboard/field/layout.js";
import { fieldModel } from "../src/dashboard/field/model.js";
import { buildInbox, inspect, READ_ONLY_HINT } from "../src/dashboard/shared/inbox.js";
import { workViews } from "../src/dashboard/shared/work-view.js";
import { dashboardReducer, DashboardStore, FAILURE_SHOW_MS, initialState, replayState } from "../src/dashboard/store/dashboard-store.js";
import type { DashboardState, LifecyclePair } from "../src/dashboard/store/types.js";
import { fleetNotices } from "../src/shared/notices.js";
import { CENTRAL_MEMBER_ID, type ConsoleState, type FleetMember, type GitHubStatus, type SubscribedRepo } from "../src/shared/protocol.js";
import { click, findTemplates, flatten, makeEvent, paintField, stateWith, tokensPalette, triplet } from "./dashboard-helpers.js";

// The console (#3): Shipyard's dashboard as the sum of its fleet's, the
// burning section grouped by fleet member with each member's own usage in its
// heading, what the fleet has to say as cards in the inbox, and a fleet
// member's own screen, which shows and takes no decisions.

const NOW = Date.parse("2026-11-15T12:00:00Z");
const at = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

const GITHUB: GitHubStatus = {
  connected: true, org: "acme",
  app: { id: 1, slug: "shipyard-acme", name: "shipyard-acme", htmlUrl: "https://github.com/apps/shipyard-acme", installUrl: "https://github.com/apps/shipyard-acme/installations/new" },
  installation: { id: 9, account: "acme", repositorySelection: "selected", htmlUrl: "" },
};

function member(id: string, name: string, repos: string[], overrides: Partial<FleetMember> = {}): FleetMember {
  return {
    id, name, status: "active", enrolledAt: at(-86_400_000), enrolledBy: null, lastSeenAt: at(-5_000), commit: "abc1234",
    host: null, maxConcurrency: 2, repos, notes: [], connected: true, ...overrides,
  };
}

const subscribed = (repo: string, memberId: string | null): SubscribedRepo =>
  ({ repo, memberId, subscribedAt: at(-86_400_000), subscribedBy: null, settings: {} });

function pair(issue: number, pr: number | null, overrides: Partial<LifecyclePair> = {}): LifecyclePair {
  return {
    issue: { number: issue, title: `Issue ${issue}`, state: "open" },
    pr: pr === null ? null : { number: pr, title: `PR ${pr}`, state: "open", draft: true, checksStatus: "success" },
    prPhase: pr === null ? "absent" : "active",
    ...overrides,
  };
}

const stamped = (type: string, data: Record<string, unknown> = {}) => makeEvent(type, data, at());

/** A member's own state: a pool of `engines`, the first of them running an action on `repo`. */
function memberState(repo: string, engines: number, options: { burning?: boolean; usedPercent?: number } = {}): DashboardState {
  let state = initialState();
  for (let i = 0; i < engines; i++) {
    state = dashboardReducer(state, stamped("iteration-start", { engineIndex: i, iterationNumber: 1, maxConcurrency: engines }));
  }
  state = dashboardReducer(state, stamped("lifecycle-update", { repo, pairs: [pair(7, 12), pair(8, null)] }));
  if (options.burning !== false) {
    state = dashboardReducer(state, stamped("action-start", {
      actionIndex: 1, totalActions: 1, type: "self-review", repo, issueNumber: 7, pullRequestNumber: 12, startedAt: NOW - 60_000,
    }));
  }
  state = dashboardReducer(state, stamped("usage-update", {
    status: "ok", window: "five_hour", usedPercent: options.usedPercent ?? 41, resetsAtMs: NOW + 2 * 3_600_000, fetchedAtMs: NOW,
  }));
  return state;
}

/** Two members, atlas on acme/widgets with two engines and borealis on acme/gadgets with three. */
function twoMembers(overrides: { borealis?: Partial<FleetMember>; states?: Map<string, DashboardState> } = {}) {
  const members = [member("m_a", "atlas", ["acme/widgets"]), member("m_b", "borealis", ["acme/gadgets"], { maxConcurrency: 3, ...overrides.borealis })];
  const states = overrides.states ?? new Map([
    ["m_a", memberState("acme/widgets", 2)],
    ["m_b", memberState("acme/gadgets", 3, { usedPercent: 93 })],
  ]);
  const fleet = { members, repos: [subscribed("acme/widgets", "m_a"), subscribed("acme/gadgets", "m_b")], github: GITHUB };
  return { fleet, states, sum: sumFleet({ fleet, states, connection: "connected", nowMs: NOW }) };
}

// ── The sum ──────────────────────────────────────────────────────────────────

test("the fleet's dashboard is the sum of its members': their engines side by side, each marked as its member's", () => {
  const { sum } = twoMembers();

  assert.equal(sum.cylinders.length, 5);
  assert.deepEqual(sum.cylinders.map((c) => [c.index, c.memberId, c.memberIndex, c.status]), [
    [1, "m_a", 1, "active"], [2, "m_a", 2, "idle"],
    [3, "m_b", 1, "active"], [4, "m_b", 2, "idle"], [5, "m_b", 3, "idle"],
  ]);
  // The repositories in the order of their names, whoever reported first.
  assert.deepEqual([...sum.lifecycleByRepo.keys()], ["acme/gadgets", "acme/widgets"]);
  assert.equal(sum.lastLifecyclePairs.length, 4);
  assert.deepEqual(sum.fleet?.map((crew) => [crew.id, crew.name, crew.online, crew.usage?.usedPercent, crew.repos]), [
    ["m_a", "atlas", true, 41, ["acme/widgets"]],
    ["m_b", "borealis", true, 93, ["acme/gadgets"]],
  ]);
  // What a pool's own dashboard says once is not one thing here: it is each member's.
  assert.equal(sum.usage, null);
  assert.equal(sum.hold, null);
  assert.equal(sum.shutdownRequested, false);
  assert.equal(sum.brand, "Shipyard");
  assert.equal(sum.title, "acme");
  assert.equal(sum.readOnly, false);
  assert.deepEqual(sum.notices, []);

  // Each engine is on its own member's work, never another's with the same number.
  const works = workViews(sum, NOW);
  const burning = works.filter((work) => work.engine !== null).map((work) => [work.repo, work.engine?.memberId]);
  assert.deepEqual(burning, [["acme/gadgets", "m_b"], ["acme/widgets", "m_a"]]);
});

test("a member that is not there keeps its heading, and its engines are left off the field until it is back", () => {
  const { sum } = twoMembers({ borealis: { lastSeenAt: at(-20 * 60_000), connected: false } });
  assert.deepEqual(sum.cylinders.map((c) => c.memberId), ["m_a", "m_a"]);
  assert.deepEqual(sum.fleet?.map((crew) => [crew.name, crew.online]), [["atlas", true], ["borealis", false]]);
  // Its work is still its repository's, and still on the field.
  assert.ok(sum.lifecycleByRepo.has("acme/gadgets"));
  assert.deepEqual(sum.notices.map((notice) => [notice.id, notice.accent]), [["member-offline:m_b", "alarm"]]);
  assert.match(sum.notices[0]!.line, /last heard from 20m/);

  const model = fieldModel(sum, NOW);
  assert.deepEqual(model.crews?.map((crew) => [crew.name, crew.engines, crew.note.tone]), [["atlas", 2, "plain"], ["borealis", 0, "down"]]);
  assert.match(model.crews![1]!.note.text, /^offline · last heard from 20m/);
});

test("a member speaks only for the repositories assigned to it, and the platform's reading fills in the ones that are no one's", () => {
  // atlas still holds a lifecycle for a repository that has since been taken from it.
  let atlas = memberState("acme/widgets", 2);
  atlas = dashboardReducer(atlas, stamped("lifecycle-update", { repo: "acme/moved", pairs: [pair(1, null)] }));
  let central = initialState();
  central = dashboardReducer(central, stamped("lifecycle-update", { repo: "acme/orphan", unassigned: true, pairs: [pair(3, 30), pair(4, null)] }));
  // The platform's reading of a repository a member now has gives way to the member's.
  central = dashboardReducer(central, stamped("lifecycle-update", { repo: "acme/widgets", unassigned: true, pairs: [pair(99, null)] }));

  const fleet = {
    members: [member("m_a", "atlas", ["acme/widgets"])],
    repos: [subscribed("acme/widgets", "m_a"), subscribed("acme/orphan", null)],
    github: GITHUB,
  };
  const sum = sumFleet({ fleet, states: new Map([["m_a", atlas], [CENTRAL_MEMBER_ID, central]]), connection: "connected", nowMs: NOW });

  assert.deepEqual([...sum.lifecycleByRepo.keys()], ["acme/orphan", "acme/widgets"]);
  assert.deepEqual(sum.lifecycleByRepo.get("acme/widgets")?.map((p) => p.issue?.number), [7, 8]);
  assert.deepEqual(sum.notices.map((notice) => notice.id), ["repo-unassigned:acme/orphan"]);

  // Unassigned work waits on an operator, whatever its checks are doing, and says so in a word.
  const orphan = workViews(sum, NOW).filter((work) => work.repo === "acme/orphan");
  assert.deepEqual(orphan.map((work) => [work.number, work.level, work.status.brief, work.status.signal]), [
    [3, "waiting", "unassigned", null],
    [4, "waiting", "unassigned", null],
  ]);
  assert.ok(orphan.every((work) => work.opacity < 1), "drawn dimmed, like anything waiting on someone else");
});

test("with no fleet and no GitHub the sum is empty, and says what to do first", () => {
  const fleet = { members: [], repos: [], github: { connected: false, org: null, app: null, installation: null } };
  const sum = sumFleet({ fleet, states: new Map(), connection: "connecting", nowMs: NOW });
  assert.deepEqual(sum.fleet, []);
  assert.equal(sum.cylinders.length, 0);
  assert.equal(sum.title, "Shipyard");
  assert.deepEqual(sum.notices.map((notice) => [notice.id, notice.action?.page]), [["github-not-connected", "repositories"], ["no-fleet", "fleet"]]);
  const model = fieldModel(sum, NOW);
  assert.deepEqual(model.crews, []);
  assert.equal(model.vitals.subtitle, "0 fleet members");
});

// ── The field: a group for each member ───────────────────────────────────────

test("the burning section is a group for each fleet member, headed by its name, its engines and its own Claude usage", () => {
  const { sum } = twoMembers();
  const painted = paintField(sum, { nowMs: NOW, viewport: { width: 1600, height: 1000 } });
  const { model, layout } = painted;

  assert.deepEqual(model.crews?.map((crew) => [crew.name, crew.burning, crew.engines, crew.usage.percentText]), [
    ["atlas", 1, 2, "41%"],
    ["borealis", 1, 3, "93%"],
  ]);

  const headers = layout.nodes.filter((node): node is HeaderNode => node.kind === "header");
  assert.deepEqual(headers.map((node) => [node.heads, node.crewId || node.repo, node.count, node.total]), [
    ["member", "m_a", 1, 2],
    ["member", "m_b", 1, 3],
    ["project", "acme/gadgets", 1, null],
    ["project", "acme/widgets", 1, null],
  ]);
  assert.ok(!headers.some((node) => node.heads === "burning"), "no one heading for every engine");

  // Every engine is drawn under its own member's heading, and above the next member's.
  const [atlasHead, borealisHead] = headers;
  const engineNodes = layout.nodes.filter((node) => node.kind === "engine");
  for (const node of engineNodes) {
    if (node.kind !== "engine") continue;
    const mine = node.engine.memberId === "m_a";
    assert.ok(mine ? node.rect.y > atlasHead!.rect.y && node.rect.y < borealisHead!.rect.y : node.rect.y > borealisHead!.rect.y,
      `engine ${node.engine.index} is under its own member's heading`);
  }
  assert.equal(engineNodes.length, 5);

  // The top of the field has no one gauge, cycle or countdown: each is a member's.
  assert.deepEqual(layout.hud.slots.map((slot) => slot.kind), []);

  // What is painted: each member's name, count and reading, in trim; borealis's nearly used-up window in red.
  const palette = tokensPalette();
  for (const text of ["ATLAS", "1/2", "CLAUDE 5H 41%", "BOREALIS", "1/3", "CLAUDE 5H 93%"]) {
    assert.ok(painted.texts.includes(text), `"${text}" is drawn`);
  }
  assert.equal(painted.texts.filter((text) => text.startsWith("RESETS IN 2H")).length, 2, "and when each member's window resets");
  assert.equal(painted.inkOf("CLAUDE 5H 41%")?.rgb, triplet(palette.trimBright));
  assert.equal(painted.inkOf("CLAUDE 5H 93%")?.rgb, triplet(palette.red));
  // Each ring says its engine's number in its own pool: both members have an engine 1.
  assert.equal(painted.texts.filter((text) => text === "ENGINE 1").length, 2);
  assert.ok(!painted.texts.includes("ENGINE 3"));
  // Under the title, what this is a dashboard of.
  assert.ok(painted.texts.some((text) => text === "SHIPYARD · 2 FLEET MEMBERS · 2 REPOSITORIES"), painted.texts.slice(0, 4).join(" | "));
});

test("a member's heading says what is holding it up in orange, and that it is not there in red", () => {
  const palette = tokensPalette();
  let held = memberState("acme/widgets", 2, { burning: false });
  held = dashboardReducer(held, stamped("work-hold", { kind: "claude-usage-limit", reason: "Claude usage limit", untilMs: NOW + 90 * 60_000 }));
  const states = new Map([["m_a", held], ["m_b", memberState("acme/gadgets", 3)]]);

  // Date.now() is what the store checks a hold against as it arrives: the hold above ends well after it.
  const { sum } = twoMembers({ states, borealis: { lastSeenAt: null, connected: false } });
  const painted = paintField(sum, { nowMs: NOW, viewport: { width: 1600, height: 1000 } });
  const [atlas, borealis] = painted.model.crews!;

  assert.equal(atlas!.note.tone, "held");
  assert.match(atlas!.note.text, /^waiting 1h 30m until .* for Claude usage limit$/);
  assert.equal(atlas!.usage.percentText, "LIMIT", "the gauge reads LIMIT while the limit holds its pool");
  assert.equal(painted.inkOf(atlas!.note.text)?.rgb, triplet(palette.orange));

  assert.deepEqual([borealis!.note.text, borealis!.note.tone], ["has not connected yet", "down"]);
  assert.equal(painted.inkOf("has not connected yet")?.rgb, triplet(palette.red));

  // A member with nothing to work on says so, and that is a hold too.
  const idle = sumFleet({
    fleet: { members: [member("m_a", "atlas", [])], repos: [], github: GITHUB },
    states: new Map([["m_a", memberState("acme/widgets", 2, { burning: false })]]),
    connection: "connected", nowMs: NOW,
  });
  assert.deepEqual(fieldModel(idle, NOW).crews?.map((crew) => [crew.note.text, crew.note.tone]), [["assigned no repositories", "held"]]);
});

test("a member's heading can be picked out, and says more about the member", () => {
  const { sum } = twoMembers();
  const model = fieldModel(sum, NOW);
  const layout = layoutField(model, { width: 1600, height: 1000, railWidth: 0, lampWidth: 0 });
  const header = layout.nodes.find((node): node is HeaderNode => node.kind === "header" && node.crewId === "m_b")!;
  const hit = hitTest(layout, layout.scroll.x + header.rect.x + 10, layout.scroll.y + header.rect.y + 10, 0);
  assert.equal(hit?.kind, "crew");
  assert.equal(hit?.kind === "crew" ? hit.id : null, "m_b");

  const works = workViews(sum, NOW);
  const said = inspect({ kind: "crew", id: "m_b" }, {
    works, engines: [], usageHeading: "", usageTitle: "", hold: null, crews: model.crews,
  });
  assert.equal(said?.eyebrow, "Fleet member");
  assert.equal(said?.title, "borealis");
  assert.deepEqual(said?.facts, ["1 of 3 engines burning"]);
  assert.match(said!.body.join(" "), /93% of the 5-hour window used/);
  assert.match(said!.body.join(" "), /Works acme\/gadgets\./);
  assert.equal(inspect({ kind: "crew", id: "m_gone" }, { works, engines: [], usageHeading: "", usageTitle: "", hold: null, crews: model.crews }), null);
});

test("a pool's own dashboard is drawn as it always was: one heading, one gauge along the top", () => {
  const state = stateWith([pair(7, 12)], "o/a");
  const painted = paintField(state, { nowMs: NOW });
  assert.equal(painted.model.crews, null);
  const headers = painted.layout.nodes.filter((node): node is HeaderNode => node.kind === "header");
  assert.deepEqual(headers.map((node) => node.heads), ["burning", "project"]);
  assert.ok(painted.layout.hud.slots.some((slot) => slot.kind === "usage"));
  assert.ok(painted.texts.includes("BURNING"));
});

// ── The inbox: what the fleet has to say ─────────────────────────────────────

test("what the fleet has to say is first in the inbox, each with a button that goes where it is put right", () => {
  const fleet = {
    members: [member("m_a", "atlas", [])],
    repos: [subscribed("acme/orphan", null)],
    github: { ...GITHUB, installation: null },
  };
  const sum = sumFleet({ fleet, states: new Map(), connection: "connected", nowMs: NOW });
  const cards = buildInbox({
    works: workViews(sum, NOW), failures: [], keepAwake: "awake", notices: sum.notices,
    dismissed: new Set(), arrivals: new Map(), nowMs: NOW, failureShowMs: FAILURE_SHOW_MS,
  });

  assert.deepEqual(cards.map((card) => [card.id, card.source, card.accent, card.action?.type]), [
    ["fleet:github-not-installed", "fleet", "warning", "open"],
    ["fleet:member-unassigned:m_a", "fleet", "warning", "navigate"],
    ["fleet:repo-unassigned:acme/orphan", "fleet", "warning", "navigate"],
  ]);
  const install = cards[0]!.action;
  assert.equal(install?.type === "open" ? install.href : null, "https://github.com/apps/shipyard-acme/installations/new");
  assert.ok(cards.every((card) => !card.dismissible), "each stands until what it says is no longer so");

  // The button says where it goes, and the inbox passes that on for the console to act on.
  const inbox = new YokeInbox();
  Object.assign(inbox, { cards, multiProject: true, open: true });
  const heard: string[] = [];
  inbox.addEventListener("inbox-navigate", (event) => heard.push((event as CustomEvent<string>).detail));
  const template = inbox.render();
  const buttons = flatten(template).match(/Assign it[^<]*/g) ?? [];
  assert.equal(buttons.length, 2);
  const orphan = findTemplates(template, 'class="inbox-action open navigate"').find((button) => flatten(button).includes("acme/orphan"));
  click(orphan);
  assert.deepEqual(heard, ["repositories"]);
});

test("every notice becomes a card that says what is wrong and what it stops", () => {
  const notices = fleetNotices({
    members: [
      member("m_a", "atlas", ["acme/a"], { lastSeenAt: null }),
      member("m_b", "borealis", ["acme/b"], { notes: [{ code: "CLAUDE_AUTH", message: "its Claude login has lapsed: run claude login", at: at() }] }),
    ],
    repos: [subscribed("acme/a", "m_a"), subscribed("acme/b", "m_b")],
    github: GITHUB,
  }, NOW);
  const cards = notices.map((notice) => noticeCard(notice, NOW));
  assert.deepEqual(cards.map((card) => [card.eyebrow, card.title, card.accent]), [
    ["Fleet member offline", "atlas", "alarm"],
    ["borealis", "its Claude login has lapsed: run claude login", "alarm"],
  ]);
  assert.match(cards[0]!.line, /has not connected since it was enrolled/);
  assert.deepEqual(cards[0]!.facts, ["acme/a"]);
});

// ── A fleet member's own screen ──────────────────────────────────────────────

test("a fleet member's own screen shows what is waiting, with a button that cannot be pressed and says where to press", () => {
  const parked = pair(1, 10, { prPhase: "review", approval: "awaiting-approval" });
  parked.pr!.draft = false;
  const state = stateWith([parked], "o/a", { readOnly: true, brand: "Shipyard" });
  const input = {
    works: workViews(state, NOW), failures: [], keepAwake: "awake" as const, dismissed: new Set<string>(),
    arrivals: new Map<string, number>(), nowMs: NOW, failureShowMs: FAILURE_SHOW_MS,
  };

  const [open] = buildInbox(input);
  assert.deepEqual(open?.action?.type === "approve" ? [open.action.label, open.action.disabled] : null, ["Approve", false]);

  const [shown] = buildInbox({ ...input, readOnly: true });
  assert.equal(shown?.id, open?.id, "the same card");
  assert.equal(shown?.eyebrow, "Approve to merge", "saying the same thing");
  assert.deepEqual(
    shown?.action?.type === "approve" ? [shown.action.label, shown.action.disabled, shown.action.hint] : null,
    ["Approve in Shipyard", true, READ_ONLY_HINT],
  );
});

test("a read-only store sends no Approve press, whatever asked it to", () => {
  const store = new DashboardStore();
  try {
    const sent: unknown[] = [];
    Object.assign(store, { _wsClient: { send: (message: unknown) => { sent.push(message); return true; }, close() {} } });
    Object.assign(store, { _state: { ...store.getState(), readOnly: true } });
    assert.equal(store.approvePullRequest({ repo: "o/a", pullRequestNumber: 10 }), false);
    assert.deepEqual(sent, []);
    assert.equal(store.getState().approvalPresses.size, 0);
  } finally {
    store.disconnect();
  }
});

test("a fleet member's dashboard server says it is read-only, and refuses a press that reaches it anyway", async (t) => {
  const port = 19_690;
  const emitter = new EventEmitter();
  const heard: string[] = [];
  emitter.subscribe((event) => { if (event.type === "pull-request-approve" || event.type === "cylinder-cancel") heard.push(event.type); });
  const server = new DashboardServer({
    port, host: "127.0.0.1", owner: "", repo: "", multiProject: true, projects: ["o/a"], eventEmitter: emitter,
    readOnly: true, brand: "Shipyard", dashboardTitle: "atlas",
  });
  await server.start();
  t.after(() => server.close());

  const described = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as Record<string, unknown>;
  assert.equal(described["readOnly"], true);
  assert.equal(described["brand"], "Shipyard");

  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const answers: DashboardEvent[] = [];
  socket.on("message", (data: Buffer) => { answers.push(JSON.parse(data.toString()) as DashboardEvent); });
  await new Promise<void>((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "pull-request-approve-request", repo: "o/a", pullRequestNumber: 10 }));
  socket.send(JSON.stringify({ type: "cylinder-cancel-request", engineIndex: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  socket.close();

  assert.deepEqual(heard, [], "neither reaches the engine pool");
  assert.deepEqual(answers.map((event) => [event.type, event.data["state"], event.data["reason"]]), [
    ["pull-request-approval", "refused", READ_ONLY_REASON],
  ]);

  // The projects it is a dashboard of can change while it runs.
  server.setProjects(["o/a", "o/b"]);
  const after = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as Record<string, unknown>;
  assert.deepEqual(after["projects"], ["o/a", "o/b"]);
  assert.equal(after["multiProject"], true);
});

// ── A repository taken away ──────────────────────────────────────────────────

test("a repository taken away from a pool leaves its dashboard, with what was being followed about it", () => {
  let state = stateWith([pair(7, 12)], "o/a");
  state = dashboardReducer(state, stamped("lifecycle-update", { repo: "o/b", pairs: [pair(1, 2)] }));
  state = dashboardReducer(state, stamped("snapshot-update", { repo: "o/b", sessionCount: 2, issueCount: 1, prCount: 1 }));
  state = dashboardReducer(state, stamped("action-start", { actionIndex: 1, totalActions: 1, type: "self-review", repo: "o/b", pullRequestNumber: 2 }));
  state = dashboardReducer(state, stamped("action-error", { actionIndex: 1, totalActions: 1, repo: "o/b", error: "boom" }));
  assert.equal(state.failures.size, 1);

  const removed = dashboardReducer(state, stamped("project-removed", { repo: "o/b" }));
  assert.deepEqual([...removed.lifecycleByRepo.keys()], ["o/a"]);
  assert.deepEqual(removed.lastLifecyclePairs.map((p) => p.repo), ["o/a"]);
  assert.equal(removed.sessionCount, 0);
  assert.equal(removed.failures.size, 0);
  assert.match(removed.eventStream.at(-1)!.text, /o\/b is no longer assigned here/);
  // One it never had is nothing.
  assert.equal(dashboardReducer(removed, stamped("project-removed", { repo: "o/never" })), removed);
});

test("a state rebuilt from a replay keeps the presses and failures the replay cannot know of", () => {
  let previous = stateWith([pair(7, 12)], "o/a");
  previous = { ...previous, connection: "disconnected" };
  previous = dashboardReducer(previous, stamped("action-start", { actionIndex: 1, totalActions: 1, type: "self-review", repo: "o/a", pullRequestNumber: 12 }));
  previous = dashboardReducer(previous, stamped("action-error", { actionIndex: 1, totalActions: 1, repo: "o/a", error: "boom" }));
  const rebuilt = replayState(previous, [stamped("lifecycle-update", { repo: "o/a", pairs: [pair(7, 12)] })], (fresh) => { fresh.title = "atlas"; });
  assert.equal(rebuilt.connection, "disconnected", "the connection is the socket's to say");
  assert.equal(rebuilt.failures.size, 1);
  assert.equal(rebuilt.title, "atlas");
  assert.equal(rebuilt.lastLifecyclePairs.length, 1);
});

// ── The console's store ──────────────────────────────────────────────────────

/** A WebSocket the test drives: it opens when told to, and remembers what was sent up it. */
class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.last = this;
  }
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  open() { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event("open")); }
  push(message: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) })); }
}

async function startedStore(t: { after: (fn: () => void) => void }, state: Partial<ConsoleState>) {
  const real = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  const reads: string[] = [];
  let answer: ConsoleState = {
    release: null, serverTimeMs: Date.now(), operator: { email: "operator@example.com" },
    members: [], repos: [], github: GITHUB, cached: {}, ...state,
  };
  const api = {
    get: async (path: string) => { reads.push(`GET ${path}`); return { ok: true, ...answer }; },
    post: async (path: string) => { reads.push(`POST ${path}`); return { ok: true }; },
  } as unknown as Api;
  const auth = { idToken: async () => "the-token" } as unknown as Auth;
  const store = new FleetStore(api, auth, "wss://ws.shipyard.test");
  t.after(() => {
    store.stop();
    (globalThis as { WebSocket: unknown }).WebSocket = real;
  });
  store.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const socket = FakeSocket.last!;
  socket.open();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { store, socket, reads, setAnswer(next: Partial<ConsoleState>) { answer = { ...answer, ...next }; } };
}

test("the console's store reads the fleet, then follows every member's events down one socket", async (t) => {
  const atlas = member("m_a", "atlas", ["acme/widgets"], { lastSeenAt: new Date().toISOString() });
  const { store, socket, reads } = await startedStore(t, {
    members: [atlas],
    repos: [subscribed("acme/widgets", "m_a")],
    cached: { m_a: [makeEvent("lifecycle-update", { repo: "acme/widgets", pairs: [pair(7, 12)] })] },
  });

  assert.equal(socket.url, "wss://ws.shipyard.test?token=the-token");
  assert.deepEqual(reads, ["GET /state"]);
  assert.equal(store.view.loaded, true);
  assert.equal(store.view.connection, "connected");
  let sum = store.getState();
  assert.deepEqual([...sum.lifecycleByRepo.keys()], ["acme/widgets"]);
  // Its pool is the size it was configured at, before any of its engines has said so.
  assert.equal(sum.cylinders.length, 2);

  socket.push({ t: "events", member: "m_a", events: [
    makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "self-review", repo: "acme/widgets", issueNumber: 7, pullRequestNumber: 12 }),
    makeEvent("usage-update", { status: "ok", window: "seven_day", usedPercent: 12, fetchedAtMs: Date.now() }),
  ] });
  sum = store.getState();
  assert.equal(sum.cylinders[0]?.status, "active");
  assert.equal(sum.fleet?.[0]?.usage?.usedPercent, 12);

  // The member started again: its engines forget, its work and its usage do not.
  socket.push({ t: "member-reset", member: "m_a" });
  sum = store.getState();
  assert.equal(sum.cylinders[0]?.status, "idle");
  assert.equal(sum.lastLifecyclePairs.length, 1);
  assert.equal(sum.fleet?.[0]?.usage?.usedPercent, 12);
});

test("an Approve press in the console goes up the socket, and is followed with the member whose repository it is", async (t) => {
  const parked = pair(1, 10, { prPhase: "review", approval: "awaiting-approval" });
  parked.pr!.draft = false;
  const atlas = member("m_a", "atlas", ["acme/widgets"], { lastSeenAt: new Date().toISOString() });
  const { store, socket } = await startedStore(t, {
    members: [atlas],
    repos: [subscribed("acme/widgets", "m_a")],
    cached: { m_a: [makeEvent("lifecycle-update", { repo: "acme/widgets", pairs: [parked] })] },
  });

  assert.equal(store.approvePullRequest({ repo: "acme/widgets", pullRequestNumber: 10 }), true);
  assert.deepEqual(socket.sent, [{ t: "approve", repo: "acme/widgets", pullRequestNumber: 10 }]);
  assert.equal(store.hasPress({ repo: "acme/widgets", pullRequestNumber: 10 }), true);

  // The member's answer arrives as one of its own events, and the card follows it.
  socket.push({ t: "events", member: "m_a", events: [
    makeEvent("pull-request-approval", { repo: "acme/widgets", pullRequestNumber: 10, requestedAt: new Date().toISOString(), state: "approved" }),
  ] });
  const work = workViews(store.getState(), Date.now()).find((candidate) => candidate.pair.pr?.number === 10)!;
  assert.equal(work.approval.approved, true);
  assert.equal(work.status.signal, "approved");
});

test("when the fleet changes the store reads it again, once, and what happens meanwhile is not lost", async (t) => {
  const atlas = member("m_a", "atlas", ["acme/widgets"], { lastSeenAt: new Date().toISOString() });
  const { store, socket, reads, setAnswer } = await startedStore(t, { members: [atlas], repos: [subscribed("acme/widgets", "m_a")] });

  setAnswer({ members: [atlas, member("m_b", "borealis", [], { lastSeenAt: new Date().toISOString() })] });
  socket.push({ t: "changed" });
  socket.push({ t: "changed" });
  socket.push({ t: "changed" });
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.deepEqual(reads, ["GET /state", "GET /state"], "three in a row are one read");
  assert.deepEqual(store.view.members.map((m) => m.name), ["atlas", "borealis"]);
  assert.deepEqual(store.getState().notices.map((notice) => notice.id), ["member-unassigned:m_b"]);
});

// ── The console's own logic ──────────────────────────────────────────────────

test("an address names a page, and anything else is the dashboard", () => {
  assert.equal(pageOf(""), "dashboard");
  assert.equal(pageOf("#/"), "dashboard");
  assert.equal(pageOf("#/fleet"), "fleet");
  assert.equal(pageOf("#/repositories?x=1"), "repositories");
  assert.equal(pageOf("#/nonsense"), "dashboard");
  // The tokens a sign-in hands back are not a page.
  assert.equal(pageOf("#state=abc&id_token=x"), "dashboard");
});

test("the menu counts each notice on the page where it is put right", () => {
  const counts = noticeCounts([
    { kind: "github-not-connected" },
    { kind: "no-fleet" },
    { kind: "repo-unassigned", repo: "acme/a" },
    { kind: "member-unassigned", memberId: "m_a", name: "atlas" },
    { kind: "member-offline", memberId: "m_b", name: "borealis", repos: ["acme/b"], lastSeenAt: null },
    { kind: "member-note", memberId: "m_b", name: "borealis", code: "X", message: "y" },
  ]);
  assert.deepEqual(counts, { dashboard: 0, fleet: 3, repositories: 3 });
});

test("the repositories listed are the ones the app can see and the ones subscribed to, subscribed first", () => {
  const available = ["acme/zeta", "acme/Alpha", "acme/mid"].map((repo) => ({
    repo, private: false, archived: false, description: null, defaultBranch: "main", htmlUrl: `https://github.com/${repo}`,
  }));
  const rows = repoRows(available, [subscribed("acme/mid", "m_a"), subscribed("acme/gone", null)]);
  assert.deepEqual(rows.map((row) => [row.repo, row.subscribed !== null, row.available !== null]), [
    ["acme/gone", true, false],
    ["acme/mid", true, true],
    ["acme/Alpha", false, true],
    ["acme/zeta", false, true],
  ]);
});

test("a member's standing is said in a word, by the platform's clock", () => {
  const release = "0123456789abcdef0123456789abcdef01234567";
  const on = member("m_a", "atlas", [], { commit: release });
  assert.deepEqual(memberStanding(on, release, NOW), { word: "online", tone: "ok", detail: "connected" });
  assert.equal(memberStanding({ ...on, connected: false }, release, NOW).tone, "ok");
  assert.match(memberStanding({ ...on, connected: false }, release, NOW).detail, /next heartbeat/);
  assert.deepEqual(memberStanding({ ...on, lastSeenAt: null }, release, NOW).word, "not connected yet");
  const off = memberStanding({ ...on, lastSeenAt: at(-10 * 60_000) }, release, NOW);
  assert.deepEqual([off.word, off.tone], ["offline", "down"]);
  assert.match(off.detail, /^last heard from 10m/);
  const behind = memberStanding({ ...on, commit: "abc1234" }, release, NOW);
  assert.deepEqual([behind.word, behind.tone], ["updating", "held"]);
  assert.match(behind.detail, /on abc1234, bringing itself to 0123456/);
  // A platform applied by hand announces no commit, and holds no member to one.
  assert.equal(memberStanding({ ...on, commit: "abc1234" }, null, NOW).word, "online");
  const wrong = memberStanding({ ...on, notes: [{ code: "CLAUDE_AUTH", message: "log in", at: at() }] }, release, NOW);
  assert.deepEqual([wrong.word, wrong.tone, wrong.detail], ["needs attention", "down", "log in"]);
});

test("a machine is told what to run with the code it was given", () => {
  assert.deepEqual(enrollCommands("enr_abc").at(-1), "npm run enroll -- --code enr_abc");
  assert.ok(enrollCommands("enr_abc")[0]!.includes("github.com/outrightmental/shipyard"));
});

test("config.json is taken as it is written, and one that names no sign-in is refused", () => {
  const config = normalizeConfig({
    apiBase: "/api/", wsUrl: "wss://ws.shipyard.test/", release: "abc1234",
    cognito: { domain: "https://auth.shipyard.test/", clientId: "client", redirectUri: "https://shipyard.test/", region: "us-east-1" },
  });
  assert.deepEqual(config, {
    apiBase: "/api", wsUrl: "wss://ws.shipyard.test", release: "abc1234",
    cognito: { domain: "https://auth.shipyard.test", clientId: "client", redirectUri: "https://shipyard.test/", region: "us-east-1" },
  });
  assert.throws(() => normalizeConfig({ wsUrl: "wss://x" }), /names no sign-in/);
  assert.throws(() => normalizeConfig({ cognito: { domain: "d", clientId: "c", region: "r" } }), /names no WebSocket/);
});

test("the tokens a sign-in hands back are read from the fragment, and a console route is not mistaken for them", () => {
  const claims = { sub: "user-1", email: "operator@example.com", exp: Math.floor(NOW / 1000) + 3600 };
  const token = `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  assert.deepEqual(decodeClaims(token), claims);
  assert.equal(decodeClaims("nonsense"), null);

  assert.equal(readHandOff("#/fleet"), null);
  assert.equal(readHandOff(""), null);
  assert.equal(readHandOff("#state=abc"), null);
  const handOff = readHandOff(`#state=abc&id_token=${token}&refresh_token=r&expires_in=3600`);
  assert.equal(handOff?.state, "abc");

  const session = sessionFromTokens(handOff!.tokens, NOW);
  assert.equal(session?.expiresAt, claims.exp * 1000);
  assert.deepEqual(session?.operator, { sub: "user-1", email: "operator@example.com", name: "operator@example.com" });
  assert.equal(session?.refreshToken, "r");
  // A refresh answers no new refresh token: the one in hand is kept.
  assert.equal(sessionFromTokens({ id_token: token }, NOW, session)?.refreshToken, "r");
  assert.equal(sessionFromTokens({ id_token: null }, NOW), null);
});

test("what went wrong is said with what to do about it, when the platform said", () => {
  assert.equal(errorLine(new ApiError(409, "X", "the app is not installed", "install it")), "the app is not installed — install it");
  assert.equal(errorLine(new ApiError(500, "X", "it broke")), "it broke");
  assert.equal(errorLine(new Error("plain")), "plain");
});
