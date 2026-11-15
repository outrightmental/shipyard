#!/usr/bin/env node
/**
 * Enroll this machine as a Shipyard fleet member (#4).
 *
 *   npm run enroll -- --code enr_<hex> [--platform https://shipyard.outright.io]
 *                     [--name <machine name>] [--home ~/.shipyard] [--no-service] [--dry-run]
 *
 * The code comes from the console (Fleet, Enroll a machine): it lasts fifteen
 * minutes and enrolls one machine, once. In order, the script:
 *
 *   1. looks at this machine: Node, git, the `claude` CLI and its login, and
 *      whether this checkout can keep itself on Shipyard's commit;
 *   2. redeems the code for this machine's token (<home>/token and
 *      <home>/fleet.json, readable only by this user);
 *   3. installs the member as a service and starts it: a sign-in script on
 *      Windows, a launchd agent on macOS, a systemd user unit on Linux;
 *   4. waits until Shipyard shows the machine online.
 *
 * One fleet member is one machine and one Claude account: enroll a machine
 * signed in to the account it is to work with. It starts assigned to nothing,
 * and is given work in the console (Repositories).
 *
 * Run it again with a new code to enroll again: the machine stays the member
 * it was, with its name and its repositories, and its old token stops working.
 */
import os from "node:os";
import { validateClaudeAuth } from "../src/claude-agent.js";
import { commandVersion, EnrollRefused, enrollMachine, waitUntilOnline } from "../src/fleet/enroll.js";
import { checkoutCommit, defaultHome, hostInfo, readEnrollment, readToken, REPO_ROOT } from "../src/fleet/machine.js";
import { installService } from "../src/fleet/service.js";
import { fastForwardTo } from "../src/fleet/update.js";
import { shortCommit } from "../src/shared/release.js";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const option = (name: string): string | null => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? null : null;
};
const say = (line = ""): void => { process.stdout.write(`${line}\n`); };
const ok = (line: string): void => say(`  ok  ${line}`);
const warn = (line: string): void => say(`  !!  ${line}`);

const code = option("code") ?? process.env["SHIPYARD_ENROLL_CODE"] ?? null;
const platformUrl = (option("platform") ?? process.env["SHIPYARD_PLATFORM_URL"] ?? "https://shipyard.outright.io").replace(/\/+$/, "");
const home = option("home") ?? defaultHome();
const name = option("name");
const dryRun = flag("dry-run");

if (flag("help") || !code) {
  say("usage: npm run enroll -- --code enr_<hex> [--platform <url>] [--name <machine>] [--home <dir>] [--no-service] [--dry-run]");
  say("       the code comes from the console: Fleet, Enroll a machine (it lasts fifteen minutes).");
  process.exit(code ? 0 : 2);
}

say(`Shipyard enroll: ${name ?? os.hostname()} -> ${platformUrl}${dryRun ? "  (dry run: nothing is changed)" : ""}`);
say(`  home:     ${home}`);
say(`  checkout: ${REPO_ROOT}`);

// 1. This machine.
say("\n1. This machine");
let ready = true;
const host = hostInfo();
if (Number(process.versions.node.split(".")[0]) >= 22) {
  ok(`Node ${process.versions.node} on ${host.platform}/${host.arch} (${host.cpus} cpus, ${host.totalMemoryMb} MB)`);
} else {
  warn(`Node ${process.versions.node}: a fleet member wants Node 22 or later`);
  ready = false;
}
const git = commandVersion("git");
if (git !== null) ok(git); else { warn("git was not found on the PATH: the member's engines cannot check anything out"); ready = false; }
const claude = commandVersion("claude");
if (claude !== null) ok(`claude ${claude}`); else { warn("the claude CLI was not found on the PATH: install Claude Code"); ready = false; }
const auth = await validateClaudeAuth();
if (auth.valid) {
  ok("the Claude CLI is logged in: this member works with that account's usage");
} else {
  warn(`the Claude CLI is not logged in (${auth.reason ?? "no credentials"}): run  claude login  as the account this member is to work with`);
  ready = false;
}
const commit = checkoutCommit();
const readiness = await fastForwardTo({ target: commit, dryRun: true }).catch(() => null);
if (!commit) {
  warn("this is not a git checkout: the member cannot keep itself on Shipyard's commit, and is updated by hand");
} else if (readiness && !readiness.ok) {
  warn(`on ${shortCommit(commit)}, but this checkout cannot update itself yet (${readiness.message}): the member will say so in Shipyard, and carry on with the commit it has`);
} else {
  ok(`on ${shortCommit(commit)}: this checkout keeps itself on the commit Shipyard runs`);
}
const earlier = readEnrollment(home);
if (earlier && readToken(home, {})) ok(`already enrolled as ${earlier.name} (${earlier.memberId}): it stays that member, with a new token`);
if (!ready) {
  say("\nNot enrolled: put right what is marked !! above and run this again. The code is not spent.");
  process.exit(1);
}

// 2. Enroll.
say("\n2. Enrolling at Shipyard");
let token: string | null = null;
if (dryRun) {
  say(`  would redeem the code at ${platformUrl}/enroll, then write ${home}/token and ${home}/fleet.json`);
} else {
  try {
    const enrolled = await enrollMachine({ platformUrl, code, name, home, host, commit });
    token = readToken(home, {});
    ok(`${enrolled.reenrolled ? "enrolled again" : "enrolled"} as ${enrolled.name} (${enrolled.memberId})`);
    ok(`token written to ${enrolled.files.token}`);
    if (!enrolled.reenrolled) say("      it is assigned no repository yet: give it work in the console, on the Repositories page");
  } catch (error) {
    if (error instanceof EnrollRefused) {
      warn(`enrollment refused (${error.code}): ${error.message}`);
      if (error.remedy) say(`      ${error.remedy}`);
    } else {
      warn(`enrollment failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

// 3. The service.
say("\n3. The member as a service");
let started = false;
if (flag("no-service")) {
  say("  skipped (--no-service): run it yourself with  npm run fleet");
} else {
  const service = installService({ home, dryRun });
  if (service.planned) {
    say(`  would write ${service.files.join(", ")} and start it`);
  } else if (service.installed) {
    ok(`${service.kind}: ${service.files.join(", ")} written, and the member started`);
    started = true;
  } else {
    warn(`${service.kind}: the member was not started`);
  }
  for (const hint of service.hints) say(`      ${hint}`);
}

// 4. Online?
say("\n4. Shipyard's view");
if (token && started) {
  say("  waiting for the member to report (it installs nothing new if this checkout already has its dependencies)…");
  if (await waitUntilOnline({ platformUrl, token, timeoutMs: 180_000 })) {
    ok("online: the console's Fleet page shows it, and its own dashboard opens in this machine's browser");
  } else {
    warn("not online yet: look at the member's log (above); the console's Fleet page shows it when it reports");
  }
} else if (token) {
  say("  start the member, and the console's Fleet page shows it online");
} else {
  say("  (dry run)");
}
say("\nDone.");
