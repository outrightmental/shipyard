import { CENTRAL_MEMBER_ID, type ConsolePush, type MemberPush } from "../shared/protocol.js";
import {
  authenticateMember,
  closeConnection,
  getConnection,
  listRepoRows,
  openConnection,
  pushToConnection,
  pushToConsoles,
  pushToMember,
  type ConnectionRow,
} from "./fleet.js";
import { iso, PlatformError, type Platform } from "./platform.js";

/**
 * The WebSocket API: the push channel.
 *
 * Two kinds of socket connect. A console's, which carries a Cognito id token
 * in its address (a browser cannot set a header on a WebSocket) and is pushed
 * every fleet member's events. And a fleet member's, which carries its own
 * token in the Authorization header and is pushed what must reach it at once:
 * that its configuration changed, a decision an operator made, a release.
 *
 * What a socket sends back is small: a console's Approve press or cancel,
 * which the platform passes to the member the repository is assigned to, and
 * a ping from either, to keep the connection from idling out.
 */
export interface SocketEvent {
  routeKey: string;
  connectionId: string;
  /** Lower-cased names. On $connect only. */
  headers: Record<string, string>;
  /** On $connect only. */
  query: Record<string, string>;
  body: string;
}

export async function handleSocket(p: Platform, event: SocketEvent): Promise<{ statusCode: number }> {
  switch (event.routeKey) {
    case "$connect": return connect(p, event);
    case "$disconnect": {
      const closed = await closeConnection(p, event.connectionId);
      // A member with no socket cannot be handed a decision: the consoles show it.
      if (closed?.kind === "member") await pushToConsoles(p, { t: "changed" } satisfies ConsolePush);
      return { statusCode: 200 };
    }
    default: return message(p, event);
  }
}

async function connect(p: Platform, event: SocketEvent): Promise<{ statusCode: number }> {
  try {
    const bearer = event.headers["authorization"];
    if (bearer) {
      const member = await authenticateMember(p, bearer);
      await openConnection(p, event.connectionId, { kind: "member", memberId: member.id });
      await pushToConsoles(p, { t: "changed" } satisfies ConsolePush);
      return { statusCode: 200 };
    }
    const token = event.query["token"];
    if (!token) return { statusCode: 401 };
    const operator = await p.verifyOperator(token);
    await openConnection(p, event.connectionId, { kind: "console", email: operator.email });
    return { statusCode: 200 };
  } catch (error) {
    if (error instanceof PlatformError) return { statusCode: error.status === 403 ? 403 : 401 };
    p.log(`$connect failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return { statusCode: 500 };
  }
}

async function message(p: Platform, event: SocketEvent): Promise<{ statusCode: number }> {
  const connection = await getConnection(p, event.connectionId);
  if (!connection) return { statusCode: 410 };
  let sent: Record<string, unknown>;
  try {
    sent = JSON.parse(event.body) as Record<string, unknown>;
  } catch {
    return { statusCode: 400 };
  }
  if (typeof sent !== "object" || sent === null) return { statusCode: 400 };

  if (sent["t"] === "ping") {
    await pushToConnection(p, connection, { t: "pong" });
    return { statusCode: 200 };
  }
  // Only a console sends anything else: a member's reports go up over HTTPS.
  if (connection.kind !== "console") return { statusCode: 200 };

  if (sent["t"] === "approve") await approve(p, connection, sent);
  else if (sent["t"] === "cancel") await cancel(p, connection, sent);
  return { statusCode: 200 };
}

/**
 * An Approve press. It goes to the member the repository is assigned to,
 * which answers it through its own events, as Shipyard answers a press on its own
 * dashboard. A press no member can be handed — the repository is no one's, or
 * its member has no socket open — is answered here instead, as refused, to
 * the console that sent it: its card says why rather than wait on an answer
 * that is never coming.
 */
async function approve(p: Platform, connection: ConnectionRow, sent: Record<string, unknown>): Promise<void> {
  const repo = typeof sent["repo"] === "string" ? sent["repo"] : "";
  const pullRequestNumber = sent["pullRequestNumber"];
  if (typeof pullRequestNumber !== "number" || !Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) return;

  const row = (await listRepoRows(p)).find((candidate) => candidate.repo === repo) ?? null;
  const memberId = row?.memberId ?? null;
  if (memberId !== null) {
    const command: MemberPush = { t: "command", command: "pull-request-approve", repo, pullRequestNumber, by: connection.email ?? null };
    if (await pushToMember(p, memberId, command) > 0) return;
  }
  const reason = row === null
    ? `${repo || "that repository"} is not one Shipyard is subscribed to`
    : memberId === null
      ? `${repo} is assigned to no fleet member, so there is no one to merge it`
      : `the fleet member ${repo} is assigned to is not connected right now`;
  const at = iso(p.now());
  const refusal: ConsolePush = {
    t: "events",
    member: memberId ?? CENTRAL_MEMBER_ID,
    events: [{ type: "pull-request-approval", timestamp: at, data: { repo, pullRequestNumber, requestedAt: at, state: "refused", reason } }],
  };
  await pushToConnection(p, connection, refusal);
}

/** Stop an engine's run: passed to the member whose engine it is. */
async function cancel(p: Platform, connection: ConnectionRow, sent: Record<string, unknown>): Promise<void> {
  const memberId = typeof sent["member"] === "string" ? sent["member"] : "";
  const engineIndex = sent["engineIndex"];
  if (!memberId || typeof engineIndex !== "number" || !Number.isInteger(engineIndex) || engineIndex < 0) return;
  const command: MemberPush = { t: "command", command: "cylinder-cancel", engineIndex, by: connection.email ?? null };
  await pushToMember(p, memberId, command);
}
