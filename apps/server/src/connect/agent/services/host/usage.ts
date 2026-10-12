// Usage of the machine the `host` service runs on (docs/prd/targets-connect.md §11.6): a Host samples the CPU like `LocalRuntime`
// (host-wide: the workspace is the machine); a Container reads its own cgroup and falls back to the OS's figures when there is none.
// `cpuPercent` follows the Docker runtime's meaning: percent of ONE core, so two busy cores read 200.
import { readFileSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import type { ConnectHostUsage } from '@portal/contracts';
import { sample } from '../../../../workspaces/hostexec.js';

export interface UsageOptions {
  mode: 'host' | 'container';
  /** The cgroup mount; a test points it at a folder it filled. */
  cgroupRoot?: string;
  now?: () => number;
}

const num = (text: string | null): number | null => {
  if (text === null) return null;
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : null;
};

export function createUsageSampler(opts: UsageOptions) {
  const root = opts.cgroupRoot ?? '/sys/fs/cgroup';
  const now = opts.now ?? Date.now;
  const read = (rel: string): string | null => {
    try {
      return readFileSync(`${root}/${rel}`, 'utf8');
    } catch {
      return null;
    }
  };

  let cpu = sample();
  let cgroup: { usageUs: number; at: number } | null = null;

  /** Total CPU time the cgroup has used, in microseconds, from v2 (`cpu.stat`) or v1 (`cpuacct.usage`, ns). */
  const cgroupCpuUs = (): number | null => {
    const stat = read('cpu.stat');
    const v2 = stat ? /^usage_usec\s+(\d+)/m.exec(stat)?.[1] : undefined;
    if (v2) return Number(v2);
    const v1 = num(read('cpuacct/cpuacct.usage') ?? read('cpu/cpuacct.usage'));
    return v1 === null ? null : v1 / 1000;
  };

  /** The cores the cgroup may use: `cpu.max` (`quota period` or `max period`), else all of them. */
  const cgroupCores = (): number => {
    const max = read('cpu.max')?.trim().split(/\s+/);
    if (max && max[0] !== 'max' && Number(max[0]) > 0 && Number(max[1]) > 0) return Number(max[0]) / Number(max[1]);
    const quota = num(read('cpu/cpu.cfs_quota_us'));
    const period = num(read('cpu/cpu.cfs_period_us'));
    if (quota !== null && quota > 0 && period) return quota / period;
    return cpus().length;
  };

  const containerUsage = (): ConnectHostUsage | null => {
    const memCurrent = num(read('memory.current') ?? read('memory/memory.usage_in_bytes'));
    const usageUs = cgroupCpuUs();
    if (memCurrent === null && usageUs === null) return null;
    let cpuPercent: number | null = null;
    const at = now();
    if (usageUs !== null) {
      if (cgroup && at > cgroup.at) cpuPercent = Math.max(0, ((usageUs - cgroup.usageUs) / ((at - cgroup.at) * 1000)) * 100);
      cgroup = { usageUs, at };
    }
    const limitText = read('memory.max') ?? read('memory/memory.limit_in_bytes');
    const limit = limitText && limitText.trim() !== 'max' ? num(limitText) : null;
    // A v1 "no limit" is a huge number: a limit above the machine's memory is no limit.
    const memoryTotalBytes = limit !== null && limit > 0 && limit < totalmem() ? limit : totalmem();
    return { cpuPercent, memoryBytes: memCurrent, cores: cgroupCores(), memoryTotalBytes };
  };

  return {
    read(): ConnectHostUsage {
      if (opts.mode === 'container') {
        const fromCgroup = containerUsage();
        if (fromCgroup) return fromCgroup;
      }
      const next = sample();
      const idle = next.idle - cpu.idle;
      const total = next.total - cpu.total;
      cpu = next;
      const cores = cpus().length;
      return { cpuPercent: total > 0 ? (1 - idle / total) * cores * 100 : 0, memoryBytes: totalmem() - freemem(), cores, memoryTotalBytes: totalmem() };
    },
  };
}
