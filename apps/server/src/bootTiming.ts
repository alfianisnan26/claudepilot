// The boot timeline (owner request 2026-11-01, performance): how long a restarted portal is down before it listens. A release with the
// Recreate strategy is down for exactly this long, so `[boot] listening after N ms` is always logged; the marks between are logged only
// with PORTAL_BOOT_TIMING=1 (scripts/perf-boot.mjs sets it). Times are since the process started (module loading included).

const verbose = !!process.env.PORTAL_BOOT_TIMING;
let last = 0;

const now = () => Math.round(process.uptime() * 1000);

/** A step of the boot: its time since the process started and since the previous mark (with PORTAL_BOOT_TIMING=1). */
export function bootMark(label: string): void {
  const t = now();
  if (verbose) console.log(`[boot] ${String(t).padStart(6)} ms  +${t - last} ms  ${label}`);
  last = t;
}

/**
 * The one line every boot logs: the time from the process start to the listening socket, and the CPU time spent in it. Wall time far
 * above CPU time means the boot waited (a busy disk, a starved CPU share), not that it computed.
 */
export function bootListening(): number {
  const t = now();
  const cpu = process.cpuUsage();
  console.log(`[boot] listening after ${t} ms (cpu ${Math.round((cpu.user + cpu.system) / 1000)} ms)`);
  return t;
}
