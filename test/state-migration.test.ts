import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCheckoutRootDir } from "../src/claude-agent.js";
import { migrateLegacyState } from "../src/state-migration.js";

// What Shipyard kept while it was called Yoke (until 2026-11-20), spelled out
// literally: these are the directories already on every upgraded machine.
const LEGACY = ".yoke";

async function withDirs(fn: (dirs: { home: string; cwd: string }) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shipyard-state-migration-test-"));
  try {
    const home = join(root, "home");
    const cwd = join(root, "checkout");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    await fn({ home, cwd });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("migrateLegacyState moves the session stores and the log out of the working directory's .yoke/", async () => {
  await withDirs(({ home, cwd }) => {
    write(join(cwd, LEGACY, "acme-widgets-sessions.json"), '{"sessions":[]}');
    write(join(cwd, LEGACY, "yoke.log"), "a line\n");

    const report = migrateLegacyState({ home, cwd });

    assert.equal(readFileSync(join(cwd, ".shipyard", "acme-widgets-sessions.json"), "utf8"), '{"sessions":[]}');
    assert.equal(readFileSync(join(cwd, ".shipyard", "shipyard.log"), "utf8"), "a line\n");
    assert.equal(existsSync(join(cwd, LEGACY)), false);
    assert.equal(existsSync(join(cwd, ".shipyard", "yoke.log")), false);
    assert.deepEqual(report.failed, []);
    assert.equal(report.moved.length, 2);
  });
});

test("migrateLegacyState never overwrites what is already at the new path, and is a no-op the second time", async () => {
  await withDirs(({ home, cwd }) => {
    write(join(cwd, LEGACY, "acme-widgets-sessions.json"), "old");
    write(join(cwd, ".shipyard", "acme-widgets-sessions.json"), "new");
    write(join(home, LEGACY, "checkouts", "acme-widgets", "_main", "file"), "old");
    write(join(home, ".shipyard", "checkouts", "acme-widgets", "_main", "file"), "new");

    const first = migrateLegacyState({ home, cwd });
    const second = migrateLegacyState({ home, cwd });

    assert.equal(readFileSync(join(cwd, ".shipyard", "acme-widgets-sessions.json"), "utf8"), "new");
    assert.equal(readFileSync(join(home, ".shipyard", "checkouts", "acme-widgets", "_main", "file"), "utf8"), "new");
    // Left where it is, untouched.
    assert.equal(readFileSync(join(cwd, LEGACY, "acme-widgets-sessions.json"), "utf8"), "old");
    assert.deepEqual(first.moved, []);
    assert.deepEqual(second.moved, []);
  });
});

test("migrateLegacyState moves ~/.yoke's checkouts and scratch beside a fleet member's home, leaving the home's own files", async () => {
  await withDirs(({ home, cwd }) => {
    write(join(home, ".shipyard", "fleet.json"), "{}");
    write(join(home, LEGACY, "checkouts", "acme-widgets", "_main", "README"), "x");
    write(join(home, LEGACY, "tmp", "123-abc", "scratch"), "x");

    migrateLegacyState({ home, cwd });

    assert.equal(readFileSync(join(home, ".shipyard", "fleet.json"), "utf8"), "{}");
    assert.ok(existsSync(join(home, ".shipyard", "checkouts", "acme-widgets", "_main", "README")));
    assert.ok(existsSync(join(home, ".shipyard", "tmp", "123-abc", "scratch")));
    // Empty once both are out, so it is gone.
    assert.equal(existsSync(join(home, LEGACY)), false);
  });
});

test("migrateLegacyState leaves anything else in ~/.yoke where it is", async () => {
  await withDirs(({ home, cwd }) => {
    write(join(home, LEGACY, "checkouts", "acme-widgets", "_main", "README"), "x");
    write(join(home, LEGACY, "scratch-174", "notes"), "someone's");

    migrateLegacyState({ home, cwd });

    assert.equal(readFileSync(join(home, LEGACY, "scratch-174", "notes"), "utf8"), "someone's");
    assert.ok(existsSync(join(home, ".shipyard", "checkouts", "acme-widgets", "_main", "README")));
  });
});

test("migrateLegacyState repairs the moved checkouts' worktree links, so each checkout and its branch still work", async () => {
  await withDirs(({ home, cwd }) => {
    const legacyRepo = join(home, LEGACY, "checkouts", "acme-widgets");
    const canonical = join(legacyRepo, "_main");
    mkdirSync(canonical, { recursive: true });
    git(canonical, "init", "-q", "-b", "main");
    git(canonical, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    git(canonical, "worktree", "add", "-q", "-b", "shipyard/issue-42-thing", join(legacyRepo, "issue-42"));
    git(join(legacyRepo, "issue-42"), "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "unpushed work");

    const report = migrateLegacyState({ home, cwd });

    const movedRepo = join(home, ".shipyard", "checkouts", "acme-widgets");
    assert.deepEqual(report.failed, []);
    assert.deepEqual(report.repaired, [join(movedRepo, "_main")]);
    const worktree = join(movedRepo, "issue-42");
    assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), "shipyard/issue-42-thing");
    assert.equal(git(worktree, "log", "-1", "--format=%s"), "unpushed work");
    // The canonical clone knows the worktree at its new path.
    const listed = git(join(movedRepo, "_main"), "worktree", "list", "--porcelain");
    assert.match(listed.replaceAll("\\", "/"), new RegExp(`worktree .*${".shipyard/checkouts/acme-widgets/issue-42"}`));
  });
});

test("defaultCheckoutRootDir reads the checkouts where they were kept until they have been moved", async () => {
  await withDirs(({ home }) => {
    assert.equal(defaultCheckoutRootDir(home), join(home, ".shipyard", "checkouts"));
    mkdirSync(join(home, LEGACY, "checkouts"), { recursive: true });
    assert.equal(defaultCheckoutRootDir(home), join(home, LEGACY, "checkouts"));
    mkdirSync(join(home, ".shipyard", "checkouts"), { recursive: true });
    assert.equal(defaultCheckoutRootDir(home), join(home, ".shipyard", "checkouts"));
  });
});
