import type { WorkspaceTarget } from '@portal/contracts';

export type Option = { value: string; label: string };

/** The dialog's starting CPU and memory: the target's defaults (PORTAL_K8S_TARGETS) when it has them, else 2 CPUs and 4 GB. */
export function presetFor(target: Pick<WorkspaceTarget, 'defaults'> | undefined): { cpus: string; memory: string } {
  return { cpus: String(target?.defaults?.cpus ?? 2), memory: String(target?.defaults?.memoryMb ?? 4096) };
}

/** The options with `value` in them (in order), so a target default that is not one of the fixed choices (12 GB) still shows as picked. */
export function withValue(options: readonly Option[], value: string, label: (v: number) => string): Option[] {
  if (!value || options.some((o) => o.value === value)) return [...options];
  const n = Number(value);
  const at = options.findIndex((o) => o.value !== '' && Number(o.value) > n);
  const extra = { value, label: label(n) };
  return at < 0 ? [...options, extra] : [...options.slice(0, at), extra, ...options.slice(at)];
}

export const cpuLabel = (n: number) => (n === 1 ? '1 CPU' : `${n} CPUs`);
export const memoryLabel = (mb: number) => `${Math.round((mb / 1024) * 10) / 10} GB`;
