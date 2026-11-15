import type { SystemReading } from '../../shared/system.js';
import { formatBytes, formatDuration } from './format.js';

/**
 * A fleet member's machine as its heading on the dashboard says it
 * (src/shared/system.ts): a short gauge for each thing measured, most telling
 * first, so that a heading with little room keeps the ones that matter and
 * drops from the end.
 *
 * A gauge is trim while what it measures is in hand, yellow when it is worth
 * a look and red when it is what work on that machine is waiting on. The
 * marks are deliberately late: a busy machine is a fleet member doing its
 * job, and is not a warning.
 */

export type SystemTone = 'ok' | 'warn' | 'critical';

export interface SystemGauge {
  key: 'cpu' | 'memory' | 'disk' | 'load' | 'network' | 'lag' | 'uptime';
  /** What it is, in the heading's capitals: "CPU". */
  label: string;
  /** What it reads: "37%", "212 GB", "48 MS". */
  value: string;
  /** How full its bar is, 0–100; null for a reading that is not a share of anything. */
  fillPercent: number | null;
  tone: SystemTone;
  /** The whole of it in a sentence, for the inspector and for anyone not reading the gauge. */
  detail: string;
}

export interface SystemView {
  /** In the order a heading keeps them when it runs out of room. */
  gauges: SystemGauge[];
}

/** Where a gauge turns yellow, and red. */
const MARKS = {
  cpu: { warn: 90, critical: 98 },
  memory: { warn: 85, critical: 95 },
  /** The share of the disk still free, falling. */
  diskFree: { warn: 10, critical: 4 },
  /** Processes ready to run for each core there is to run them. */
  loadPerCore: { warn: 1.5, critical: 3 },
  /** Millis for Shipyard to answer: a cold start is a second, so not before that. */
  network: { warn: 2_000, critical: 8_000 },
  lag: { warn: 250, critical: 2_000 },
} as const;

const rising = (value: number, marks: { warn: number; critical: number }): SystemTone =>
  (value >= marks.critical ? 'critical' : value >= marks.warn ? 'warn' : 'ok');
const falling = (value: number, marks: { warn: number; critical: number }): SystemTone =>
  (value <= marks.critical ? 'critical' : value <= marks.warn ? 'warn' : 'ok');

const whole = (value: number): string => `${Math.round(value)}%`;
const share = (part: number, of: number): number => (of > 0 ? (part / of) * 100 : 0);

/** "3d 4h", "5h 12m", "42m": how long something has been up, to the two units that matter. */
export function formatUptime(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** Millis as a person says them: "48 ms", "1.2 s". */
function formatMillis(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function systemView(reading: SystemReading): SystemView {
  const gauges: SystemGauge[] = [];
  const { cpu, memory, disk } = reading;
  const cores = `${cpu.cores} core${cpu.cores === 1 ? '' : 's'}`;

  // The processor: a first reading has nothing before it to compare with, and says so.
  gauges.push(cpu.percent === null
    ? { key: 'cpu', label: 'CPU', value: '—', fillPercent: null, tone: 'ok', detail: `Processor: ${cores}, not measured yet` }
    : {
      key: 'cpu', label: 'CPU', value: whole(cpu.percent), fillPercent: cpu.percent, tone: rising(cpu.percent, MARKS.cpu),
      detail: `Processor: ${whole(cpu.percent)} of ${cores} busy` +
        (cpu.busiestPercent !== null ? `, the busiest at ${whole(cpu.busiestPercent)}` : ''),
    });

  const used = share(memory.usedBytes, memory.totalBytes);
  gauges.push({
    key: 'memory', label: 'MEM', value: whole(used), fillPercent: used, tone: rising(used, MARKS.memory),
    detail: `Memory: ${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)} in use (${whole(used)})`,
  });

  if (disk) {
    const free = share(disk.freeBytes, disk.totalBytes);
    gauges.push({
      key: 'disk', label: 'DISK', value: formatBytes(disk.freeBytes), fillPercent: 100 - free, tone: falling(free, MARKS.diskFree),
      detail: `Disk: ${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)} where its checkouts are kept (${whole(100 - free)} used)`,
    });
  }

  if (cpu.load) {
    const [one, five, fifteen] = cpu.load;
    const perCore = cpu.cores > 0 ? one / cpu.cores : one;
    gauges.push({
      key: 'load', label: 'LOAD', value: one.toFixed(one >= 10 ? 0 : 1), fillPercent: null, tone: rising(perCore, MARKS.loadPerCore),
      detail: `Load: ${one.toFixed(1)} ready to run over the last minute, ${five.toFixed(1)} over five, ${fifteen.toFixed(1)} over fifteen, on ${cores}`,
    });
  }

  if (reading.platformMs !== null) {
    gauges.push({
      key: 'network', label: 'NET', value: formatMillis(reading.platformMs).toUpperCase(), fillPercent: null,
      tone: rising(reading.platformMs, MARKS.network),
      detail: `Network: Shipyard answered its last report in ${formatMillis(reading.platformMs)}`,
    });
  }

  const lag = reading.process.loopLagMs;
  gauges.push({
    key: 'lag', label: 'LAG', value: formatMillis(lag).toUpperCase(), fillPercent: null, tone: rising(lag, MARKS.lag),
    detail: `Its own process: running ${formatMillis(lag)} late at worst, holding ${formatBytes(reading.process.rssBytes)}, ` +
      `up ${formatDuration(reading.process.uptimeSeconds * 1000)}`,
  });

  gauges.push({
    key: 'uptime', label: 'UP', value: formatUptime(reading.uptimeSeconds).toUpperCase(), fillPercent: null, tone: 'ok',
    detail: `The machine has been up ${formatUptime(reading.uptimeSeconds)}`,
  });

  return { gauges };
}

/** The worst any gauge reads: what colours a summary of the whole machine. */
export function worstTone(view: SystemView): SystemTone {
  if (view.gauges.some((gauge) => gauge.tone === 'critical')) return 'critical';
  return view.gauges.some((gauge) => gauge.tone === 'warn') ? 'warn' : 'ok';
}
