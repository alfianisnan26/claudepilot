// Claude usage: what requests spent, read from `chat_usage` (docs/prd/claude-usage.md §20.1, §20.8), and how fast. The table is the chat
// module's (one row per model per finished request); this module only reads it, tolerant of a missing table or a locked store. The rates are
// pure functions over rows, so each is checked against a hand-computed fixture (spend.test.ts).

import {
  estimatedFigure,
  measuredFigure,
  unavailableFigure,
  type ChatUsageTotals,
  type Figure,
  type SpendRate,
  type SpendSpeed,
  type SpendToday,
} from '@portal/contracts';
import { COUNTED_USAGE } from '../chat/usageDelta.js';
import type { Store } from '../store/store.js';

const MIN = 60_000;
/** The trailing window of the spend rate. */
export const TRAILING_MS = 15 * MIN;
/** "Since the first request today" needs at least this long to mean anything. */
export const MIN_TODAY_SPAN_MS = 5 * MIN;

/** One stored row: a model's share of a finished request. The request, its sub-agents and its duration count on the request's first row. */
export interface SpendRow {
  atMs: number;
  workspaceId: string;
  /** '' for a request recorded without a Claude (before Claudes existed, or Default). */
  claudeId: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  requests: number;
  agents: number;
  durationMs: number;
}

/** A Claude as the chat module keeps it (`workspace_claudes`): a removed one keeps its row, so its name still reads. */
export interface ClaudeRef {
  id: string;
  workspaceId: string;
  name: string;
  /** '' is Default. */
  directory: string;
  removed: boolean;
}

export class SpendReader {
  constructor(private readonly store: Store) {}

  /** Rows finished from `fromMs` (inclusive) to `toMs` (exclusive), oldest first. */
  rowsBetween(fromMs: number, toMs = Number.MAX_SAFE_INTEGER): SpendRow[] {
    const db = this.store.db;
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT at_ms, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, duration_ms
           FROM chat_usage WHERE at_ms >= ? AND at_ms < ? AND ${COUNTED_USAGE} ORDER BY at_ms, id`,
        )
        .all(fromMs, toMs) as {
        at_ms: number;
        workspace_id: string;
        claude_id: string | null;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        cost_usd: number;
        requests: number;
        agents: number;
        duration_ms: number;
      }[];
      return rows.map((r) => ({
        atMs: r.at_ms,
        workspaceId: r.workspace_id,
        claudeId: r.claude_id ?? '',
        model: r.model,
        input: r.input_tokens,
        output: r.output_tokens,
        cacheRead: r.cache_read_tokens,
        cacheWrite: r.cache_write_tokens,
        costUsd: r.cost_usd,
        requests: r.requests,
        agents: r.agents,
        durationMs: r.duration_ms,
      }));
    } catch {
      return [];
    }
  }

  /** When the first request was recorded (the start of the portal's history), or null before any. */
  firstAtMs(): number | null {
    const db = this.store.db;
    if (!db) return null;
    try {
      const r = db.prepare(`SELECT MIN(at_ms) AS at FROM chat_usage WHERE ${COUNTED_USAGE}`).get() as { at: number | null } | undefined;
      return r?.at ?? null;
    } catch {
      return null;
    }
  }

  claudes(): ClaudeRef[] {
    const db = this.store.db;
    if (!db) return [];
    try {
      return (db.prepare('SELECT id, workspace_id, name, directory, removed_at FROM workspace_claudes').all() as { id: string; workspace_id: string; name: string; directory: string; removed_at: string | null }[]).map((r) => ({
        id: r.id,
        workspaceId: r.workspace_id,
        name: r.name,
        directory: r.directory,
        removed: r.removed_at !== null,
      }));
    } catch {
      return [];
    }
  }
}

/** Who a stored row belongs to, for a report. */
export interface ClaudeKey {
  /** What the palette and the series are keyed by: the Claude's id, or `default:<workspaceId>` when its workspace's Default is not known. */
  key: string;
  /** The Claude's id; '' only when the Default is not known. */
  claudeId: string;
  name: string;
  workspaceId: string;
}

/**
 * The Claudes of the portal, so a request is counted under the one it ran as. A request recorded without a Claude ran in Default (Workspace
 * Claudes FR2): it is counted under its workspace's Default Claude, so Default's earlier and later requests are one row.
 */
export class ClaudeIndex {
  readonly #byId = new Map<string, ClaudeRef>();
  readonly #defaults = new Map<string, ClaudeRef>();

  constructor(refs: ClaudeRef[]) {
    for (const r of refs) {
      this.#byId.set(r.id, r);
      if (r.directory === '' && (!this.#defaults.has(r.workspaceId) || this.#defaults.get(r.workspaceId)!.removed)) this.#defaults.set(r.workspaceId, r);
    }
  }

  get(id: string): ClaudeRef | undefined {
    return this.#byId.get(id);
  }

  resolve(row: { workspaceId: string; claudeId: string }): ClaudeKey {
    if (row.claudeId) {
      const ref = this.#byId.get(row.claudeId);
      return { key: row.claudeId, claudeId: row.claudeId, name: ref?.name ?? 'Removed', workspaceId: ref?.workspaceId ?? row.workspaceId };
    }
    const d = this.#defaults.get(row.workspaceId);
    return d ? { key: d.id, claudeId: d.id, name: d.name, workspaceId: d.workspaceId } : { key: `default:${row.workspaceId}`, claudeId: '', name: 'Default', workspaceId: row.workspaceId };
  }
}

/* ---------- Sums ---------- */

export const zeroTotals = (): ChatUsageTotals => ({ costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, agents: 0 });

export function addRow(into: ChatUsageTotals, r: Pick<SpendRow, 'costUsd' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'requests' | 'agents'>): void {
  // Dollars to a hundred-millionth: a stored cost has fewer decimals than that, and a long sum must not show floating-point dust (3.2199999999999998).
  into.costUsd = Math.round((into.costUsd + r.costUsd) * 1e8) / 1e8;
  into.input += r.input;
  into.output += r.output;
  into.cacheRead += r.cacheRead;
  into.cacheWrite += r.cacheWrite;
  into.requests += r.requests;
  into.agents += r.agents;
}

export function sumRows(rows: SpendRow[]): ChatUsageTotals {
  const t = zeroTotals();
  for (const r of rows) addRow(t, r);
  return t;
}

/** Tokens spent: input + output + cache writes. Cache reads are read, not spent, and are given apart. */
export const spendTokens = (t: Pick<ChatUsageTotals, 'input' | 'output' | 'cacheWrite'>): number => t.input + t.output + t.cacheWrite;

/** Most dollars first, then most requests. */
export const byCost = (a: ChatUsageTotals, b: ChatUsageTotals): number => b.costUsd - a.costUsd || b.requests - a.requests;

/* ---------- Rates (§20.1) ---------- */

const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places + 0;

function rateOf(window: SpendRate['window'], t: ChatUsageTotals, spanMs: number): SpendRate {
  const minutes = spanMs / MIN;
  const per = (v: number, places: number): Figure => estimatedFigure(round(v / minutes, places));
  return { window, spanMin: Math.round(minutes), requests: t.requests, tokensPerMin: per(spendTokens(t), 1), cacheReadPerMin: per(t.cacheRead, 1), costPerMin: per(t.costUsd, 4) };
}

function noRate(window: SpendRate['window'], reason: 'no_requests' | 'short_span', requests: number, spanMs: number): SpendRate {
  const f = (): Figure => unavailableFigure(reason);
  return { window, spanMin: Math.round(spanMs / MIN), requests, tokensPerMin: f(), cacheReadPerMin: f(), costPerMin: f() };
}

/**
 * How fast requests spend (docs §20.1). Trailing: what finished in (now - 15 min, now] over 15 minutes; zero requests is a real zero. Today: what
 * finished since `dayStartMs` over the time from the first request's start (its finish minus its own recorded duration, not before the day began)
 * to now: unavailable with no request today (`no_requests`) or under five minutes of it (`short_span`). A request counts when it finishes, so
 * each rate is an estimate.
 */
export function spendSpeed(rows: SpendRow[], nowMs: number, dayStartMs: number): SpendSpeed {
  const recent = rows.filter((r) => r.atMs > nowMs - TRAILING_MS && r.atMs <= nowMs);
  const today = rows.filter((r) => r.atMs >= dayStartMs && r.atMs <= nowMs);
  let todayRate: SpendRate;
  if (!today.length) todayRate = noRate('today', 'no_requests', 0, 0);
  else {
    const totals = sumRows(today);
    const startMs = Math.max(dayStartMs, today.reduce((m, r) => Math.min(m, r.atMs - Math.max(0, r.durationMs)), Infinity));
    const span = nowMs - startMs;
    todayRate = span < MIN_TODAY_SPAN_MS ? noRate('today', 'short_span', totals.requests, Math.max(0, span)) : rateOf('today', totals, span);
  }
  return { trailing: rateOf('15m', sumRows(recent), TRAILING_MS), today: todayRate };
}

/** What was spent since the day began: tokens and requests are stored counts (measured); dollars are Claude Code's price estimate. */
export function spendToday(rows: SpendRow[], nowMs: number, dayStartMs: number): SpendToday {
  const t = sumRows(rows.filter((r) => r.atMs >= dayStartMs && r.atMs <= nowMs));
  return { from: new Date(dayStartMs).toISOString(), costUsd: estimatedFigure(round(t.costUsd, 4)), tokens: measuredFigure(spendTokens(t)), cacheRead: measuredFigure(t.cacheRead), requests: measuredFigure(t.requests) };
}

/** The start of the viewer's day: `tzOffsetMin` is `Date.getTimezoneOffset()` (minutes behind UTC). */
export function dayStart(nowMs: number, tzOffsetMin = 0): number {
  const shift = -(Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0) * MIN;
  return Math.floor((nowMs + shift) / 86_400_000) * 86_400_000 - shift;
}
