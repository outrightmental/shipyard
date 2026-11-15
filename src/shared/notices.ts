import { memberOnline, type FleetMember, type GitHubStatus, type SubscribedRepo } from "./protocol.js";

/**
 * What an operator should be told about the fleet without having to go and
 * look: the things that mean work is not getting done.
 *
 * A subscribed repository does nothing until it is assigned to a fleet member,
 * and a member does nothing until it is assigned a repository, so each of
 * those standing alone is said. So is a member that has work and is not there
 * to do it, and whatever a member has said is wrong with itself.
 *
 * Worked out from the fleet and the clock alone, in the console, so "offline"
 * turns up as the minute passes rather than at the next thing the platform
 * happens to send.
 */
export type FleetNotice =
  | { kind: "github-not-connected" }
  | { kind: "github-not-installed"; installUrl: string }
  | { kind: "no-fleet" }
  | { kind: "repo-unassigned"; repo: string }
  | { kind: "member-unassigned"; memberId: string; name: string }
  | { kind: "member-offline"; memberId: string; name: string; repos: string[]; lastSeenAt: string | null }
  | { kind: "member-note"; memberId: string; name: string; code: string; message: string };

export interface FleetView {
  members: readonly FleetMember[];
  repos: readonly SubscribedRepo[];
  github: GitHubStatus;
}

/** A stable id for a notice, so a card for it keeps its place. */
export function noticeId(notice: FleetNotice): string {
  switch (notice.kind) {
    case "repo-unassigned": return `repo-unassigned:${notice.repo}`;
    case "member-unassigned": return `member-unassigned:${notice.memberId}`;
    case "member-offline": return `member-offline:${notice.memberId}`;
    case "member-note": return `member-note:${notice.memberId}:${notice.code}`;
    default: return notice.kind;
  }
}

export function fleetNotices(fleet: FleetView, nowMs: number): FleetNotice[] {
  const notices: FleetNotice[] = [];
  const active = fleet.members.filter((member) => member.status === "active");

  if (!fleet.github.connected) {
    notices.push({ kind: "github-not-connected" });
  } else if (fleet.github.installation === null && fleet.github.app !== null) {
    notices.push({ kind: "github-not-installed", installUrl: fleet.github.app.installUrl });
  }
  if (active.length === 0) notices.push({ kind: "no-fleet" });

  const known = new Set(active.map((member) => member.id));
  for (const repo of fleet.repos) {
    // Assigned to a member that has since been retired is assigned to no one.
    if (repo.memberId === null || !known.has(repo.memberId)) {
      notices.push({ kind: "repo-unassigned", repo: repo.repo });
    }
  }

  for (const member of active) {
    const repos = fleet.repos.filter((repo) => repo.memberId === member.id).map((repo) => repo.repo);
    if (repos.length === 0) {
      notices.push({ kind: "member-unassigned", memberId: member.id, name: member.name });
    } else if (!memberOnline(member, nowMs)) {
      notices.push({ kind: "member-offline", memberId: member.id, name: member.name, repos, lastSeenAt: member.lastSeenAt });
    }
    for (const note of member.notes) {
      notices.push({ kind: "member-note", memberId: member.id, name: member.name, code: note.code, message: note.message });
    }
  }
  return notices;
}
