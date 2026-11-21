import { CENTRAL_MEMBER_ID, parseRepo, type RepoSettings, type SubscribedRepo } from "../shared/protocol.js";
import { getMember, listRepoRows, pushToConsoles, pushToMember, refreshConfigVersion, repoView, type RepoRow } from "./fleet.js";
import { iso, refuse, type Platform } from "./platform.js";
import { removeProject } from "./relay.js";

/**
 * The repositories Shipyard is subscribed to, and who works each.
 *
 * Subscribing puts a repository's issues on the dashboard. It gets no work
 * done until it is assigned to a fleet member, and it is assigned to exactly
 * one: two members never work the same repository, which is what lets the
 * main dashboard be the sum of what each member's own screen shows.
 *
 * Rows: `REPO/<owner/repo>`.
 */

const REPO = "REPO";

const MODEL_RE = /^claude-[a-z0-9._-]{1,60}$/;
const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

function cleanSettings(value: unknown): RepoSettings {
  if (typeof value !== "object" || value === null) return {};
  const input = value as Record<string, unknown>;
  const settings: RepoSettings = {};
  const max = input["maxConcurrency"];
  if (typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= 32) settings.maxConcurrency = max;
  const project = input["githubProjectNumber"];
  if (typeof project === "number" && Number.isInteger(project) && project > 0) settings.githubProjectNumber = project;
  if (Array.isArray(input["reviewers"])) {
    const reviewers = input["reviewers"].filter((login): login is string => typeof login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(login));
    if (reviewers.length > 0) settings.reviewers = reviewers.slice(0, 20);
  }
  if (input["focusMode"] === true) settings.focusMode = true;
  const checksTimeout = input["checksTimeoutMinutes"];
  if (typeof checksTimeout === "number" && Number.isInteger(checksTimeout) && checksTimeout >= 1 && checksTimeout <= 1440) {
    settings.checksTimeoutMinutes = checksTimeout;
  }
  const model = (v: unknown) => typeof v === "string" && MODEL_RE.test(v) ? v : undefined;
  const effort = (v: unknown) => EFFORT_VALUES.includes(v as (typeof EFFORT_VALUES)[number]) ? (v as string) : undefined;
  const im = model(input["initialModel"]); if (im !== undefined) settings.initialModel = im;
  const rm = model(input["reviewModel"]); if (rm !== undefined) settings.reviewModel = rm;
  const ie = effort(input["initialEffort"]); if (ie !== undefined) settings.initialEffort = ie;
  const re = effort(input["reviewEffort"]); if (re !== undefined) settings.reviewEffort = re;
  const dm = model(input["describeModel"]); if (dm !== undefined) settings.describeModel = dm;
  return settings;
}

export interface RepoChange {
  /** The member to assign it to; null to assign it to no one. Absent leaves the assignment as it is. */
  memberId?: unknown;
  /** Replaces the repository's settings. Absent leaves them as they are. */
  settings?: unknown;
}

/**
 * Subscribe to a repository, or change one already subscribed to: who works
 * it, and how. Whoever's configuration that changes is told at once, and the
 * work leaves the screen of whoever no longer has it.
 */
export async function putRepo(p: Platform, repoName: string, change: RepoChange, by: string | null): Promise<SubscribedRepo> {
  const parsed = parseRepo(repoName);
  if (!parsed) return refuse(400, "REPO_NAME", `"${repoName}" is not a repository: it is named owner/repo`);
  const existing = (await p.table.get(REPO, parsed.repo)) as RepoRow | null;

  let memberId = existing?.memberId ?? null;
  if (change.memberId !== undefined) {
    if (change.memberId === null || change.memberId === "") {
      memberId = null;
    } else {
      const member = typeof change.memberId === "string" ? await getMember(p, change.memberId) : null;
      if (!member || member.status !== "active") return refuse(404, "MEMBER_UNKNOWN", "there is no such fleet member to assign it to");
      memberId = member.id;
    }
  }
  const settings = change.settings !== undefined ? cleanSettings(change.settings) : existing?.settings ?? {};

  const row: RepoRow = {
    PK: REPO,
    SK: parsed.repo,
    repo: parsed.repo,
    memberId,
    subscribedAt: existing?.subscribedAt ?? iso(p.now()),
    subscribedBy: existing?.subscribedBy ?? by,
    settings,
  };
  await p.table.put(row);

  const before = existing?.memberId ?? null;
  await afterAssignmentChange(p, parsed.repo, before, memberId, existing === null);
  return repoView(row);
}

/** Stop subscribing to a repository: whoever works it stops, and its work leaves the dashboard. */
export async function deleteRepo(p: Platform, repoName: string): Promise<void> {
  const parsed = parseRepo(repoName);
  if (!parsed) return refuse(400, "REPO_NAME", `"${repoName}" is not a repository: it is named owner/repo`);
  const existing = (await p.table.get(REPO, parsed.repo)) as RepoRow | null;
  if (!existing) return;
  await p.table.delete(REPO, parsed.repo);
  await leaves(p, parsed.repo, existing.memberId ?? null);
  await pushToConsoles(p, { t: "changed" });
}

/** The repository's work leaves the screen of whoever was showing it, and they are told their configuration changed. */
async function leaves(p: Platform, repo: string, memberId: string | null): Promise<void> {
  await removeProject(p, memberId ?? CENTRAL_MEMBER_ID, repo);
  if (memberId !== null) {
    await refreshConfigVersion(p, memberId);
    await pushToMember(p, memberId, { t: "poke" });
  }
}

async function afterAssignmentChange(p: Platform, repo: string, before: string | null, after: string | null, isNew: boolean): Promise<void> {
  if (isNew || before !== after) {
    // Whoever showed it before: the member it was taken from, or the platform itself while it was no one's.
    // (The platform's own reading of it, when it was no one's, gives way to the member's.)
    if (!isNew) await leaves(p, repo, before);
    if (after !== null) {
      await refreshConfigVersion(p, after);
      await pushToMember(p, after, { t: "poke" });
    }
  } else if (after !== null) {
    // Same member, new settings.
    await refreshConfigVersion(p, after);
    await pushToMember(p, after, { t: "poke" });
  }
  await pushToConsoles(p, { t: "changed" });
}

export async function listRepos(p: Platform): Promise<SubscribedRepo[]> {
  return (await listRepoRows(p)).map(repoView).sort((a, b) => (a.repo.toLowerCase() < b.repo.toLowerCase() ? -1 : 1));
}
