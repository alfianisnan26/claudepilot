// T-610: a finished turn's usage as a true change in Claude Code's running totals, never a running total taken as a change.
// Claude Code reports each model's totals for the whole process (and, after `--resume`, may restore some of them and not others). The
// portal records the difference since the last result it saw, one dimension at a time, so a total that dropped in one dimension restarts
// only that dimension and never books another dimension's carried-over total as one request ($96.31 on one request, 2026-10-15).

import type { ModelTotals } from './protocol.js';

const EPS = 1e-9;

/**
 * `chat_usage.kind` of a row a person (or a repair) marked as wrong: a running total booked as one request. Every reader that sums spend, the
 * scorecard and the spike rules included, leaves it out (`COUNTED_USAGE`); the row stays in the table as evidence. Mark one with
 * \`UPDATE chat_usage SET kind = 'suspect' WHERE id IN (...)\`.
 */
export const SUSPECT_USAGE_KIND = 'suspect';
/** The SQL condition of a `chat_usage` row that counts. */
export const COUNTED_USAGE = `kind <> '${SUSPECT_USAGE_KIND}'`;

/** One dimension: the change, or the new total itself when it is lower than before (that count started again). */
function step(cur: number, was: number): number {
  return cur + EPS < was ? cur : Math.max(0, cur - was);
}

/** What `cur` adds to `was` (null: nothing seen before, so the whole total of a process that counts from zero). */
export function modelDelta(cur: ModelTotals, was: ModelTotals | undefined): ModelTotals {
  if (!was) return { ...cur };
  return {
    model: cur.model,
    input: step(cur.input, was.input),
    output: step(cur.output, was.output),
    cacheRead: step(cur.cacheRead, was.cacheRead),
    cacheWrite: step(cur.cacheWrite, was.cacheWrite),
    costUsd: step(cur.costUsd, was.costUsd),
  };
}

/** The totals to compare the next result with: the last of each model seen, so a model missing from one result is not "new" in the next. */
export function mergeBase(base: ReadonlyMap<string, ModelTotals> | undefined, seen: readonly ModelTotals[]): Map<string, ModelTotals> {
  const next = new Map(base ?? []);
  for (const m of seen) next.set(m.model, m);
  return next;
}

/**
 * The models' cost shares of one turn may not add up to more than the turn's own cost (the change of `total_cost_usd`, which counts the same
 * models): when they do by more than a margin, the cost is scaled down to it. A turn with no known cost of its own is left as it is.
 */
export function capToTurnCost(turn: ModelTotals[], turnCostUsd: number | undefined): ModelTotals[] {
  if (turnCostUsd === undefined || !Number.isFinite(turnCostUsd) || turnCostUsd < 0) return turn;
  const sum = turn.reduce((t, m) => t + m.costUsd, 0);
  const limit = turnCostUsd * 1.5 + 0.05;
  if (sum <= limit) return turn;
  const k = turnCostUsd / sum;
  return turn.map((m) => ({ ...m, costUsd: m.costUsd * k }));
}
