import { gzipSync } from "node:zlib";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { MemberPush } from "../shared/protocol.js";
import { commitOf } from "../shared/release.js";
import { pushToFleet } from "./fleet.js";
import { handleHttp, type HttpRequest } from "./http.js";
import { createJwtVerifier } from "./jwt.js";
import { cachedSecrets, randomHex, type Platform, type Secrets, type Sockets } from "./platform.js";
import { DynamoTable } from "./store.js";
import { tick } from "./tick.js";
import { handleSocket } from "./ws.js";

/**
 * The platform function (#1, #2): one Lambda for every event Shipyard receives.
 *
 *   - the HTTP API (payload format 2.0): the console's calls under /api/, the
 *     fleet's under /enroll and /fleet/, GitHub's under /hooks/, and /healthz
 *     (http.ts);
 *   - the WebSocket API: $connect, $disconnect and whatever a socket sends
 *     (ws.ts);
 *   - the schedule's tick, `{ source: "shipyard.tick" }` (tick.ts);
 *   - the deploy's announcement, `{ source: "shipyard.release" }`: every
 *     connected fleet member is told the commit the platform now runs.
 *
 * This file is the only one that names AWS: it builds the `Platform` the rest
 * is written against from the function's environment.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** API Gateway's connection management, as the platform pushes down a socket. */
function awsSockets(endpoint: string): Sockets {
  const client = new ApiGatewayManagementApiClient({ endpoint });
  return {
    async post(connectionId, message) {
      try {
        await client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(message)) }));
        return true;
      } catch (error) {
        const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        // The socket closed and API Gateway has not said so yet.
        if (failure.name === "GoneException" || failure.$metadata?.httpStatusCode === 410) return false;
        throw error;
      }
    },
  };
}

/** SSM SecureStrings under the platform's prefix, as they are in SSM right now. */
function awsSecrets(prefix: string): Secrets {
  const client = new SSMClient({});
  const nameOf = (name: string) => `${prefix}${name}`;
  return {
    async get(name) {
      try {
        const result = await client.send(new GetParameterCommand({ Name: nameOf(name), WithDecryption: true }));
        return result.Parameter?.Value ?? null;
      } catch (error) {
        if ((error as { name?: string }).name !== "ParameterNotFound") throw error;
        return null;
      }
    },
    async put(name, value) {
      await client.send(new PutParameterCommand({ Name: nameOf(name), Value: value, Type: "SecureString", Overwrite: true }));
    },
    async delete(name) {
      try {
        await client.send(new DeleteParameterCommand({ Name: nameOf(name) }));
      } catch (error) {
        if ((error as { name?: string }).name !== "ParameterNotFound") throw error;
      }
    },
  };
}

let platform: Platform | null = null;

/** The platform, built once per container from the function's environment. */
function awsPlatform(): Platform {
  platform ??= {
    table: new DynamoTable(required("SHIPYARD_TABLE")),
    sockets: awsSockets(required("SHIPYARD_WS_ENDPOINT")),
    // Kept in memory once read: safe because a name's value never changes (cachedSecrets).
    secrets: cachedSecrets(awsSecrets(required("SHIPYARD_SSM_PREFIX"))),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    random: randomHex,
    settings: {
      release: commitOf(process.env["SHIPYARD_RELEASE_SHA"] ?? null),
      publicUrl: required("SHIPYARD_PUBLIC_URL"),
      publicWs: required("SHIPYARD_PUBLIC_WS"),
    },
    verifyOperator: createJwtVerifier({
      issuer: required("SHIPYARD_COGNITO_ISSUER"),
      audience: required("SHIPYARD_COGNITO_CLIENT_ID"),
    }),
    log: (line) => console.log(line),
  };
  return platform;
}

// ── The events ───────────────────────────────────────────────────────────────

interface LambdaEvent {
  source?: string;
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: { method?: string; path?: string };
    connectionId?: string;
    routeKey?: string;
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
}

function lowered(record: Record<string, string | undefined> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(record ?? {})) {
    if (typeof value === "string") out[name.toLowerCase()] = value;
  }
  return out;
}

function bodyOf(event: LambdaEvent): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

/** An answer over this size is gzipped when the caller takes gzip: a console's first read carries every member's state. */
const GZIP_OVER_BYTES = 4 * 1024;

function httpResult(status: number, body: unknown, acceptEncoding: string): Record<string, unknown> {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (Buffer.byteLength(json) > GZIP_OVER_BYTES && /\bgzip\b/.test(acceptEncoding)) {
    return {
      statusCode: status,
      headers: { ...headers, "content-encoding": "gzip", vary: "accept-encoding" },
      body: gzipSync(json).toString("base64"),
      isBase64Encoded: true,
    };
  }
  return { statusCode: status, headers, body: json };
}

export async function handler(event: LambdaEvent): Promise<unknown> {
  const p = awsPlatform();

  if (event.source === "shipyard.tick") {
    try {
      return { ok: true, ...(await tick(p)) };
    } catch (error) {
      // A tick that fails is tried again in two minutes; the schedule does not retry it.
      p.log(`tick failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return { ok: false };
    }
  }

  if (event.source === "shipyard.release") {
    const message: MemberPush = { t: "release", release: p.settings.release };
    const told = await pushToFleet(p, message).catch(() => 0);
    return { ok: true, release: p.settings.release, told };
  }

  const context = event.requestContext;
  if (context?.connectionId !== undefined) {
    return handleSocket(p, {
      routeKey: context.routeKey ?? "$default",
      connectionId: context.connectionId,
      headers: lowered(event.headers),
      query: Object.fromEntries(Object.entries(event.queryStringParameters ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      body: bodyOf(event),
    });
  }

  const headers = lowered(event.headers);
  const request: HttpRequest = {
    method: (context?.http?.method ?? "GET").toUpperCase(),
    path: event.rawPath ?? context?.http?.path ?? "/",
    headers,
    body: bodyOf(event),
    claims: context?.authorizer?.jwt?.claims ?? null,
  };
  const response = await handleHttp(p, request);
  return httpResult(response.status, response.body, headers["accept-encoding"] ?? "");
}
