// A workspace's memory as its cgroup (v2) sees it (T-416, D-61): the limit (`memory.max`) and what the kernel cannot give back before an
// OOM, `anon + active_file` from `memory.stat`. Never `memory.current`: it counts the page cache too (git and node_modules), which the kernel
// reclaims first (2026-10-15 02:52 UTC: memory.current 6.8 GiB of 8, anon 1.75 GiB, inactive_file 4.3 GiB).
//
// Read through the runtime's exec, as the workspace user, by one short `sh` script (no node, nothing installed). It also lists the five
// largest processes by RSS, by NAME only (`/proc/<pid>/status`, never the command line: that can hold a secret).

/** What the workspace's cgroup says now. Bytes, except `top` (MB). */
export interface MemoryReading {
  limitBytes: number;
  anonBytes: number;
  activeFileBytes: number;
  /** anon + active_file: what the budget and the alert measure. */
  usedBytes: number;
  /** The largest processes by RSS, largest first: the process name (kernel `comm`, untrusted, clipped) and its RSS in MB. */
  top: { name: string; mb: number }[];
  /** When it was read (ms). */
  at: number;
}

/**
 * `sh -c MEMORY_PROBE sh <cgroup root>`. `none` when the cgroup v2 files are not there (an old runtime, a Docker target without cgroup v2,
 * This machine at the root cgroup). Then `max <memory.max>`, the `anon` and `active_file` lines, and at most five `proc <kB> <name>` lines.
 */
export const MEMORY_PROBE = [
  'r=$1',
  '[ -r "$r/memory.max" ] && [ -r "$r/memory.stat" ] || { echo none; exit 0; }',
  'printf "max %s\\n" "$(cat "$r/memory.max")"',
  'grep -E "^(anon|active_file) " "$r/memory.stat"',
  'for f in /proc/[0-9]*/status; do',
  '  n=; k=',
  '  while read -r a b; do case $a in Name:) n=$b ;; VmRSS:) k=${b%% *} ;; esac; done 2>/dev/null < "$f"',
  '  [ -n "$k" ] && printf "proc %s %s\\n" "$k" "$n"',
  'done | sort -k2,2nr 2>/dev/null | head -n 5',
  'exit 0',
].join('\n');

export const CGROUP_ROOT = '/sys/fs/cgroup';

const clipName = (s: string): string => s.replace(/[^\w.@+:-]/g, '?').slice(0, 32) || '?';

/** The probe's output, or null when the reading is unavailable (no cgroup v2 files, no limit, or a line missing). */
export function parseMemoryProbe(output: string, at: number): MemoryReading | null {
  let limit: number | null = null;
  let anon: number | null = null;
  let activeFile: number | null = null;
  const top: { name: string; mb: number }[] = [];
  for (const line of output.split('\n')) {
    const [word, value, ...rest] = line.trim().split(/\s+/);
    const n = Number(value);
    if (word === 'none') return null;
    if (word === 'max') limit = value === 'max' || !Number.isFinite(n) || n <= 0 ? null : n;
    else if (word === 'anon' && Number.isFinite(n)) anon = n;
    else if (word === 'active_file' && Number.isFinite(n)) activeFile = n;
    else if (word === 'proc' && Number.isFinite(n) && top.length < 5) top.push({ name: clipName(rest.join(' ')), mb: Math.round(n / 1024) });
  }
  if (limit === null || anon === null || activeFile === null) return null;
  top.sort((a, b) => b.mb - a.mb);
  return { limitBytes: limit, anonBytes: anon, activeFileBytes: activeFile, usedBytes: anon + activeFile, top, at };
}

/** Runs the probe through `run` (the runtime's exec, to its end) and reads it; null when it is unavailable or the exec failed. */
export async function readWorkspaceMemory(
  run: (command: string[]) => Promise<{ code: number | null; output: string }>,
  opts: { root?: string; now?: () => number } = {},
): Promise<MemoryReading | null> {
  const { code, output } = await run(['sh', '-c', MEMORY_PROBE, 'sh', opts.root ?? CGROUP_ROOT]);
  if (code !== 0) return null;
  return parseMemoryProbe(output, (opts.now ?? Date.now)());
}
