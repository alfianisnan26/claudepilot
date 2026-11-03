// Pure rules of the dispatcher (T-3542): sizes and their price, the admission decision (caps, queue order, daily budget) and the egress
// policy for a container (which hosts it may reach, and the one kind of request that gets the git credential). No I/O here: the Durable
// Objects call these, and test/policy.test.ts checks them with a fake clock.

/** Instance sizes. std = standard-3 (2 vCPU, 8 GiB, 16 GB), big = standard-4 (4 vCPU, 12 GiB, 20 GB): wrangler.jsonc names the same. */
export const SIZES = {
  std: { instance: 'standard-3', vcpu: 2, memGiB: 8, diskGB: 16 },
  big: { instance: 'standard-4', vcpu: 4, memGiB: 12, diskGB: 20 },
} as const;
export type Size = keyof typeof SIZES;

// Workers Paid list rates (docs, 2026-10): memory per GiB-s (provisioned), CPU per vCPU-s (active use only), disk per GB-s.
const MEM = 0.0000025,
  CPU = 0.00002,
  DISK = 0.00000007;
/** CPU is billed on use: the ledger assumes half the vCPUs busy (plan §4.6 assumed 1 of 2). It over-counts memory never (it is provisioned). */
export const CPU_BUSY = 0.5;

/** Estimated USD for `seconds` of one container of `size` (the ledger's number; reconciled with the bill by hand). */
export function costUsd(size: Size, seconds: number): number {
  const s = SIZES[size];
  return Math.max(0, seconds) * (s.memGiB * MEM + s.vcpu * CPU_BUSY * CPU + s.diskGB * DISK);
}

export interface Limits {
  max: number; // containers at once, all workspaces
  perChat: number;
  perProgram: number;
  budgetUsdDay: number; // UTC day, all programs
  programUsdDay: number; // UTC day, per program
}

export interface Active {
  id: string;
  chat: string;
  program: string;
  size: Size;
  since: number; // ms
}
export interface Waiter {
  id: string;
  chat: string;
  program: string;
  first: number; // ms: when it first asked (queue order)
  seen: number; // ms: last ask (a waiter that stopped asking leaves the queue)
}
export interface Ledger {
  day: string; // YYYY-MM-DD (UTC)
  total: number; // USD of finished jobs today
  byProgram: Record<string, number>;
}

export const WAITER_TTL_MS = 30_000;

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Today's spend: the finished jobs plus what the running ones have used so far (so a stuck job counts while it runs). */
export function spent(ledger: Ledger, active: Active[], now: number, program?: string): number {
  const today = ledger.day === utcDay(now) ? ledger : { day: utcDay(now), total: 0, byProgram: {} };
  const done = program === undefined ? today.total : (today.byProgram[program] ?? 0);
  const running = active
    .filter((a) => program === undefined || a.program === program)
    .reduce((s, a) => s + costUsd(a.size, (now - Math.max(a.since, Date.parse(`${utcDay(now)}T00:00:00Z`))) / 1000), 0);
  return done + running;
}

export type Admission =
  | { kind: 'go' }
  | { kind: 'wait'; ahead: number; reason: string }
  | { kind: 'budget'; spentUsd: number; limitUsd: number; scope: 'total' | 'program' };

/**
 * May job `req` start now? Budget first (a refusal, not a wait: the caller stops), then the caps, then the queue: an older waiter that the
 * caps would let in goes first. The caller records `go` as Active and drops the waiter.
 */
export function admit(
  req: { id: string; chat: string; program: string },
  active: Active[],
  waiters: Waiter[],
  ledger: Ledger,
  lim: Limits,
  now: number,
): Admission {
  const total = spent(ledger, active, now);
  if (total >= lim.budgetUsdDay) return { kind: 'budget', spentUsd: total, limitUsd: lim.budgetUsdDay, scope: 'total' };
  const prog = spent(ledger, active, now, req.program);
  if (prog >= lim.programUsdDay) return { kind: 'budget', spentUsd: prog, limitUsd: lim.programUsdDay, scope: 'program' };
  const fits = (w: { chat: string; program: string }) =>
    active.length < lim.max &&
    active.filter((a) => a.chat === w.chat).length < lim.perChat &&
    active.filter((a) => a.program === w.program).length < lim.perProgram;
  const live = waiters.filter((w) => now - w.seen <= WAITER_TTL_MS && w.id !== req.id);
  const mine = waiters.find((w) => w.id === req.id)?.first ?? now;
  const older = live.filter((w) => w.first < mine || (w.first === mine && w.id < req.id));
  if (!fits(req)) {
    const why =
      active.length >= lim.max
        ? `at most ${lim.max} at once`
        : active.filter((a) => a.chat === req.chat).length >= lim.perChat
          ? `at most ${lim.perChat} per chat`
          : `at most ${lim.perProgram} per program`;
    return { kind: 'wait', ahead: active.length + older.length, reason: why };
  }
  const blocking = older.filter(fits);
  if (blocking.length > 0) return { kind: 'wait', ahead: active.length + older.length, reason: 'older jobs first' };
  return { kind: 'go' };
}

// ---- egress -------------------------------------------------------------------------------------------------------------------------

/** Hosts a job may reach (enableInternet is false: nothing else resolves). Globs: a leading "*." matches any subdomain. */
export const DEFAULT_ALLOW = [
  'gitlab.com',
  'registry.npmjs.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'nodejs.org',
];

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allow.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p.toLowerCase()));
}

/**
 * The git credential is added ONLY to a read of a repository under the allowed group on gitlab.com, during the fetch phase: the smart-HTTP
 * ref advertisement for upload-pack and the upload-pack POST. Never to a push (receive-pack), the API, the registry or any other path. The
 * token (a project token with write and api scopes, as delivered) is therefore usable for nothing but a clone, and only before any code
 * of the repository or a dependency runs.
 */
export function gitReadWithCredential(method: string, url: URL, group: string): boolean {
  if (url.protocol !== 'https:' || url.hostname !== 'gitlab.com' || url.port !== '') return false;
  const g = group.replace(/[^A-Za-z0-9_.-]/g, '');
  if (!g) return false;
  const repo = `^/${g}/(?:[A-Za-z0-9_.-]+/){0,3}[A-Za-z0-9_.-]+(?:\\.git)?`;
  if (method === 'GET' && new RegExp(`${repo}/info/refs$`).test(url.pathname)) return url.search === '?service=git-upload-pack';
  if (method === 'POST' && new RegExp(`${repo}/git-upload-pack$`).test(url.pathname)) return url.search === '';
  return false;
}

/** The ids the dispatcher hands out: cp-cf-<s|b><8 hex> (s = std, b = big). */
export const JOB_ID = /^cp-cf-([sb])([0-9a-f]{8})$/;
export const sizeOfId = (id: string): Size | null => {
  const m = JOB_ID.exec(id);
  return m ? (m[1] === 'b' ? 'big' : 'std') : null;
};
