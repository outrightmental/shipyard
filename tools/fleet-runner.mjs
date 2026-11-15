#!/usr/bin/env node
/**
 * Start this machine's fleet member, once: what its service runs (#4).
 *
 *   1. install dependencies, when package-lock.json is not the one they were
 *      last installed from: a new checkout, or an update that changed it;
 *   2. build the dashboard the member shows on its own screen;
 *   3. run the member, and exit with whatever it exits with.
 *
 * The member's service (src/fleet/service.ts) starts this again when it
 * exits: at once after 75 (the member updated its checkout, or must take a
 * new configuration), after a pause after a failure, and not at all after 0
 * (the member stopped for good).
 *
 * Steps 1 and 2 are here, outside the member, because a running member holds
 * files open that an install has to replace; and they are run on every start
 * rather than by the update, so a checkout updated by hand is as good as one
 * that updated itself.
 *
 * Plain JavaScript with nothing imported from the checkout: it must run
 * before the checkout's dependencies are there.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const say = (line) => process.stdout.write(`[${stamp()}] runner: ${line}\n`);

/** npm beside this Node (its npm-cli.js, run by this very binary), else `npm` on the PATH. */
function npm(args) {
  const beside = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((cli) => existsSync(cli));
  const options = { cwd: root, stdio: 'inherit', env: process.env };
  return beside
    ? spawnSync(process.execPath, [beside, ...args], options)
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { ...options, shell: process.platform === 'win32' });
}

function failed(what, result) {
  say(`${what} failed (${result.error ? result.error.message : `exit ${result.status}`}). Trying again when the service restarts this.`);
  process.exit(1);
}

// 1. Dependencies, when the lockfile is not the one they were installed from.
const lock = join(root, 'package-lock.json');
const installedFrom = join(root, 'node_modules', '.shipyard-installed-from');
const lockHash = createHash('sha256').update(readFileSync(lock)).digest('hex');
const installedHash = existsSync(installedFrom) ? readFileSync(installedFrom, 'utf8').trim() : null;
if (installedHash !== lockHash) {
  say(installedHash === null ? 'installing dependencies' : 'package-lock.json changed: installing dependencies');
  const install = npm(['ci', '--no-audit', '--no-fund']);
  if (install.status !== 0) failed('npm ci', install);
  mkdirSync(dirname(installedFrom), { recursive: true });
  writeFileSync(installedFrom, `${lockHash}\n`);
}

// 2. The dashboard the member shows on its own screen.
const build = npm(['run', '--silent', 'build:dashboard']);
if (build.status !== 0) failed('building the dashboard', build);

// 3. The member.
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const member = spawnSync(process.execPath, [tsx, join(root, 'src', 'index.ts'), '--fleet', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (member.error) failed('starting the member', member);
// A member ended by a signal is one the machine is shutting down: said as a failure, so it is started again.
process.exit(member.status ?? 1);
