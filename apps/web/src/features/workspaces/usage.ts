import type { WorkspaceUsage } from '@portal/contracts';

/** How full CPU and memory are, out of the workspace's limits or else what the host has (0–1). */
export function usageFractions(usage: WorkspaceUsage | undefined, cpus?: number, memoryMb?: number) {
  const cores = cpus ?? usage?.cores;
  const memTotal = memoryMb ? memoryMb * 1024 * 1024 : usage?.memoryTotalBytes;
  return {
    cpu: usage?.cpuPercent == null || !cores ? undefined : usage.cpuPercent / 100 / cores,
    memory: usage?.memoryBytes == null || !memTotal ? undefined : usage.memoryBytes / memTotal,
  };
}
