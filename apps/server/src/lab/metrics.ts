// Efficiency lab (T-287): a slice's numbers from its stored requests and tool calls. The arithmetic is the reference script's
// (docs/dev-sessions/overhaul/evidence/slice_metrics.py) line for line, so the lab and the coordinator's baseline give the same numbers on
// the same tape: requests ordered by time (untimed last, then first seen), context = cache read + cache write, the median truncated, the
// 90th percentile at index floor(0.9 n), rewrites after a miss, units summed in the same order, minutes rounded half to even.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { LabSliceKind, LabSliceMetrics, LabToolClass } from '@portal/contracts';
import { cacheReadWeight, inputPricePerToken } from './prices.js';

export interface RequestRow {
  /** The assistant message id (slice 3: the key that links a request to the tool calls it made). Absent in old callers. */
  message_id?: string;
  at_ms: number | null;
  model: string | null;
  input: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write: number;
  output: number;
}

export interface ToolRow {
  tool: string | null;
  class: string | null;
  rtk: number;
  results: number;
  result_chars: number;
  /** The assistant message that made the call (migration 853); null for older rows or a result whose call was not seen. */
  message_id?: string | null;
}

export interface SliceRow {
  session_id: string;
  slice_id: string;
  kind: LabSliceKind;
  ticket: string | null;
  role: string | null;
  model: string | null;
  started_ms: number | null;
  effort?: string | null;
}

/** A gap between two requests longer than the short cache's life is idle time (§28.12). */
export const IDLE_GAP_MS = 5 * 60_000;

/**
 * Result tokens (§28.12), an estimate from the usage the stream reports. For each request after the first (in time order) the context it
 * sent (input + cache read + cache write) less the previous request's context and output is what came in between, at least 0; when the
 * previous request made tool calls, that growth is laid on their results, split by result characters (evenly when they are all empty).
 * Growth after a request without a tool call (a user's message) is not a result. null when the slice has results but none could be laid on
 * a request (tool rows from before migration 853).
 */
export function resultTokensOf(L: readonly RequestRow[], tools: readonly ToolRow[]): { total: number | null; byClass: Partial<Record<LabToolClass, number>> } {
  const byMessage = new Map<string, ToolRow[]>();
  for (const t of tools) {
    if (!t.message_id || !t.tool) continue;
    const list = byMessage.get(t.message_id) ?? [];
    list.push(t);
    byMessage.set(t.message_id, list);
  }
  const results = tools.reduce((n, t) => n + t.results, 0);
  if (!byMessage.size) return { total: results ? null : 0, byClass: {} };
  let total = 0;
  const exact: Partial<Record<LabToolClass, number>> = {};
  for (let i = 1; i < L.length; i++) {
    const p = L[i - 1]!, r = L[i]!;
    const calls = (p.message_id ? byMessage.get(p.message_id) : undefined)?.filter((t) => t.results > 0);
    if (!calls?.length) continue;
    const grew = Math.max(0, r.input + r.cache_read + r.cache_write - (p.input + p.cache_read + p.cache_write) - p.output);
    if (!grew) continue;
    total += grew;
    const chars = calls.reduce((n, t) => n + t.result_chars, 0);
    for (const t of calls) {
      const c = (t.class ?? 'other') as LabToolClass;
      exact[c] = (exact[c] ?? 0) + (chars > 0 ? (grew * t.result_chars) / chars : grew / calls.length);
    }
  }
  const byClass: Partial<Record<LabToolClass, number>> = {};
  for (const [c, v] of Object.entries(exact) as [LabToolClass, number][]) byClass[c] = Math.round(v);
  return { total, byClass };
}

/** Python's round(x, 1) for the values we meet: half to even on an exact tie. */
export function round1(x: number): number {
  const y = x * 10;
  const f = Math.floor(y);
  const r = y - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(y);
  return r / 10;
}

/** statistics.median, then int(): the middle value, or the mean of the two middle values, truncated toward zero. */
export function medianInt(sorted: readonly number[]): number {
  const n = sorted.length;
  const m = n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  return Math.trunc(m);
}

/** One slice's metrics. `requests` must be in first-seen order (rowid); this sorts them by time as the script does. */
export function computeSlice(meta: SliceRow, requests: readonly RequestRow[], tools: readonly ToolRow[]): LabSliceMetrics {
  const L = requests
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const an = a.r.at_ms === null, bn = b.r.at_ms === null;
      if (an !== bn) return an ? 1 : -1;
      if (!an && a.r.at_ms !== b.r.at_ms) return a.r.at_ms! - b.r.at_ms!;
      return a.i - b.i;
    })
    .map((x) => x.r);
  const ctx = L.map((r) => r.cache_read + r.cache_write);
  const sorted = [...ctx].sort((a, b) => a - b);
  let rewrite = 0;
  let prev: number | null = null;
  let read = 0, write = 0, out = 0, input = 0, cacheRead = 0, cw5 = 0, cw1 = 0, output = 0;
  for (const r of L) {
    if (prev && prev > 20000 && r.cache_read < 0.5 * prev && r.cache_read + r.cache_write >= 0.7 * prev) rewrite += Math.min(prev - r.cache_read, r.cache_write);
    prev = r.cache_read + r.cache_write;
    read += 0.1 * r.cache_read;
    write += 1.25 * r.cache_write_5m + 2.0 * r.cache_write_1h;
    out += 5.0 * r.output;
    input += r.input;
    cacheRead += r.cache_read;
    cw5 += r.cache_write_5m;
    cw1 += r.cache_write_1h;
    output += r.output;
  }
  const times = L.map((r) => r.at_ms).filter((t): t is number => t !== null);
  let idleMs = 0, maxGapMs = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!;
    if (gap > IDLE_GAP_MS) idleMs += gap;
    maxGapMs = Math.max(maxGapMs, gap);
  }
  const rt = resultTokensOf(L, tools);
  const startMs = times.length ? Math.min(...times) : null;
  const endMs = times.length ? Math.max(...times) : null;
  const toolCalls: Partial<Record<LabToolClass, number>> = {};
  const bashByClass: Partial<Record<LabToolClass, number>> = {};
  let bash = 0, rtk = 0, inspect = 0, results = 0, chars = 0;
  for (const t of tools) {
    results += t.results;
    chars += t.result_chars;
    if (!t.tool) continue; // a result whose call was not seen counts as a result only, as in the script
    const c = (t.class ?? 'other') as LabToolClass;
    toolCalls[c] = (toolCalls[c] ?? 0) + 1;
    if (t.tool === 'Bash') {
      bash++;
      bashByClass[c] = (bashByClass[c] ?? 0) + 1;
      if (t.rtk) rtk++;
      if (c === 'inspect') inspect++;
    }
  }
  const price = inputPricePerToken(meta.model);
  return {
    sessionId: meta.session_id,
    sliceId: meta.slice_id,
    kind: meta.kind,
    ticket: meta.ticket,
    role: meta.role,
    model: meta.model,
    effort: meta.effort ?? null,
    requests: L.length,
    ctxP50: L.length ? medianInt(sorted) : 0,
    ctxP90: L.length ? sorted[Math.floor(L.length * 0.9)]! : 0,
    input,
    cacheRead,
    cacheWrite5m: cw5,
    cacheWrite1h: cw1,
    output,
    units: { input, read, write, out },
    costUsd: price === null ? null : (input + cacheReadWeight(meta.model) * cacheRead + write + out) * price,
    rewriteTokens: rewrite,
    results,
    resultChars: chars,
    resultTokens: rt.total,
    resultTokensByClass: rt.byClass,
    idleMinutes: round1(idleMs / 60000),
    maxGapMinutes: round1(maxGapMs / 60000),
    bashCalls: bash,
    rtkCalls: rtk,
    inspectCalls: inspect,
    toolCalls,
    bashByClass,
    startMs,
    endMs,
    minutes: times.length > 1 ? round1((endMs! - startMs!) / 60000) : 0,
  };
}

export interface SliceFilter {
  sessionId?: string;
  kind?: LabSliceKind;
  ticket?: string;
  role?: string;
  model?: string;
  /** Slices whose first request is at or after this. */
  fromMs?: number;
  /** Slices whose first request is before this. */
  toMs?: number;
  /** These slices only (`session_id` and `slice_id`). */
  keys?: readonly { sessionId: string; sliceId: string }[];
}

/** Every slice that matches, with its metrics. A slice with no request yet (an Agent call that has not answered) is left out. */
export function sliceMetrics(db: DatabaseSync, filter: SliceFilter = {}): LabSliceMetrics[] {
  const where: string[] = [];
  const args: SQLInputValue[] = [];
  if (filter.sessionId) (where.push('session_id = ?'), args.push(filter.sessionId));
  if (filter.kind) (where.push('kind = ?'), args.push(filter.kind));
  if (filter.ticket) (where.push('ticket = ?'), args.push(filter.ticket));
  if (filter.role) (where.push('role = ?'), args.push(filter.role));
  if (filter.model) (where.push('model = ?'), args.push(filter.model));
  const metas = db.prepare(`SELECT session_id, slice_id, kind, ticket, role, model, started_ms, effort, frozen FROM lab_slices${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY session_id, slice_id`).all(...args) as unknown as (SliceRow & { frozen: string | null })[];
  const wanted = filter.keys ? new Set(filter.keys.map((k) => `${k.sessionId}\u0000${k.sliceId}`)) : null;
  const reqQ = db.prepare('SELECT message_id, at_ms, model, input, cache_read, cache_write_5m, cache_write_1h, cache_write, output FROM lab_requests WHERE session_id = ? AND slice_id = ? ORDER BY rowid');
  const toolQ = db.prepare('SELECT tool, class, rtk, results, result_chars, message_id FROM lab_tools WHERE session_id = ? AND slice_id = ?');
  const out: LabSliceMetrics[] = [];
  for (const meta of metas) {
    if (wanted && !wanted.has(`${meta.session_id}\u0000${meta.slice_id}`)) continue;
    let m: LabSliceMetrics;
    if (meta.frozen) {
      // Retention (§28.9) froze the numbers before the request rows went: the slice keeps them as they were.
      const f = JSON.parse(meta.frozen) as LabSliceMetrics;
      // Slices frozen before slice 3 have no result tokens (unavailable, never 0), effort or gaps.
      m = {
        ...f,
        bashByClass: f.bashByClass ?? {},
        effort: f.effort ?? null,
        resultTokens: f.resultTokens === undefined ? (f.results ? null : 0) : f.resultTokens,
        resultTokensByClass: f.resultTokensByClass ?? {},
        idleMinutes: f.idleMinutes ?? null,
        maxGapMinutes: f.maxGapMinutes ?? null,
      };
    } else {
      const reqs = reqQ.all(meta.session_id, meta.slice_id) as unknown as RequestRow[];
      if (!reqs.length) continue;
      m = computeSlice(meta, reqs, toolQ.all(meta.session_id, meta.slice_id) as unknown as ToolRow[]);
    }
    if (filter.fromMs !== undefined && (m.startMs === null || m.startMs < filter.fromMs)) continue;
    if (filter.toMs !== undefined && (m.startMs === null || m.startMs >= filter.toMs)) continue;
    out.push(m);
  }
  return out;
}
