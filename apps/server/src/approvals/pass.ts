// T-2889 (PILOT-1013): the one-time pass for a refused call a person allowed (docs/prd/approvals.md, "From a refusal").
//
// A pass is the sha256 of the EXACT call and an expiry, nothing else: no name, no value. The portal delivers the live passes of a workspace
// as a root-owned file (APPROVAL_PASSES_PATH, policy owner); job-run.sh and the rule guard compute the same hash for the call in front of
// them and let it through only when the file holds it, unexpired, and it is not in their used list. Each part is followed by a NUL, with the
// kind first, so one kind's pass never matches the other's call and no two different calls share a byte string.
//
//   jobrun.pool_env: kind, cwd, each argv element      (job-run: printf '%s\0' jobrun.pool_env "$PWD" "${argv0[@]}" | sha256sum)
//   guard.refusal:   kind, tool, canonical JSON of the input (keys sorted at every level), cwd as the hook gave it

import { createHash } from 'node:crypto';
import { APPROVAL_PASSES_PATH } from '../delivery/ownership.js';

/** The file the policy owner delivers (root:root 0644, outside every workspace folder). */
export { APPROVAL_PASSES_PATH };
/** How long a pass lives after Allow. */
export const PASS_TTL_MS = 15 * 60_000;
export const PASS_HASH = /^[0-9a-f]{64}$/;

/** JSON with the keys of every object sorted: the guard's script has the same function (`canon`), and a test holds them equal. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const digest = (parts: string[]) => createHash('sha256').update(parts.map((p) => `${p}\0`).join('')).digest('hex');

/** The pass of a stored request's payload, or null for a kind that has none. */
export function passOf(kind: string, payload: Record<string, unknown>): string | null {
  if (kind === 'jobrun.pool_env') {
    const args = payload.args as string[];
    return digest(['jobrun.pool_env', String(payload.cwd), ...args]);
  }
  if (kind === 'guard.refusal') return digest(['guard.refusal', String(payload.tool), canonicalJson(payload.input), String(payload.cwd)]);
  return null;
}

/** The kinds whose Allow issues a pass. */
export const PASS_KINDS = ['jobrun.pool_env', 'guard.refusal'] as const;

/** The pass a stored result holds (`output: { pass, until (ISO), used }`), or null. */
export function passFrom(result: string | null): { pass: string; until: number; used: boolean } | null {
  if (!result) return null;
  let r: unknown;
  try {
    r = JSON.parse(result);
  } catch {
    return null;
  }
  const o = (r as { ok?: unknown; output?: Record<string, unknown> } | null) ?? null;
  if (!o || o.ok !== true || !o.output) return null;
  const { pass, until, used } = o.output;
  const ms = typeof until === 'string' ? Date.parse(until) : NaN;
  if (typeof pass !== 'string' || !PASS_HASH.test(pass) || !Number.isFinite(ms)) return null;
  return { pass, until: ms, used: used === true };
}

/** The file's content: a header, then `<hash> <expiry in epoch seconds>` a line. */
export function passesContent(passes: { pass: string; until: number }[]): string {
  const lines = passes.filter((p) => PASS_HASH.test(p.pass)).map((p) => `${p.pass} ${Math.floor(p.until / 1000)}\n`);
  return `# claudepilot: one-time passes for refused calls a person allowed (T-2889). Root-owned; written by the portal.\n${lines.join('')}`;
}
