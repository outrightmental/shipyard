import WebSocket from "ws";
import type { DashboardEvent, EventEmitter } from "../event-emitter.js";
import { HEARTBEAT_MS, type MemberAck, type MemberNote, type MemberPush } from "../shared/protocol.js";
import { replayOp, type WireEvent } from "../shared/replay-cache.js";
import { PlatformRefusal, type MemberReport, type PlatformClient } from "./platform-client.js";

/**
 * A fleet member's line to Shipyard.
 *
 * Up, over HTTPS: every event the engine pool emits — the same events the
 * member's own dashboard is drawn from — in the order they happened, a batch
 * at a time, each batch sent only once the one before it has been taken. And
 * a heartbeat when there has been nothing to say for a while.
 *
 * Down, over a socket: what cannot wait for the next heartbeat. That its
 * configuration changed, a decision an operator made, a release.
 *
 * The two are independent on purpose. A member whose socket is down still
 * reports, and still learns that its configuration or the platform's commit
 * changed, because every answer to a post says both. A member that cannot
 * reach the platform at all carries on working with what it has, keeps what
 * a dashboard would need to be brought up to date with, lets the rest go, and
 * sends it when the platform is back.
 */

/** Events are held this long for others to join them before a batch is sent. */
export const FLUSH_AFTER_MS = 400;
/** At most this many events in one post (the platform takes 500). */
export const MAX_BATCH = 200;
/** A batch is cut before its JSON passes this, so no post is ever too large to take. */
export const MAX_BATCH_BYTES = 512 * 1024;
/** With more than this waiting, the platform has been out of reach a while: what is only history is let go. */
export const MAX_QUEUE = 2_000;
/** The lines of history kept through an outage, so the log is not blank when it ends. */
export const KEEP_HISTORY = 200;
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const SOCKET_RETRY_FIRST_MS = 3_000;
const SOCKET_RETRY_MAX_MS = 60_000;
/** API Gateway closes a socket that has said nothing for ten minutes. */
const SOCKET_PING_MS = 4 * 60_000;

/**
 * What is worth keeping of a queue that has grown past what will be sent in
 * good time: every event a dashboard is brought up to date with — only the
 * last under each key, and every one that clears a key, in order — and the
 * most recent lines of history.
 */
export function compactQueue(queue: readonly WireEvent[], keepHistory = KEEP_HISTORY): WireEvent[] {
  const lastUnderKey = new Map<string, number>();
  const history: number[] = [];
  queue.forEach((event, index) => {
    const op = replayOp(event);
    if (op.set !== undefined) lastUnderKey.set(op.set, index);
    else if (op.delete === undefined) history.push(index);
  });
  const keptHistory = new Set(history.slice(-keepHistory));
  return queue.filter((event, index) => {
    const op = replayOp(event);
    if (op.set !== undefined) return lastUnderKey.get(op.set) === index;
    if (op.delete !== undefined) return true;
    return keptHistory.has(index);
  });
}

export interface UplinkOptions {
  client: PlatformClient;
  /** The engine pool's emitter: everything it emits is reported. */
  emitter: EventEmitter;
  wsUrl: string;
  token: string;
  /** The id of this process. */
  boot: string;
  commit: string | null;
  /** Every answer from the platform: its commit, and this member's configuration's version. */
  onAck: (ack: MemberAck) => void;
  /** What the platform pushes down the socket. */
  onPush: (push: MemberPush) => void;
  /** The platform no longer takes this machine's token. */
  onUnenrolled: (refusal: PlatformRefusal) => void;
  log: (line: string) => void;
  /** For tests: a socket that is not one. */
  openSocket?: (url: string, token: string) => WebSocket;
  heartbeatMs?: number;
  flushAfterMs?: number;
}

export class Uplink {
  private queue: WireEvent[] = [];
  private pumping = false;
  private stopped = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPostAtMs = 0;
  private retryMs = RETRY_FIRST_MS;
  private unsubscribe: (() => void) | null = null;
  private readonly notes = new Map<string, string>();
  private wasUnreachable = false;

  private socket: WebSocket | null = null;
  private socketRetryMs = SOCKET_RETRY_FIRST_MS;
  private socketTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: UplinkOptions) {}

  // ── What the member says about itself ──────────────────────────────────────

  /** Something wrong with this member that an operator should see, or — with null — that it no longer is. */
  setNote(code: string, message: string | null): void {
    if (message === null) {
      if (!this.notes.delete(code)) return;
    } else {
      if (this.notes.get(code) === message) return;
      this.notes.set(code, message);
    }
    // Said now rather than at the next heartbeat.
    void this.beat();
  }

  private report(): MemberReport {
    const notes: Array<Pick<MemberNote, "code" | "message">> = [...this.notes].map(([code, message]) => ({ code, message }));
    return { boot: this.options.boot, commit: this.options.commit, notes };
  }

  // ── Up ─────────────────────────────────────────────────────────────────────

  start(): void {
    this.stopped = false;
    this.unsubscribe = this.options.emitter.subscribe((event) => this.enqueue(event));
    this.beatTimer = setInterval(() => {
      if (!this.pumping && Date.now() - this.lastPostAtMs >= (this.options.heartbeatMs ?? HEARTBEAT_MS)) void this.beat();
    }, Math.min(5_000, this.options.heartbeatMs ?? HEARTBEAT_MS));
    this.beatTimer.unref?.();
    this.connectSocket();
  }

  private enqueue(event: DashboardEvent): void {
    if (this.stopped) return;
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE) this.queue = compactQueue(this.queue);
    if (this.flushTimer === null && !this.pumping) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.pump();
      }, this.options.flushAfterMs ?? FLUSH_AFTER_MS);
      this.flushTimer.unref?.();
    }
  }

  /** The next batch: as many of the events at the head of the queue as one post takes. */
  private nextBatch(): WireEvent[] {
    const batch: WireEvent[] = [];
    let bytes = 0;
    for (const event of this.queue) {
      const size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (batch.length > 0 && (batch.length >= MAX_BATCH || bytes + size > MAX_BATCH_BYTES)) break;
      batch.push(event);
      bytes += size;
    }
    return batch;
  }

  /** Send what is waiting, a batch at a time, in order. Never throws. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const batch = this.nextBatch();
        try {
          const ack = await this.options.client.events(this.report(), batch);
          this.queue.splice(0, batch.length);
          this.posted(ack);
        } catch (error) {
          if (!(await this.failed(error, batch.length))) return;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private posted(ack: MemberAck): void {
    this.lastPostAtMs = Date.now();
    this.retryMs = RETRY_FIRST_MS;
    if (this.wasUnreachable) {
      this.wasUnreachable = false;
      this.options.log("Shipyard is reachable again: reporting resumes.");
    }
    this.options.onAck(ack);
  }

  /**
   * A post did not go through. Returns whether to carry on with the queue:
   * after a wait when the platform may be back, at once when the batch itself
   * was the trouble (it is dropped), and not at all when the platform no
   * longer takes this machine's token.
   */
  private async failed(error: unknown, batchLength: number): Promise<boolean> {
    const refusal = error instanceof PlatformRefusal ? error : new PlatformRefusal(0, "ERROR", error instanceof Error ? error.message : String(error));
    if (refusal.unenrolled) {
      this.stopped = true;
      this.options.onUnenrolled(refusal);
      return false;
    }
    if (!refusal.transient) {
      // Nothing about a batch the platform refuses outright will be different next time.
      this.options.log(`Shipyard refused ${batchLength} event(s) (${refusal.code}): ${refusal.message}. Dropped.`);
      this.queue.splice(0, batchLength);
      return true;
    }
    if (!this.wasUnreachable) {
      this.wasUnreachable = true;
      this.options.log(`${refusal.message}. Work carries on; reporting resumes when it is back.`);
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, this.retryMs).unref?.(); });
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    return !this.stopped;
  }

  /** Say it is still there. Never throws. */
  async beat(): Promise<void> {
    if (this.stopped || this.pumping) return;
    try {
      this.posted(await this.options.client.beat(this.report()));
    } catch (error) {
      if (error instanceof PlatformRefusal && error.unenrolled) {
        this.stopped = true;
        this.options.onUnenrolled(error);
      }
      // Anything else: the next heartbeat tries again.
    }
  }

  /** Send everything that is waiting, for as long as `timeoutMs`: before the process exits. */
  async flush(timeoutMs = 5_000): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const deadline = Date.now() + timeoutMs;
    void this.pump();
    while ((this.pumping || this.queue.length > 0) && Date.now() < deadline && !this.stopped) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
      if (!this.pumping && this.queue.length > 0) void this.pump();
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.flush();
    this.stopped = true;
    for (const timer of [this.flushTimer, this.socketTimer]) if (timer !== null) clearTimeout(timer);
    for (const timer of [this.beatTimer, this.pingTimer]) if (timer !== null) clearInterval(timer);
    this.flushTimer = this.socketTimer = null;
    this.beatTimer = this.pingTimer = null;
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = null;
  }

  // ── Down ───────────────────────────────────────────────────────────────────

  private connectSocket(): void {
    if (this.stopped || !this.options.wsUrl) return;
    const open = this.options.openSocket ?? ((url, token) => new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 15_000 }));
    let socket: WebSocket;
    try {
      socket = open(this.options.wsUrl, this.options.token);
    } catch (error) {
      this.options.log(`Shipyard's socket could not be opened: ${error instanceof Error ? error.message : String(error)}`);
      this.retrySocket();
      return;
    }
    this.socket = socket;
    socket.on("open", () => {
      this.socketRetryMs = SOCKET_RETRY_FIRST_MS;
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "ping" }));
      }, SOCKET_PING_MS);
      this.pingTimer.unref?.();
    });
    socket.on("message", (data: WebSocket.RawData) => {
      let push: MemberPush;
      try {
        push = JSON.parse(data.toString()) as MemberPush;
      } catch {
        return;
      }
      if (typeof push !== "object" || push === null || typeof push.t !== "string") return;
      try {
        this.options.onPush(push);
      } catch (error) {
        this.options.log(`a push from Shipyard could not be acted on: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    // An error is followed by a close, which is what is acted on.
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.socket === socket) this.socket = null;
      this.retrySocket();
    });
  }

  private retrySocket(): void {
    if (this.stopped || this.socketTimer !== null) return;
    this.socketTimer = setTimeout(() => {
      this.socketTimer = null;
      this.connectSocket();
    }, this.socketRetryMs);
    this.socketTimer.unref?.();
    this.socketRetryMs = Math.min(SOCKET_RETRY_MAX_MS, this.socketRetryMs * 2);
  }
}
