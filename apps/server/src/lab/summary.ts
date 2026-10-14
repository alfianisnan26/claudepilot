// Efficiency lab (T-287 slice 2, docs/prd/claude-usage.md §28.8): the summary per period and per role and model, and the experiments' primary.
// Every figure is side by side with the others (never one number): medians and p90 of requests, context p50, result characters, minutes
// and cost per slice, the share of Bash calls by class, the re-written cache tokens, outcomes, first-pass yield and the median LOADED cost of
// an accepted slice (its own cost plus the rework and defect slices on the same ticket that ended before it: rejected work counts against
// it), with a bootstrap 90 percent interval from 20 values up. The bootstrap uses a fixed seed per group, so the same slices give the same
// interval every time.

import { createHash } from 'node:crypto';
import type { LabInterval, LabOutcome, LabPeriod, LabSliceView, LabStat, LabSummaryRow, LabToolClass } from '@portal/contracts';

export const BOOTSTRAP_MIN_N = 20;
export const BOOTSTRAP_RESAMPLES = 2000;

/** The middle value, or the mean of the two middle values (not truncated: these are summaries, not the script's per-slice numbers). */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** Median and the value at index floor(0.9 n) of the sorted values (the reference script's p90 rule). */
export function stat(values: readonly number[]): LabStat {
  if (!values.length) return { median: null, p90: null };
  const s = [...values].sort((a, b) => a - b);
  return { median: median(s), p90: s[Math.floor(s.length * 0.9)]! };
}

/** mulberry32: a small seeded generator, so an interval can be recomputed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A bootstrap 90 percent interval of the median: 2,000 resamples with replacement, the 5th and 95th percentile; under 20 values `n too small`. */
export function bootstrapMedian(values: readonly number[], seedKey: string): LabInterval {
  if (values.length < BOOTSTRAP_MIN_N) return 'n too small';
  const next = rng(createHash('sha256').update(seedKey).digest().readUInt32BE(0));
  const n = values.length;
  const medians: number[] = [];
  const pick = new Array<number>(n);
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    for (let i = 0; i < n; i++) pick[i] = values[Math.floor(next() * n)]!;
    medians.push(median(pick)!);
  }
  medians.sort((a, b) => a - b);
  return { low: medians[Math.floor(0.05 * BOOTSTRAP_RESAMPLES)]!, high: medians[Math.floor(0.95 * BOOTSTRAP_RESAMPLES)]! };
}

/** The period a time falls in: its UTC day, or the Monday of its UTC week. */
export function periodOf(ms: number, period: LabPeriod): string {
  const d = new Date(ms);
  if (period === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const key = (m: LabSliceView) => `${m.sessionId}\u0000${m.sliceId}`;

/**
 * The loaded cost of every accepted slice (key to dollars): per ticket in end order, the cost of rework and defect slices is carried to the
 * next accepted one. A slice without a price makes the loaded cost of the accepted slice it lands on unavailable (left out, never a guess).
 */
export function loadedCosts(slices: readonly LabSliceView[]): Map<string, number> {
  const byTicket = new Map<string, LabSliceView[]>();
  for (const m of slices) if (m.ticket && m.outcome !== 'unknown') byTicket.set(m.ticket, [...(byTicket.get(m.ticket) ?? []), m]);
  const out = new Map<string, number>();
  for (const list of byTicket.values()) {
    list.sort((a, b) => (a.endMs ?? 0) - (b.endMs ?? 0) || a.sliceId.localeCompare(b.sliceId));
    let carry: number | null = 0;
    for (const m of list) {
      if (m.outcome === 'accepted') {
        if (carry !== null && m.costUsd !== null) out.set(key(m), carry + m.costUsd);
        carry = 0;
      } else carry = carry === null || m.costUsd === null ? null : carry + m.costUsd;
    }
  }
  return out;
}

const roleOf = (m: LabSliceView) => (m.kind === 'turn' ? 'main' : (m.role ?? 'unknown'));

export function summaryRow(period: string, role: string, model: string | null, slices: readonly LabSliceView[], loaded: Map<string, number>): LabSummaryRow {
  const sum = (f: (m: LabSliceView) => number) => slices.reduce((s, m) => s + f(m), 0);
  const costs = slices.map((m) => m.costUsd).filter((c): c is number => c !== null);
  const bashCalls = sum((m) => m.bashCalls);
  const bashShare: Partial<Record<LabToolClass, number>> = {};
  if (bashCalls > 0) {
    for (const m of slices) for (const [c, k] of Object.entries(m.bashByClass ?? {})) bashShare[c as LabToolClass] = (bashShare[c as LabToolClass] ?? 0) + (k ?? 0);
    for (const c of Object.keys(bashShare) as LabToolClass[]) bashShare[c] = bashShare[c]! / bashCalls;
  }
  const writes = sum((m) => m.cacheWrite5m + m.cacheWrite1h);
  const rewriteTokens = sum((m) => m.rewriteTokens);
  const outcomes: Record<LabOutcome, number> = { accepted: 0, rework: 0, defect: 0, unknown: 0 };
  for (const m of slices) outcomes[m.outcome]++;
  const decided = outcomes.accepted + outcomes.rework + outcomes.defect;
  const acc = slices.map((m) => loaded.get(key(m))).filter((c): c is number => c !== undefined);
  return {
    period,
    role,
    model,
    n: slices.length,
    requests: stat(slices.map((m) => m.requests)),
    ctxP50: stat(slices.map((m) => m.ctxP50)),
    resultChars: stat(slices.map((m) => m.resultChars)),
    resultTokens: stat(slices.map((m) => m.resultTokens).filter((x): x is number => x !== null)),
    minutes: stat(slices.map((m) => m.minutes)),
    costUsd: costs.length ? stat(costs) : null,
    bashShare,
    bashCalls,
    rewriteTokens,
    rewriteShare: writes > 0 ? rewriteTokens / writes : null,
    outcomes,
    firstPassYield: decided ? outcomes.accepted / decided : null,
    costPerAccepted: median(acc),
    costPerAcceptedN: acc.length,
    costPerAcceptedInterval: bootstrapMedian(acc, `${period}|${role}|${model ?? ''}`),
  };
}

/** The rows: one per period, role and model, newest period first, then by n. */
export function summarize(slices: readonly LabSliceView[], period: LabPeriod): LabSummaryRow[] {
  const loaded = loadedCosts(slices);
  const groups = new Map<string, { period: string; role: string; model: string | null; list: LabSliceView[] }>();
  for (const m of slices) {
    if (m.startMs === null) continue;
    const p = periodOf(m.startMs, period);
    const k = `${p}\u0000${roleOf(m)}\u0000${m.model ?? ''}`;
    const g = groups.get(k) ?? { period: p, role: roleOf(m), model: m.model, list: [] };
    g.list.push(m);
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => summaryRow(g.period, g.role, g.model, g.list, loaded))
    .sort((a, b) => b.period.localeCompare(a.period) || b.n - a.n || a.role.localeCompare(b.role) || (a.model ?? '').localeCompare(b.model ?? ''));
}

export const SUMMARY_BASIS: Record<string, string> = {
  slices: 'Sub-agent threads and main-thread turns measured from the session stream (lab_requests, lab_tools; frozen numbers after 14 days).',
  requests: 'Assistant messages per slice, deduplicated by message id.',
  ctxP50: 'Each slice’s median context per request (cache read + cache write tokens); the row shows the median and p90 over slices.',
  resultChars: 'Tool result size in characters.',
  resultTokens: 'Estimate from the stream’s usage: each request’s context growth over the previous request’s context and output, laid on the results of the previous request’s tool calls. Slices without the figure are left out.',
  minutes: 'Last request minus first request of the slice.',
  costUsd: 'Estimate: (input + cache read × the model’s read weight + cache write × 1.25 or 2.0 + output × 5) × the model’s input price (lab/prices.ts, Anthropic list as of 2026-10-06). Read weight: Opus 5.5 0.05, Fable 5.1 0.025, others 0.1. A model without a price is unavailable.',
  bashShare: 'Bash calls of each class over all Bash calls of the row.',
  rewriteTokens: 'Cache tokens written again after a cache miss; the share is over all cache writes.',
  outcomes: 'From the ticket’s status timeline after the slice ended: done = accepted, in review back to work = rework, reopened within 7 days of done = defect; else unknown. A rule of thumb.',
  firstPassYield: 'Accepted over accepted + rework + defect.',
  costPerAccepted: 'Median loaded cost of an accepted slice: its cost plus the rework and defect slices on the same ticket before it. Interval: bootstrap 90 percent (2,000 resamples, fixed seed) from 20 accepted slices up.',
};
