// Efficiency lab (T-287): a slice's numbers from its stored requests and tool calls. The arithmetic is the reference script's
// (docs/dev-sessions/overhaul/evidence/slice_metrics.py) line for line, so the lab and the coordinator's baseline give the same numbers on
// the same tape: requests ordered by time (untimed last, then first seen), context = cache read + cache write, the median truncated, the
// 90th percentile at index floor(0.9 n), rewrites after a miss, units summed in the same order, minutes rounded half to even.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { LabSliceKind, LabSliceMetrics, LabToolClass } from '@portal/contracts';
import { inputPricePerToken } from './prices.js';

export interface RequestRow {
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
}

export interface SliceRow {
  session_id: string;
  slice_id: string;
  kind: LabSliceKind;
  ticket: string | null;
  role: string | null;
  model: string | null;
  started_ms: number | null;
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
  const startMs = times.length ? Math.min(...times) : null;
  const endMs = times.length ? Math.max(...times) : null;
  const toolCalls: Partial<Record<LabToolClass, number>> = {};
  let bash = 0, rtk = 0, inspect = 0, results = 0, chars = 0;
  for (const t of tools) {
    results += t.results;
    chars += t.result_chars;
    if (!t.tool) continue; // a result whose call was not seen counts as a result only, as in the script
    const c = (t.class ?? 'other') as LabToolClass;
    toolCalls[c] = (toolCalls[c] ?? 0) + 1;
    if (t.tool === 'Bash') {
      bash++;
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
    requests: L.length,
    ctxP50: L.length ? medianInt(sorted) : 0,
    ctxP90: L.length ? sorted[Math.floor(L.length * 0.9)]! : 0,
    input,
    cacheRead,
    cacheWrite5m: cw5,
    cacheWrite1h: cw1,
    output,
    units: { input, read, write, out },
    costUsd: price === null ? null : (input + read + write + out) * price,
    rewriteTokens: rewrite,
    results,
    resultChars: chars,
    bashCalls: bash,
    rtkCalls: rtk,
    inspectCalls: inspect,
    toolCalls,
    startMs,
    endMs,
    minutes: times.length > 1 ? round1((endMs! - startMs!) / 60000) : 0,
  };
}

export interface SliceFilter {
  sessionId?: string;
  kind?: LabSliceKind;
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
  const metas = db.prepare(`SELECT session_id, slice_id, kind, ticket, role, model, started_ms FROM lab_slices${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY session_id, slice_id`).all(...args) as unknown as SliceRow[];
  const wanted = filter.keys ? new Set(filter.keys.map((k) => `${k.sessionId}\u0000${k.sliceId}`)) : null;
  const reqQ = db.prepare('SELECT at_ms, model, input, cache_read, cache_write_5m, cache_write_1h, cache_write, output FROM lab_requests WHERE session_id = ? AND slice_id = ? ORDER BY rowid');
  const toolQ = db.prepare('SELECT tool, class, rtk, results, result_chars FROM lab_tools WHERE session_id = ? AND slice_id = ?');
  const out: LabSliceMetrics[] = [];
  for (const meta of metas) {
    if (wanted && !wanted.has(`${meta.session_id}\u0000${meta.slice_id}`)) continue;
    const reqs = reqQ.all(meta.session_id, meta.slice_id) as unknown as RequestRow[];
    if (!reqs.length) continue;
    const m = computeSlice(meta, reqs, toolQ.all(meta.session_id, meta.slice_id) as unknown as ToolRow[]);
    if (filter.fromMs !== undefined && (m.startMs === null || m.startMs < filter.fromMs)) continue;
    if (filter.toMs !== undefined && (m.startMs === null || m.startMs >= filter.toMs)) continue;
    out.push(m);
  }
  return out;
}
