/**
 * The commit Shipyard runs, and the rule that a fleet member brings itself to
 * the same one.
 *
 * The platform's commit is what its deploy stamped (`SHIPYARD_RELEASE_SHA`,
 * the full SHA of main the deploy carried); a member's is its checkout's HEAD.
 * Two commits are the same when one is a prefix of the other, seven hex digits
 * at least, so a short SHA matches its full one. A platform that announces no
 * commit (an apply by hand: "local") moves no member.
 */

const HEX = /^[0-9a-f]{7,40}$/;

/** The commit a release names: a bare SHA is itself, `1.0.0+abc1234` is `abc1234`, anything else null. */
export function commitOf(release: unknown): string | null {
  if (typeof release !== "string") return null;
  const text = release.trim().toLowerCase();
  const sha = text.includes("+") ? text.slice(text.lastIndexOf("+") + 1) : text;
  return HEX.test(sha) ? sha : null;
}

/** Whether two releases name the same commit. Unknown is never the same as anything. */
export function sameCommit(a: unknown, b: unknown): boolean {
  const x = commitOf(a);
  const y = commitOf(b);
  if (!x || !y) return false;
  const n = Math.min(x.length, y.length);
  return x.slice(0, n) === y.slice(0, n);
}

/** A commit as people read it: its first seven digits. */
export function shortCommit(release: unknown): string | null {
  const sha = commitOf(release);
  return sha ? sha.slice(0, 7) : null;
}
