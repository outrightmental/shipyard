import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitOf, sameCommit, shortCommit } from "../shared/release.js";
import { REPO_ROOT } from "./machine.js";

/**
 * A fleet member keeping itself on Shipyard's commit (#4).
 *
 * There is no staging: main is what the platform runs, and every answer the
 * platform gives a member names the commit it was deployed from. A member on
 * another commit brings itself to that one:
 *
 *   1. the checkout is on its branch (main) with no change to a tracked file;
 *   2. `git fetch origin main`, and the platform's commit is on it;
 *   3. main fast-forwards to exactly that commit: never past it, and never
 *      back (a checkout already past it waits for the platform's own deploy);
 *   4. the member exits with `RESTART_EXIT_CODE`, and its service starts it
 *      again. The runner the service starts (tools/fleet-runner.mjs) installs
 *      dependencies when the lockfile changed and rebuilds the dashboard
 *      before it starts the member — outside the member's own process, since
 *      a running process holds files open that an install has to replace.
 *
 * Steps 1 to 3 are done while the member is still working, so whatever stops
 * them (another branch, local changes, a fetch that fails, a commit main does
 * not have) stops nothing else: the member carries on with the commit it has,
 * says why it cannot update where an operator will see it, and tries again
 * later. Only once the checkout can be moved does the member stop taking new
 * work, let what it is running finish, move the checkout, and restart.
 */

/** The exit status that means "start me again, now": an update, or a change that needs a new process. */
export const RESTART_EXIT_CODE = 75;

const run = promisify(execFile);

export type GitRunner = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<string>;

/** git for an update: never prompts, and never inherits a repository from whatever started this process. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  if (!env["GIT_SSH_COMMAND"]) next["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes";
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"]) delete next[name];
  return next;
}

const realGit: GitRunner = async (args, { cwd, timeoutMs }) =>
  String((await run("git", args, { cwd, env: gitEnv(), timeout: timeoutMs, maxBuffer: 4 << 20 })).stdout ?? "").trim();

/** The last line a failed command said, or its error. */
function reason(error: unknown): string {
  const said = String((error as { stderr?: unknown })?.stderr ?? "").trim().split("\n").filter(Boolean);
  const last = said[said.length - 1];
  return (last ?? (error instanceof Error ? error.message : String(error))).slice(0, 300);
}

/** A yes/no git question: exit 0 is yes, exit 1 no, anything else a failure. */
async function gitYes(git: GitRunner, cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(args, { cwd, timeoutMs: 60_000 });
    return true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 1) return false;
    throw error;
  }
}

export type UpdateCode =
  | "NO_TARGET" | "NOT_A_CHECKOUT" | "NOT_ON_BRANCH" | "DIRTY_CHECKOUT" | "FETCH_FAILED" | "UNKNOWN_COMMIT" | "DIVERGED";

export type UpdateResult =
  /** HEAD is `to`; `moved` when it was not before. */
  | { ok: true; head: string; to: string; moved: boolean; ahead?: false }
  /** HEAD is already past `to`: it is not moved back. */
  | { ok: true; ahead: true; head: string; to: string; moved: false }
  | { ok: false; code: UpdateCode; message: string; head?: string };

export interface UpdateOptions {
  /** The commit to be on: the platform's. */
  target: string | null;
  root?: string;
  remote?: string;
  branch?: string;
  git?: GitRunner;
  /** Check that the checkout could be moved, and fetch, without moving it. */
  dryRun?: boolean;
}

/**
 * Bring the checkout at `root` to exactly the commit `target`: on `branch`
 * with no change to a tracked file; `git fetch <remote> <branch>`, which
 * never prompts for a credential; `target` on what was fetched; and a
 * fast-forward only — never past `target`, never back, never a push.
 *
 * With `dryRun`, everything but the fast-forward: the answer says whether it
 * would be done, and `moved` whether there is anything to do.
 */
export async function fastForwardTo(options: UpdateOptions): Promise<UpdateResult> {
  const root = options.root ?? REPO_ROOT;
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? "main";
  const git = options.git ?? realGit;
  const ask = (...args: string[]) => git(args, { cwd: root, timeoutMs: 120_000 });
  const failed = (code: UpdateCode, message: string, head?: string): UpdateResult =>
    ({ ok: false, code, message, ...(head ? { head } : {}) });

  const want = commitOf(options.target);
  if (!want) return failed("NO_TARGET", "the platform named no commit");

  let head: string | null;
  try {
    head = commitOf(await ask("rev-parse", "HEAD"));
  } catch (error) {
    return failed("NOT_A_CHECKOUT", `${root} is not a git checkout: ${reason(error)}`);
  }
  if (!head) return failed("NOT_A_CHECKOUT", `${root} has no commit checked out`);

  const on = await ask("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => null);
  if (on !== branch) {
    return failed("NOT_ON_BRANCH", `the checkout is on ${on ? `branch ${on}` : "a detached HEAD"}, not ${branch}: it is updated by hand`, head);
  }
  // ` M app.js`, `MM a`, `R  old -> new`: the status letters, then the path.
  const changed = (await ask("status", "--porcelain", "--untracked-files=no"))
    .split("\n").filter(Boolean).map((line) => line.trim().replace(/^\S+\s+/, ""));
  if (changed.length > 0) {
    const more = changed.length > 5 ? ` and ${changed.length - 5} more` : "";
    return failed("DIRTY_CHECKOUT", `local changes to ${changed.slice(0, 5).join(", ")}${more}: commit, stash or discard them`, head);
  }
  try {
    await ask("fetch", "--quiet", remote, branch);
  } catch (error) {
    return failed("FETCH_FAILED", `git fetch ${remote} ${branch}: ${reason(error)}`, head);
  }

  const to = commitOf(await ask("rev-parse", "--verify", "--quiet", `${want}^{commit}`).catch(() => ""));
  if (!to || !(await gitYes(git, root, ["merge-base", "--is-ancestor", to, "FETCH_HEAD"]).catch(() => false))) {
    return failed("UNKNOWN_COMMIT", `${shortCommit(want) ?? want} is not on ${remote}/${branch}`, head);
  }
  if (to === head) return { ok: true, head, to, moved: false };
  if (await gitYes(git, root, ["merge-base", "--is-ancestor", to, "HEAD"]).catch(() => false)) {
    return { ok: true, ahead: true, head, to, moved: false };
  }
  if (!(await gitYes(git, root, ["merge-base", "--is-ancestor", "HEAD", to]).catch(() => false))) {
    return failed("DIVERGED", `${branch} cannot fast-forward to ${shortCommit(to)}: it has commits of its own`, head);
  }
  if (options.dryRun) return { ok: true, head, to, moved: true };
  try {
    await ask("merge", "--ff-only", "--quiet", to);
  } catch (error) {
    return failed("DIVERGED", `${branch} cannot fast-forward to ${shortCommit(to)}: ${reason(error)}`, head);
  }
  return { ok: true, head, to, moved: true };
}

/** Whether a member on `running` has to move to be on the platform's `release`: never when the platform announces none. */
export function needsUpdate(release: string | null, running: string | null): boolean {
  return commitOf(release) !== null && !sameCommit(release, running);
}

/** Why a member cannot update itself, as the line an operator is shown. */
export function updateBlockedLine(result: UpdateResult, release: string | null): string {
  const to = shortCommit(release) ?? "the platform's commit";
  return result.ok ? "" : `cannot update itself to ${to}: ${result.message}`;
}
