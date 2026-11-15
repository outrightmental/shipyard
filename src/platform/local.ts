import { randomBytes } from "node:crypto";
import * as http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { commitOf } from "../shared/release.js";
import { handleHttp, type HttpRequest } from "./http.js";
import { PlatformError, randomHex, type Operator, type Platform } from "./platform.js";
import { MemoryTable } from "./store.js";
import { handleSocket } from "./ws.js";

/**
 * The platform on one port of this machine, with its table in memory: the
 * same routes and the same socket handling the function runs (http.ts,
 * ws.ts), behind Node's own HTTP server in place of API Gateway.
 *
 * It is what a fleet member is tried against without deploying anything, and
 * what the member's tests run against: a real member, over real HTTP and a
 * real socket, talking to the real platform code.
 *
 * In place of Cognito, an operator is whoever presents `operatorToken`: as
 * the bearer on /api/… calls, and as `?token=` on a console's socket.
 */
export interface LocalPlatformOptions {
  port?: number;
  host?: string;
  /** The commit the platform says it runs. */
  release?: string | null;
  /** What an operator presents. */
  operatorToken?: string;
  operatorEmail?: string;
  /** In place of GitHub and anything else the platform fetches. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface LocalPlatform {
  /** http://127.0.0.1:<port> */
  url: string;
  /** ws://127.0.0.1:<port> */
  wsUrl: string;
  p: Platform;
  table: MemoryTable;
  secrets: Map<string, string>;
  operatorToken: string;
  /** Change the commit the platform says it runs, as a deploy would. */
  setRelease(release: string | null): void;
  close(): Promise<void>;
}

export async function startLocalPlatform(options: LocalPlatformOptions = {}): Promise<LocalPlatform> {
  const host = options.host ?? "127.0.0.1";
  const operatorToken = options.operatorToken ?? `local-operator-${randomBytes(8).toString("hex")}`;
  const operator: Operator = { sub: "local-operator", email: options.operatorEmail ?? "operator@localhost" };
  const table = new MemoryTable();
  const secrets = new Map<string, string>();
  const sockets = new Map<string, WebSocket>();
  const log = options.log ?? (() => undefined);

  const settings = { release: commitOf(options.release ?? null), publicUrl: "", publicWs: "" };
  const p: Platform = {
    table,
    sockets: {
      async post(connectionId, message) {
        const socket = sockets.get(connectionId);
        if (!socket || socket.readyState !== 1) return false;
        socket.send(JSON.stringify(message));
        return true;
      },
    },
    secrets: {
      async get(name) { return secrets.get(name) ?? null; },
      async put(name, value) { secrets.set(name, value); },
      async delete(name) { secrets.delete(name); },
    },
    fetch: options.fetchImpl ?? ((input, init) => fetch(input, init)),
    now: () => Date.now(),
    random: randomHex,
    settings,
    async verifyOperator(token) {
      if (token !== operatorToken) throw new PlatformError(401, "JWT_SIGNATURE", "not the local operator's token");
      return operator;
    },
    log,
  };

  const lowered = (headers: http.IncomingHttpHeaders): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string") out[name.toLowerCase()] = value;
    }
    return out;
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
      const headers = lowered(req.headers);
      const request: HttpRequest = {
        method: (req.method ?? "GET").toUpperCase(),
        path: url.pathname,
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
        // What API Gateway's authorizer would have verified.
        claims: url.pathname.startsWith("/api/") && headers["authorization"] === `Bearer ${operatorToken}` ? { ...operator } : null,
      };
      void handleHttp(p, request).then((response) => {
        res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(response.body));
      });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    const connectionId = randomBytes(9).toString("base64url");
    void handleSocket(p, {
      routeKey: "$connect",
      connectionId,
      headers: lowered(req.headers),
      query: Object.fromEntries(url.searchParams),
      body: "",
    }).then(({ statusCode }) => {
      if (statusCode !== 200) {
        socket.write(`HTTP/1.1 ${statusCode} Refused\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.set(connectionId, ws);
        ws.on("message", (data) => {
          void handleSocket(p, { routeKey: "$default", connectionId, headers: {}, query: {}, body: data.toString() });
        });
        ws.on("close", () => {
          sockets.delete(connectionId);
          void handleSocket(p, { routeKey: "$disconnect", connectionId, headers: {}, query: {}, body: "" });
        });
        ws.on("error", () => undefined);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? 0;
  settings.publicUrl = `http://${host}:${port}`;
  settings.publicWs = `ws://${host}:${port}`;

  return {
    url: settings.publicUrl,
    wsUrl: settings.publicWs,
    p,
    table,
    secrets,
    operatorToken,
    setRelease(release) { settings.release = commitOf(release); },
    async close() {
      for (const socket of sockets.values()) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
