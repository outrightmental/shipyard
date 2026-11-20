import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import type { EnvConfig, ProjectEnvConfig } from "../env-config.js";
import type { EventEmitter } from "../event-emitter.js";
import type { MemberAck, MemberConfig, MemberPush } from "../shared/protocol.js";
import { shortCommit } from "../shared/release.js";
import { GitHubTokenKeeper } from "./github-token.js";
import { checkoutCommit, defaultHome, hostInfo, readEnrollment, readToken, REPO_ROOT, type Enrollment } from "./machine.js";
import { PlatformClient, PlatformRefusal } from "./platform-client.js";
import { SystemMonitor, type SystemMonitorOptions } from "./system-monitor.js";
import { fastForwardTo, needsUpdate, updateBlockedLine, type UpdateResult } from "./update.js";
import { Uplink } from "./uplink.js";

/**
 * A fleet member (#4): Yoke's engine pool, with its configuration, its GitHub
 * access and its orders coming from Shipyard rather than from a local
 * `env.yaml`.
 *
 * This is everything about being a member that is not the engines
 * themselves. The engine pool (src/index.ts) asks it what to be when it
 * starts, hands it the pool's emitter to report from, and is told through
 * `FleetHooks` when the repositories it works change, and when it must
 * restart or stop.
 */

/** A note a member raises about itself, by the code an operator's console groups it under. */
export const NOTE_UPDATE = "UPDATE_BLOCKED";
export const NOTE_GITHUB = "GITHUB_TOKEN";
export const NOTE_CLAUDE = "CLAUDE_AUTH";

/** How long a member that cannot update itself waits before it looks again. */
const UPDATE_RETRY_MS = 10 * 60_000;

/** What of env.yaml a machine may still say for itself: how its own engines run, never what they work on. */
const MACHINE_KEYS = [
  "claude_code_initial_model", "claude_code_review_model", "claude_code_initial_effort", "claude_code_review_effort",
  "claude_describe_model", "claude_timeout_seconds", "cycle_minimum_seconds", "checkout_retention_hours",
  "min_free_disk_gb", "dashboard_port", "anthropic_usage_token", "github_api_base_url", "github_api_version",
] as const;

/**
 * The machine's own settings, from `<home>/env.yaml` when there is one: the
 * models its engines use, how long a run may take, how much disk to keep
 * free. Everything about what the member works on comes from Shipyard, and a
 * key that says otherwise here is left out.
 */
export function machineSettings(home: string): Partial<EnvConfig> {
  const file = join(home, "env.yaml");
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = loadYaml(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null) return {};
  const settings: Record<string, unknown> = {};
  for (const key of MACHINE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) settings[key] = value;
  }
  return settings as Partial<EnvConfig>;
}

/** A repository as Shipyard assigned it, as the project Yoke's configuration describes. */
export function projectOf(repo: MemberConfig["repos"][number]): ProjectEnvConfig {
  return {
    github_repository: repo.repo,
    ...(repo.maxConcurrency !== undefined ? { max_concurrency: repo.maxConcurrency } : {}),
    ...(repo.githubProjectNumber !== undefined ? { github_project_number: repo.githubProjectNumber } : {}),
    ...(repo.reviewers !== undefined ? { reviewers: repo.reviewers } : {}),
    ...(repo.focusMode !== undefined ? { focus_mode: repo.focusMode } : {}),
    ...(repo.initialModel !== undefined ? { claude_code_initial_model: repo.initialModel } : {}),
    ...(repo.reviewModel !== undefined ? { claude_code_review_model: repo.reviewModel } : {}),
    ...(repo.initialEffort !== undefined ? { claude_code_initial_effort: repo.initialEffort } : {}),
    ...(repo.reviewEffort !== undefined ? { claude_code_review_effort: repo.reviewEffort } : {}),
    ...(repo.describeModel !== undefined ? { claude_describe_model: repo.describeModel } : {}),
  };
}

/**
 * What a member's configuration is as the configuration Yoke's engine pool
 * reads: Shipyard's word on the pool's size and the repositories, the
 * machine's own on how its engines run.
 *
 * Priority (highest wins): per-repo RepoSettings → machine env.yaml → platform engineDefaults → hard defaults.
 */
export function envConfigOf(config: MemberConfig, machine: Partial<EnvConfig>): EnvConfig {
  const engineDefaults = config.engineDefaults ?? {};
  return {
    ...(engineDefaults.initialModel ? { claude_code_initial_model: engineDefaults.initialModel } : {}),
    ...(engineDefaults.reviewModel ? { claude_code_review_model: engineDefaults.reviewModel } : {}),
    ...(engineDefaults.initialEffort ? { claude_code_initial_effort: engineDefaults.initialEffort } : {}),
    ...(engineDefaults.reviewEffort ? { claude_code_review_effort: engineDefaults.reviewEffort } : {}),
    ...(engineDefaults.describeModel ? { claude_describe_model: engineDefaults.describeModel } : {}),
    ...machine,
    max_concurrency: config.maxConcurrency,
    dashboard_title: config.member.name,
    // No token is configured anywhere: Shipyard mints the member's (github-token.ts).
    github_tokens: [],
    projects: config.repos.map(projectOf),
  };
}

/** The settings of a project that, changed, make it a different project to the engine pool. */
function projectKey(repo: MemberConfig["repos"][number]): string {
  return JSON.stringify([
    repo.repo,
    repo.maxConcurrency ?? null,
    repo.githubProjectNumber ?? null,
    repo.reviewers ?? [],
    repo.focusMode ?? false,
    repo.initialModel ?? null,
    repo.reviewModel ?? null,
    repo.initialEffort ?? null,
    repo.reviewEffort ?? null,
    repo.describeModel ?? null,
  ]);
}

/** Which repositories were added, taken away, or given other settings between two configurations. */
export function diffRepos(
  before: MemberConfig["repos"],
  after: MemberConfig["repos"],
): { added: MemberConfig["repos"]; removed: string[] } {
  const was = new Map(before.map((repo) => [repo.repo, projectKey(repo)]));
  const now = new Map(after.map((repo) => [repo.repo, projectKey(repo)]));
  return {
    // One whose settings changed is taken away and added again as it now is.
    added: after.filter((repo) => was.get(repo.repo) !== projectKey(repo)),
    removed: before.filter((repo) => now.get(repo.repo) !== projectKey(repo)).map((repo) => repo.repo),
  };
}

/** What the engine pool does when the member is told something that concerns it. */
export interface FleetHooks {
  /**
   * The repositories assigned changed: stop working the ones taken away
   * (what is running on them is left to finish) and start working the ones
   * added, with no restart.
   */
  reposChanged(change: { added: MemberConfig["repos"]; removed: string[] }): Promise<void>;
  /** Stop taking new work, let what is running finish, and exit to be started again. */
  restart(reason: string): void;
  /** Stop for good: an operator retired this machine. */
  stop(reason: string): void;
}

export interface FleetMemberOptions {
  emitter: EventEmitter;
  log: (line: string) => void;
  home?: string;
  root?: string;
  /** Where the engines keep their checkouts: the disk the member reports on. Its home's, when not said. */
  diskPath?: string;
  /** How the machine is measured (system-monitor.ts); `false` for a member that does not measure it. For tests. */
  system?: Pick<SystemMonitorOptions, "intervalMs" | "probe" | "clock" | "lag"> | false;
  /** For tests. */
  fetchImpl?: typeof fetch;
  openSocket?: UplinkSocket;
  update?: typeof fastForwardTo;
  commit?: string | null;
}

type UplinkSocket = NonNullable<ConstructorParameters<typeof Uplink>[0]["openSocket"]>;

/** Why a machine cannot be a member: said to whoever started it, and it does not start. */
export class NotEnrolled extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotEnrolled";
  }
}

export class FleetMember {
  readonly enrollment: Enrollment;
  readonly tokens: GitHubTokenKeeper;
  readonly uplink: Uplink;
  /** The machine, measured and reported with everything else; null for a member told not to. */
  readonly system: SystemMonitor | null;
  private readonly client: PlatformClient;
  private readonly machine: Partial<EnvConfig>;
  private readonly root: string;
  private readonly commit: string | null;
  private readonly update: typeof fastForwardTo;
  private readonly log: (line: string) => void;
  private readonly emitter: EventEmitter;
  /** The id of this process: a new one tells the platform the member started again. */
  private readonly boot = randomUUID();
  private current: MemberConfig | null = null;
  private hooks: FleetHooks | null = null;
  private applying: Promise<void> = Promise.resolve();
  /** The commit a restart is under way to move to; null when none is. */
  private updatingTo: string | null = null;
  private lastUpdateCheckMs = 0;
  private stopping = false;

  constructor(private readonly options: FleetMemberOptions) {
    const home = options.home ?? defaultHome();
    const enrollment = readEnrollment(home);
    const token = readToken(home);
    if (!enrollment || !token) {
      throw new NotEnrolled(
        `this machine is not a fleet member yet (${join(home, "fleet.json")}): ` +
          `make a code in Shipyard (Fleet, Enroll a machine) and run  npm run enroll -- --code <code>`,
      );
    }
    this.enrollment = enrollment;
    this.machine = machineSettings(home);
    this.root = options.root ?? REPO_ROOT;
    this.commit = options.commit !== undefined ? options.commit : checkoutCommit(this.root);
    this.update = options.update ?? fastForwardTo;
    this.log = options.log;
    this.emitter = options.emitter;
    this.client = new PlatformClient({
      platformUrl: enrollment.platformUrl,
      token,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.tokens = new GitHubTokenKeeper({
      mint: () => this.client.githubToken(),
      onProblem: (problem) => this.uplink.setNote(NOTE_GITHUB, problem === null ? null : `no GitHub token: ${problem}`),
    });
    this.uplink = new Uplink({
      client: this.client,
      emitter: options.emitter,
      wsUrl: enrollment.wsUrl,
      token,
      boot: this.boot,
      commit: this.commit,
      onAck: (ack) => this.onAck(ack),
      onPush: (push) => this.onPush(push),
      onUnenrolled: (refusal) => this.unenrolled(refusal),
      log: options.log,
      ...(options.openSocket ? { openSocket: options.openSocket } : {}),
    });
    this.system = options.system === false ? null : new SystemMonitor({
      emitter: options.emitter,
      diskPath: options.diskPath ?? home,
      platformMs: () => this.client.lastRoundTripMs,
      ...options.system,
    });
  }

  /** The member's configuration, as it last heard it. */
  get config(): MemberConfig {
    if (!this.current) throw new Error("the member has not joined yet");
    return this.current;
  }

  /** The repositories assigned, "owner/repo". */
  get repos(): string[] {
    return this.current?.repos.map((repo) => repo.repo) ?? [];
  }

  /** What the engine pool reads as its configuration. */
  envConfig(): EnvConfig {
    return envConfigOf(this.config, this.machine);
  }

  /**
   * Say who this is and be told what to be, waiting for as long as it takes
   * for the platform to be reachable: a member started before the network is
   * up has nothing to do until it is.
   *
   * Returns `restart` when the checkout was just moved to the platform's
   * commit: nothing has started yet, so the process simply exits to be
   * started again on it.
   */
  async join(): Promise<{ restart: boolean }> {
    const report = { boot: this.boot, commit: this.commit, host: hostInfo() };
    let waitMs = 2_000;
    for (;;) {
      try {
        this.current = await this.client.hello(report);
        break;
      } catch (error) {
        if (error instanceof PlatformRefusal && error.unenrolled) {
          throw new NotEnrolled(`Shipyard no longer takes this machine's token (${error.message}): enroll it again with a new code`);
        }
        this.log(`${error instanceof Error ? error.message : String(error)}. Trying again in ${Math.round(waitMs / 1000)}s.`);
        await new Promise<void>((resolve) => { setTimeout(resolve, waitMs); });
        waitMs = Math.min(60_000, waitMs * 2);
      }
    }
    this.applyIdentity(this.current);

    // Nothing is running yet: an update needs no one to finish first.
    if (needsUpdate(this.current.release, this.commit)) {
      const result = await this.update({ target: this.current.release, root: this.root });
      this.lastUpdateCheckMs = Date.now();
      if (result.ok && result.moved) {
        this.log(`updated this checkout to ${shortCommit(result.to)}, the commit Shipyard runs: restarting on it.`);
        return { restart: true };
      }
      this.reportUpdate(result, this.current.release);
    }

    await this.tokens.ensure(this.repos);
    return { restart: false };
  }

  /** Start reporting, and start listening: once the engine pool is ready to be told things. */
  start(hooks: FleetHooks): void {
    this.hooks = hooks;
    this.tokens.start(() => this.repos);
    this.uplink.start();
    this.system?.start();
  }

  /** Something wrong with this member that an operator should see, or that it no longer is. */
  setNote(code: string, message: string | null): void {
    this.uplink.setNote(code, message);
  }

  /** Say it is still there: for the while before its engines are started, when nothing else does. */
  beat(): Promise<void> {
    return this.uplink.beat();
  }

  /**
   * The last thing before the process exits to be started again: move the
   * checkout, if that is what the restart is for, and send what is waiting.
   */
  async finish(): Promise<void> {
    if (this.updatingTo !== null) {
      const result = await this.update({ target: this.updatingTo, root: this.root });
      if (result.ok && result.moved) this.log(`updated this checkout to ${shortCommit(result.to)}: restarting on it.`);
      else if (!result.ok) this.log(updateBlockedLine(result, this.updatingTo));
    }
    this.system?.stop();
    this.tokens.stop();
    await this.uplink.stop();
  }

  // ── What the platform says ─────────────────────────────────────────────────

  /** Who the member's commits are by: the GitHub App, by the environment git reads before any configuration. */
  private applyIdentity(config: MemberConfig): void {
    if (!config.git) return;
    process.env["GIT_AUTHOR_NAME"] = process.env["GIT_COMMITTER_NAME"] = config.git.name;
    process.env["GIT_AUTHOR_EMAIL"] = process.env["GIT_COMMITTER_EMAIL"] = config.git.email;
  }

  private onAck(ack: MemberAck): void {
    if (this.stopping) return;
    if (this.current && ack.configVersion !== this.current.configVersion) this.refreshConfig();
    this.considerUpdate(ack.release);
  }

  private onPush(push: MemberPush): void {
    if (this.stopping) return;
    switch (push.t) {
      case "poke":
        this.refreshConfig();
        return;
      case "release":
        this.considerUpdate(push.release, true);
        return;
      case "retired":
        this.stopFor("an operator retired this machine from the fleet");
        return;
      case "command":
        // An operator's decision, made in Shipyard: handed to the engine pool
        // exactly as a press on its own dashboard would be.
        if (push.command === "pull-request-approve") {
          this.emitter.emit("pull-request-approve", { repo: push.repo, pullRequestNumber: push.pullRequestNumber });
        } else if (push.command === "cylinder-cancel") {
          this.emitter.emit("cylinder-cancel", { engineIndex: push.engineIndex });
        }
        return;
      case "pong":
        return;
    }
  }

  private unenrolled(refusal: PlatformRefusal): void {
    this.stopFor(`Shipyard no longer takes this machine's token (${refusal.message})`);
  }

  private stopFor(reason: string): void {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`${reason}: finishing what is in flight, then stopping. Enroll it again to bring it back.`);
    this.hooks?.stop(reason);
  }

  /** Ask for the configuration again and act on what changed. One at a time, in the order asked. */
  private refreshConfig(): void {
    this.applying = this.applying.then(() => this.applyConfig()).catch((error) => {
      this.log(`its configuration could not be read: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async applyConfig(): Promise<void> {
    if (this.stopping || !this.current || !this.hooks) return;
    const next = await this.client.config();
    const before = this.current;
    if (next.configVersion === before.configVersion) return;
    this.applyIdentity(next);

    if (next.maxConcurrency !== before.maxConcurrency) {
      // The pool is as many engines as it started with: another size is another process.
      this.current = next;
      this.log(`its engine pool is now ${next.maxConcurrency} (was ${before.maxConcurrency}): restarting to take the new size.`);
      this.hooks.restart("its engine pool was resized");
      return;
    }

    const change = diffRepos(before.repos, next.repos);
    this.current = next;
    if (change.added.length === 0 && change.removed.length === 0) return;
    // A token for what it now works, before any of it is worked.
    await this.tokens.ensure(next.repos.map((repo) => repo.repo));
    await this.hooks.reposChanged(change);
  }

  /**
   * The platform runs `release`. On another commit, see whether the checkout
   * can be brought to it — while still working — and only if it can, stop
   * taking work so that it is. `now` asks again at once: the platform has
   * just said so itself.
   */
  private considerUpdate(release: string | null, now = false): void {
    if (this.stopping || this.updatingTo !== null || !needsUpdate(release, this.commit)) return;
    if (!now && Date.now() - this.lastUpdateCheckMs < UPDATE_RETRY_MS) return;
    this.lastUpdateCheckMs = Date.now();
    void this.update({ target: release, root: this.root, dryRun: true }).then((result) => {
      if (this.stopping || this.updatingTo !== null) return;
      if (result.ok && result.moved) {
        this.updatingTo = release;
        this.setNote(NOTE_UPDATE, null);
        this.log(`Shipyard runs ${shortCommit(release)} and this member ${shortCommit(this.commit) ?? "an unknown commit"}: finishing what is in flight, then updating.`);
        this.hooks?.restart(`updating to ${shortCommit(release)}`);
        return;
      }
      this.reportUpdate(result, release);
    }).catch((error) => {
      this.log(`could not check for an update: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Say why the checkout was not moved, when that is something an operator should put right. */
  private reportUpdate(result: UpdateResult, release: string | null): void {
    if (result.ok) {
      // Already there, or past it and waiting for the platform's own deploy: nothing wrong.
      this.setNote(NOTE_UPDATE, null);
      return;
    }
    const line = updateBlockedLine(result, release);
    this.log(`${line}. It carries on with the commit it has.`);
    this.setNote(NOTE_UPDATE, line);
  }
}
