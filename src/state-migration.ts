import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where Shipyard kept its state while it was still called Yoke (renamed to
 * Shipyard on 2026-11-20). Read-only: each is moved once, at startup, to where
 * Shipyard keeps it now (see {@link migrateLegacyState}), so an upgraded
 * machine keeps its checkouts, its unpushed commits, its session stores and
 * so its phase history. Nothing is ever written under these names.
 */
export const LEGACY_STATE_DIR_NAME = ".yoke";
/** The process log's name inside the state directory before the rename. */
export const LEGACY_LOG_FILE_NAME = "yoke.log";

/** Shipyard's state directory, both in the home directory and in the working directory. */
export const STATE_DIR_NAME = ".shipyard";
export const LOG_FILE_NAME = "shipyard.log";

export interface StateMove {
  from: string;
  to: string;
}

export interface StateMigrationReport {
  moved: StateMove[];
  failed: Array<StateMove & { error: string }>;
  /** Canonical clones whose worktree links were repaired after their checkouts moved. */
  repaired: string[];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Move `from` to `to` when there is something at `from` and nothing yet at `to`. */
function moveOnce(from: string, to: string, report: StateMigrationReport): boolean {
  if (!existsSync(from) || existsSync(to)) return false;
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    report.moved.push({ from, to });
    return true;
  } catch (error) {
    report.failed.push({ from, to, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * After a checkout root has been moved, point every linked worktree and its
 * canonical clone (`<root>/<owner>-<repo>/_main`) back at each other: both
 * sides record the other by absolute path, and `git worktree repair` run in the
 * canonical clone with each worktree's new path rewrites both. A repository
 * whose links cannot be repaired is left as it is; the engine already
 * recreates a checkout it cannot use.
 */
export function repairWorktreeLinks(checkoutRoot: string, report: StateMigrationReport): void {
  let repos: string[];
  try {
    repos = readdirSync(checkoutRoot);
  } catch {
    return;
  }
  for (const repo of repos) {
    const repoDir = join(checkoutRoot, repo);
    const canonicalDir = join(repoDir, "_main");
    if (!isDirectory(join(canonicalDir, ".git"))) continue;
    const worktrees = readdirSync(repoDir)
      .filter((name) => name !== "_main")
      .map((name) => join(repoDir, name))
      // A linked worktree's `.git` is a file naming its git dir; a directory is a clone of its own.
      .filter((dir) => existsSync(join(dir, ".git")) && !isDirectory(join(dir, ".git")));
    if (worktrees.length === 0) continue;
    try {
      execFileSync("git", ["worktree", "repair", ...worktrees], { cwd: canonicalDir, stdio: "ignore" });
      report.repaired.push(canonicalDir);
    } catch (error) {
      report.failed.push({
        from: canonicalDir,
        to: canonicalDir,
        error: `git worktree repair: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

/**
 * Move what Shipyard kept under its earlier name to where it keeps it now:
 *
 * - `<cwd>/.yoke/` (the session stores and the process log) to `<cwd>/.shipyard/`,
 *   and the log in it from `yoke.log` to `shipyard.log`;
 * - `~/.yoke/checkouts` and `~/.yoke/tmp` to `~/.shipyard/checkouts` and
 *   `~/.shipyard/tmp`, repairing the moved checkouts' worktree links. Only
 *   these two are moved: `~/.shipyard` may already be a fleet member's home.
 *
 * Each move happens once, and only when nothing is at the new path yet, so it
 * never overwrites anything and is a no-op on every later start. A move that
 * fails (a file held open on Windows, say) is reported and tried again at the
 * next start; until then the checkouts are read where they are (see
 * `defaultCheckoutRootDir`). Synchronous: it runs before anything opens them.
 */
export function migrateLegacyState(options: { home?: string; cwd?: string } = {}): StateMigrationReport {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const report: StateMigrationReport = { moved: [], failed: [], repaired: [] };

  const localState = join(cwd, STATE_DIR_NAME);
  moveOnce(join(cwd, LEGACY_STATE_DIR_NAME), localState, report);
  moveOnce(join(localState, LEGACY_LOG_FILE_NAME), join(localState, LOG_FILE_NAME), report);

  const legacyHome = join(home, LEGACY_STATE_DIR_NAME);
  const checkouts = join(home, STATE_DIR_NAME, "checkouts");
  if (moveOnce(join(legacyHome, "checkouts"), checkouts, report)) {
    repairWorktreeLinks(checkouts, report);
  }
  moveOnce(join(legacyHome, "tmp"), join(home, STATE_DIR_NAME, "tmp"), report);
  // Gone once it is empty; anything else left in it is not Shipyard's to remove.
  try {
    rmdirSync(legacyHome);
  } catch {
    // Not there, or not empty.
  }
  return report;
}
