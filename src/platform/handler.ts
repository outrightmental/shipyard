import { commitOf } from "../shared/release.js";

/**
 * The platform function (#1): one Lambda for every event Shipyard receives.
 *
 *   - the HTTP API (payload format 2.0): the console's calls under /api/, the
 *     fleet's under /enroll and /fleet/, GitHub's under /hooks/, and /healthz;
 *   - the WebSocket API: $connect, $disconnect and whatever a socket sends;
 *   - the schedule's tick (`{ source: "shipyard.tick" }`);
 *   - the deploy's announcement (`{ source: "shipyard.release" }`).
 *
 * This is the frame the rest of the platform is built into (#2): it answers
 * /healthz with the commit it runs, and refuses everything else.
 */

interface HttpEvent {
  rawPath?: string;
  requestContext?: { http?: { method?: string; path?: string }; connectionId?: string; routeKey?: string };
}

interface HttpResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

function json(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

export async function handler(event: HttpEvent & { source?: string }): Promise<unknown> {
  const release = commitOf(process.env.SHIPYARD_RELEASE_SHA ?? null);

  if (event.source === "shipyard.release" || event.source === "shipyard.tick") {
    return { ok: true, release };
  }

  // A socket: nothing is accepted yet.
  if (event.requestContext?.connectionId !== undefined) {
    return { statusCode: event.requestContext.routeKey === "$connect" ? 403 : 200 };
  }

  const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
  if (path === "/healthz") {
    return json(200, { ok: true, service: "shipyard", release });
  }
  return json(404, { ok: false, code: "NOT_FOUND", error: `nothing answers ${path}` });
}
