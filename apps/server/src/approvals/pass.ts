// T-2889 (PILOT-1013): the one-time pass for a refused call a person allowed (docs/prd/approvals.md, "From a refusal").
//
// A pass is the sha256 of the EXACT call and an expiry, nothing else: no name, no value. The portal delivers the live passes of a workspace
// as a root-owned file (APPROVAL_PASSES_PATH, policy owner); job-run.sh and the rule guard compute the same hash for the call in front of
// them and let it through only when the file holds it, unexpired, and it is not in their used list. Each part is followed by a NUL, with the
// kind first, so one kind's pass never matches the other's call and no two different calls share a byte string.
//
//   jobrun.pool_env: kind, cwd, each argv element      (job-run: printf '%s\0' jobrun.pool_env "$PWD" "${argv0[@]}" | sha256sum)
//   guard.refusal:   kind, tool, canonical JSON of the input (keys sorted at every level), cwd as the hook gave it; a Bash input
//                    without its free-text `description` (T-3233: a label, rewritten on most retries), every other field kept

import { createHash } from 'node:crypto';
import { REDACTED, redact } from '../chat/redact.js';
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

/**
 * T-2885 review M2: what a file tool would write is never stored (the card would show it): each content field is replaced by
 * `sha256:<hex>` of it, the same way the guard does (ruleGuard.ts `digestInput`) before the line is written. The pass hashes this form, so it
 * still binds the exact content. The portal applies it to what it pulls (a forged or old line with raw content); a value already in digest
 * form is kept, so the guard's line is unchanged. The guard digests every value, a digest-shaped one too, so a call that writes the
 * literal `sha256:<hex>` never matches the pass for the content it names.
 */
export const CONTENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Write: ['content'],
  Edit: ['old_string', 'new_string'],
  NotebookEdit: ['new_source'],
  MultiEdit: [],
};
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const dig = (s: string) => (DIGEST.test(s) ? s : `sha256:${createHash('sha256').update(s).digest('hex')}`);
function digestFields(o: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out = { ...o };
  for (const k of fields) if (typeof out[k] === 'string') out[k] = dig(out[k]);
  return out;
}
export function digestInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const fields = Object.hasOwn(CONTENT_FIELDS, tool) ? CONTENT_FIELDS[tool] : undefined;
  if (!fields) return input;
  const out = digestFields(input, fields);
  if (tool === 'MultiEdit' && Array.isArray(out.edits))
    out.edits = out.edits.map((e: unknown) =>
      e && typeof e === 'object' && !Array.isArray(e) ? digestFields(e as Record<string, unknown>, ['old_string', 'new_string']) : e,
    );
  return out;
}

/**
 * T-2885 review M2: what a refused call stores (the service applies it to every guard.refusal payload, from the outbox or approval_request,
 * before its checks). A file tool's content is never kept: each content field becomes `sha256:<hex>` (digestInput). Every other string of
 * the input, and the folder, goes through chat/redact.ts. A payload that redaction changed holds REDACTED, and Allow gives it no pass
 * (kinds.ts issuePass): it is not the call that was refused.
 */
export function cleanRefusal(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  const input = p.input;
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof p.tool !== 'string') return payload;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out: Record<string, unknown> = { ...p, input: walk(digestInput(p.tool, input as Record<string, unknown>)) };
  if (typeof p.cwd === 'string') out.cwd = redact(p.cwd);
  return out;
}

/**
 * T-2885 review M1: job-run.sh's `pool_denied` as patterns; keep the two lists in step. A shell `case` glob: `*` is any run of characters.
 */
export const JOBRUN_DENIED_GLOBS = [
  '*_RW_*',
  '*ADMIN*',
  '*PROD*',
  '*_PRD_*',
  'CLOUDFLARE_API_TOKEN',
  'GITEA_*',
  'GITHUB_*',
  '*_MASTER_*',
  '*_RW',
  'RW_*',
  '*_PRD',
  'PRD_*',
  '*_MASTER',
  'MASTER_*',
  'GH_*',
  'NODE_AUTH_TOKEN',
  'ANTHROPIC_*',
  'CLAUDE_*',
  'CLAUDEPILOT_*',
  'PILOT_*',
] as const;
const globRe = (g: string) =>
  new RegExp(
    `^${g
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
const DENIED = JOBRUN_DENIED_GLOBS.map(globRe);
export const jobRunDenies = (name: string) => DENIED.some((r) => r.test(name));
/** job-run.sh's options that take a value (its `case` before `--pool-env)`): each consumes the next word. */
const JOBRUN_VALUE_OPTS = new Set([
  '--repo',
  '--ref',
  '--against',
  '--keep-tests',
  '--also',
  '--steps',
  '--artifacts',
  '--out',
  '--timeout',
  '--role',
  '--pool-env',
  '--image',
]);
/** The `--pool-env` names of a run, parsed as job-run parses its arguments (a value option takes the next word; `--` ends the options). */
export function poolEnvNames(args: readonly unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (typeof a === 'string' && JOBRUN_VALUE_OPTS.has(a)) {
      if (a === '--pool-env' && typeof args[i + 1] === 'string') out.push(args[i + 1] as string);
      i++;
    }
  }
  return out;
}
/** The deny-listed `--pool-env` names of a run, each once, in order: what one pass lets through (and what the card names, review m4). */
export const deniedPoolEnvNames = (args: readonly unknown[]) => [...new Set(poolEnvNames(args).filter(jobRunDenies))];
/** Whether job-run refuses this run: the name is deny-listed and the arguments pass it as `--pool-env <name>` (job-run's own parse). */
export function refusedByJobRun(p: Record<string, unknown>): boolean {
  const name = p.name;
  const args = p.args;
  if (typeof name !== 'string' || !Array.isArray(args) || !jobRunDenies(name)) return false;
  return poolEnvNames(args).includes(name);
}

/** Whether a stored payload lost parts to redaction (then it is not the exact call, and gets no pass). */
export const wasRedacted = (payload: unknown) => JSON.stringify(payload ?? null).includes(REDACTED);

const digest = (parts: string[]) =>
  createHash('sha256')
    .update(parts.map((p) => `${p}\0`).join(''))
    .digest('hex');

/** T-3206: a refusal payload with its tool input's free-text `description` left out (anything else: unchanged). */
export function withoutDescription<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  if (!p.input || typeof p.input !== 'object' || Array.isArray(p.input)) return payload;
  const { description: _free, ...input } = p.input as Record<string, unknown>;
  return { ...p, input } as T;
}

/** The pass of a stored request's payload, or null for a kind that has none. */
export function passOf(kind: string, payload: Record<string, unknown>): string | null {
  if (kind === 'jobrun.pool_env') {
    const args = payload.args as string[];
    return digest(['jobrun.pool_env', String(payload.cwd), ...args]);
  }
  if (kind === 'guard.refusal') {
    // T-3233: a Bash call's `description` is a label that does not change what runs, and Claude Code writes a new one on most retries;
    // the guard leaves it out the same way (ruleGuard.ts `passOfCall`). Another tool's description may mean something, so it stays.
    const call = payload.tool === 'Bash' ? withoutDescription(payload) : payload;
    const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? (call.input as Record<string, unknown>) : {};
    return digest(['guard.refusal', String(payload.tool), canonicalJson(digestInput(String(payload.tool), input)), String(payload.cwd)]);
  }
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
