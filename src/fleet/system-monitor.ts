import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { dirname } from "node:path";
import type { EventEmitter } from "../event-emitter.js";
import { SYSTEM_REPORT_MS, type SystemReading } from "../shared/system.js";

/**
 * A fleet member measuring the machine it runs on (src/shared/system.ts).
 *
 * Every reading is everything at once — processor, load, memory, disk, the
 * member's own process, how far away Shipyard is — and is emitted as one
 * `system-update` event with the rest of what the member emits, so it reaches
 * the platform and every console by the road already there, and takes the
 * place of the heartbeat an idle member would otherwise send.
 *
 * It is measured with what Node has on every system a member runs on, so that
 * a member is one program and installs nothing: no agent, no native module.
 * Where a system does not keep a number (Windows keeps no load average) the
 * reading says so with a null rather than a made-up nought. Measuring must
 * never be what stops a member: a reading that cannot be taken is skipped,
 * and the timer never keeps the process alive.
 */

/** One core's time in each state, in millis, as the system counts it since it started. */
export interface CoreTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

/** Everything read of the machine that the monitor does not work out itself. Replaceable, for tests. */
export interface SystemProbe {
  platform: NodeJS.Platform;
  cpuTimes(): CoreTimes[];
  loadavg(): number[];
  totalMemory(): number;
  /** Memory to be had by asking for it, in bytes. */
  availableMemory(): Promise<number>;
  /** How long the machine has been up, in seconds. */
  uptime(): number;
  disk(path: string): Promise<{ freeBytes: number; totalBytes: number } | null>;
  rss(): number;
  processUptime(): number;
}

/** A first reading has no processor use to say: it is taken this long after starting, when it has. */
const FIRST_READING_MS = 2_000;
/** How often the event loop is asked whether it is running late. */
const LAG_CHECK_MS = 500;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * How busy the processor was between two countings of its cores' time: all of
 * it together, and its busiest core. Null when no time passed between them, or
 * a counter ran backwards (a machine that slept).
 */
export function cpuUse(before: readonly CoreTimes[], after: readonly CoreTimes[]): { percent: number | null; busiestPercent: number | null } {
  let busy = 0;
  let total = 0;
  let busiest: number | null = null;
  for (let core = 0; core < Math.min(before.length, after.length); core++) {
    const was = before[core]!;
    const is = after[core]!;
    const idle = is.idle - was.idle;
    const work = (is.user - was.user) + (is.nice - was.nice) + (is.sys - was.sys) + (is.irq - was.irq);
    if (idle < 0 || work < 0 || idle + work <= 0) continue;
    busy += work;
    total += idle + work;
    busiest = Math.max(busiest ?? 0, (work / (idle + work)) * 100);
  }
  if (total <= 0 || busiest === null) return { percent: null, busiestPercent: null };
  return { percent: round1((busy / total) * 100), busiestPercent: round1(busiest) };
}

/**
 * The memory to be had on a Mac, in bytes, from what `vm_stat` prints. Node's
 * own count there is only the pages nothing is using at all, which on a Mac
 * that has been up an hour is next to none: memory holding what was read from
 * disk is given back the moment something asks, and counts as to be had.
 */
export function availableFromVmStat(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (name: string): number => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(output)?.[1] ?? 0);
  const count = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative");
  return count > 0 ? count * pageSize : null;
}

function darwinAvailableMemory(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("vm_stat", { timeout: 2_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : availableFromVmStat(String(stdout)));
    });
  });
}

/** The disk `path` is on. A directory not made yet is on the disk the nearest one above it is on. */
async function readDisk(path: string): Promise<{ freeBytes: number; totalBytes: number } | null> {
  let at = path;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try {
    const stats = await statfs(at);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    return totalBytes > 0 ? { freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes } : null;
  } catch {
    return null;
  }
}

/** The machine this process is running on. */
export function machineProbe(): SystemProbe {
  return {
    platform: process.platform,
    cpuTimes: () => os.cpus().map((cpu) => ({ ...cpu.times })),
    loadavg: () => os.loadavg(),
    totalMemory: () => os.totalmem(),
    availableMemory: async () => (process.platform === "darwin" ? await darwinAvailableMemory() : null) ?? os.freemem(),
    uptime: () => os.uptime(),
    disk: readDisk,
    rss: () => process.memoryUsage.rss(),
    processUptime: () => process.uptime(),
  };
}

/**
 * How late the event loop is running: a timer due every so often, and how
 * long after it was due it ran. A member whose loop is held up — by a burst
 * of its own work, or a machine with nothing left to give it — reports late
 * and answers Shipyard late, and this is the number that says so.
 */
export class LoopLag {
  private timer: ReturnType<typeof setInterval> | null = null;
  private due = 0;
  private worst = 0;

  constructor(
    private readonly everyMs: number = LAG_CHECK_MS,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.due = this.now() + this.everyMs;
    this.timer = setInterval(() => this.tick(), this.everyMs);
    this.timer.unref?.();
  }

  /** The timer ran: how late, against when it was due. */
  tick(): void {
    const now = this.now();
    this.worst = Math.max(this.worst, now - this.due);
    this.due = now + this.everyMs;
  }

  /** The latest it has run since this was last asked, in millis. */
  take(): number {
    const worst = Math.max(0, Math.round(this.worst));
    this.worst = 0;
    return worst;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

export interface SystemMonitorOptions {
  emitter: EventEmitter;
  /** Where the member's checkouts are kept: the disk that fills. */
  diskPath: string;
  /** How long Shipyard took to answer the member's last post, in millis; null before the first. */
  platformMs?: () => number | null;
  intervalMs?: number;
  /** For tests: the machine, or as much of it as the test is about. */
  probe?: Partial<SystemProbe>;
  clock?: () => number;
  lag?: LoopLag;
}

export class SystemMonitor {
  private readonly emitter: EventEmitter;
  private readonly diskPath: string;
  private readonly platformMs: () => number | null;
  private readonly intervalMs: number;
  private readonly probe: SystemProbe;
  private readonly clock: () => number;
  private readonly lag: LoopLag;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private previous: CoreTimes[] | null = null;

  constructor(options: SystemMonitorOptions) {
    this.emitter = options.emitter;
    this.diskPath = options.diskPath;
    this.platformMs = options.platformMs ?? (() => null);
    this.intervalMs = options.intervalMs ?? SYSTEM_REPORT_MS;
    this.probe = { ...machineProbe(), ...options.probe };
    this.clock = options.clock ?? Date.now;
    this.lag = options.lag ?? new LoopLag();
  }

  /** Report a reading shortly, and every interval after. */
  start(): void {
    if (this.running) return;
    this.running = true;
    try { this.previous = this.probe.cpuTimes(); } catch { this.previous = null; }
    this.lag.start();
    this.schedule(Math.min(FIRST_READING_MS, this.intervalMs));
  }

  stop(): void {
    this.running = false;
    this.lag.stop();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Measure the machine now. The processor's use is since the reading before this one. */
  async read(): Promise<SystemReading> {
    const { probe } = this;
    const times = probe.cpuTimes();
    const use = this.previous ? cpuUse(this.previous, times) : { percent: null, busiestPercent: null };
    this.previous = times;

    const loads = probe.platform === "win32" ? [] : probe.loadavg();
    const totalBytes = probe.totalMemory();
    const [available, disk] = await Promise.all([
      probe.availableMemory().catch(() => 0),
      probe.disk(this.diskPath).catch(() => null),
    ]);

    return {
      atMs: this.clock(),
      cpu: {
        ...use,
        cores: times.length,
        load: loads.length >= 3 ? [round1(loads[0]!), round1(loads[1]!), round1(loads[2]!)] : null,
      },
      memory: { usedBytes: Math.max(0, totalBytes - Math.min(totalBytes, available)), totalBytes },
      disk,
      process: { rssBytes: probe.rss(), loopLagMs: this.lag.take(), uptimeSeconds: Math.round(probe.processUptime()) },
      platformMs: this.platformMs(),
      uptimeSeconds: Math.round(probe.uptime()),
    };
  }

  /** Take one reading and report it. A reading that cannot be taken is not reported, and is no one's problem. */
  async report(): Promise<SystemReading | null> {
    try {
      const reading = await this.read();
      this.emitter.emit("system-update", { ...reading });
      return reading;
    } catch {
      return null;
    }
  }

  private schedule(afterMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.report().then(() => {
        if (this.running) this.schedule(this.intervalMs);
      });
    }, afterMs);
    // Measuring must never be what keeps the process alive.
    this.timer.unref?.();
  }
}
