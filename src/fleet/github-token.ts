import type { GitHubToken } from "./platform-client.js";

/**
 * A fleet member's GitHub token: asked of Shipyard, never kept on disk.
 *
 * The member holds no GitHub credential. Shipyard mints it a token for the
 * GitHub App's installation that reaches only the repositories assigned to
 * it and lasts an hour. An agent run can last three, and pushes at the end,
 * so the token is renewed well before it expires and everything that signs a
 * request with it reads the one that is good at that moment (`current`,
 * which the GitHub gateway and git's authentication are both handed).
 */

/** A token with less than this left is renewed. */
export const RENEW_WITH_LESS_THAN_MS = 20 * 60_000;
/** How often the keeper looks at whether the token needs renewing. */
export const CHECK_EVERY_MS = 60_000;

export interface TokenKeeperOptions {
  /** Ask Shipyard for a token for the repositories assigned to this member. */
  mint: () => Promise<GitHubToken>;
  now?: () => number;
  /** Told when a token could not be had, and when one could again (null). */
  onProblem?: (problem: string | null) => void;
}

export class GitHubTokenKeeper {
  private token: GitHubToken | null = null;
  private renewing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly mint: () => Promise<GitHubToken>;
  private readonly now: () => number;
  private readonly onProblem: (problem: string | null) => void;

  constructor(options: TokenKeeperOptions) {
    this.mint = options.mint;
    this.now = options.now ?? Date.now;
    this.onProblem = options.onProblem ?? (() => undefined);
  }

  /**
   * The token that is good right now. Empty when there is none: a request
   * signed with nothing is refused by GitHub, which is the right answer for a
   * member with no token, and says so in the action's own error.
   */
  readonly current = (): string => this.token?.token ?? "";

  /** Whether the token in hand reaches every one of `repos` and has time left on it. */
  covers(repos: readonly string[]): boolean {
    const token = this.token;
    if (!token || token.expiresAtMs - this.now() < RENEW_WITH_LESS_THAN_MS) return false;
    const reached = new Set(token.repos.map((repo) => repo.toLowerCase()));
    return repos.every((repo) => reached.has(repo.toLowerCase()));
  }

  /**
   * Make sure the token in hand reaches `repos` and has time left, asking for
   * a new one if not. With no repositories there is nothing to mint a token
   * for, and none is asked for. Never throws: a token that could not be had
   * is said through `onProblem`, and tried again at the next check.
   */
  async ensure(repos: readonly string[]): Promise<boolean> {
    if (repos.length === 0) {
      this.token = null;
      this.onProblem(null);
      return true;
    }
    if (this.covers(repos)) return true;
    this.renewing ??= this.renew().finally(() => { this.renewing = null; });
    await this.renewing;
    return this.covers(repos);
  }

  private async renew(): Promise<void> {
    try {
      this.token = await this.mint();
      this.onProblem(null);
    } catch (error) {
      // The token in hand is kept for as long as it lasts: a failed renewal does not end it early.
      this.onProblem(error instanceof Error ? error.message : String(error));
    }
  }

  /** Keep the token for `repos()` renewed for as long as the member runs. */
  start(repos: () => readonly string[]): void {
    this.stop();
    this.timer = setInterval(() => { void this.ensure(repos()); }, CHECK_EVERY_MS);
    // Never the reason the process stays alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
