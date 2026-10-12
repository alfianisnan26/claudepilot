// Claude usage: the Requests report with the previous period, the cache split, palette slots and the per-bucket series for stacked charts
// (docs/prd/claude-usage.md §20.3, §20.6, §20.8). The same rows and the same bucket rule as `GET /api/chat/usage` (chat/usage.ts), plus what the
// owner asked for on top. Rows are read from `chat_usage` (spend.ts); nothing here writes except the palette's first-sight assignments.

import {
  cacheSplit,
  estimatedFigure,
  measuredFigure,
  REQUEST_BASIS,
  unavailableFigure,
  type ChatUsageRange,
  type ChatUsageTotals,
  type Figure,
  type PaletteKind,
  type RequestsReport,
  type UsageChange,
  type UsageComparison,
  type UsageSeries,
} from '@portal/contracts';
import { usageWindow } from '../chat/usage.js';
import type { Palette } from './palette.js';
import { addRow, byCost, ClaudeIndex, spendTokens, zeroTotals, type ClaudeKey, type SpendReader, type SpendRow } from './spend.js';

export interface RequestsDeps {
  reader: SpendReader;
  palette: Palette;
  /** Multi-user seam: false leaves a Claude's requests out (the asking user may not use it). Absent: all. */
  allow?: (claude: ClaudeKey) => boolean;
}

const round1 = (v: number): number => Math.round(v * 10) / 10 + 0;

/** Percent change of a measure: (this - before) / before x 100. Unavailable when the previous period is not recorded or is zero. */
function change(now: number, before: number, coverage: UsageComparison['coverage'], estimate: boolean): Figure {
  if (coverage !== 'full') return unavailableFigure('not_recorded');
  if (before === 0) return unavailableFigure('no_baseline');
  const pct = round1(((now - before) / before) * 100);
  return estimate ? estimatedFigure(pct) : measuredFigure(pct);
}

interface Acc {
  firstAtMs: number;
  totals: ChatUsageTotals;
  buckets: (ChatUsageTotals | null)[];
}

const slotsOf = (palette: Palette, kind: PaletteKind, entries: Map<string, Acc>) => palette.slots(kind, [...entries.entries()].map(([key, a]) => ({ key, seenMs: a.firstAtMs })));

/**
 * The report over `range`, ending now. `claudeId` narrows everything to one Claude (a Default Claude includes the requests recorded without
 * one). `tzOffsetMin` is the viewer's `Date.getTimezoneOffset()`, so buckets start at their midnights.
 */
export function buildRequestsReport(deps: RequestsDeps, range: ChatUsageRange, opts: { claudeId?: string; tzOffsetMin?: number; now: number }): RequestsReport {
  const w = usageWindow(range, opts.now, opts.tzOffsetMin);
  const span = w.count * w.bucket;
  const prevStart = w.start - span;
  const index = new ClaudeIndex(deps.reader.claudes());
  const keyOf = new Map<string, ClaudeKey>();
  const claudeOf = (r: SpendRow): ClaudeKey => {
    const id = `${r.workspaceId}\u0000${r.claudeId}`;
    let k = keyOf.get(id);
    if (!k) {
      k = index.resolve(r);
      keyOf.set(id, k);
    }
    return k;
  };

  const buckets = Array.from({ length: w.count }, (_, i) => ({ at: new Date(w.start + i * w.bucket).toISOString(), ...zeroTotals() }));
  const prevBuckets = Array.from({ length: w.count }, (_, i) => ({ at: new Date(prevStart + i * w.bucket).toISOString(), ...zeroTotals() }));
  const totals = zeroTotals();
  const prevTotals = zeroTotals();
  const claudes = new Map<string, Acc & { ref: ClaudeKey }>();
  const models = new Map<string, Acc>();
  const bump = <T extends Acc>(m: Map<string, T>, key: string, r: SpendRow, i: number, make: () => T): void => {
    let a = m.get(key);
    if (!a) {
      a = make();
      m.set(key, a);
    }
    addRow(a.totals, r);
    addRow((a.buckets[i] ??= zeroTotals()), r);
  };
  const empty = (): (ChatUsageTotals | null)[] => Array.from({ length: w.count }, () => null);

  for (const r of deps.reader.rowsBetween(prevStart, w.end)) {
    const ref = claudeOf(r);
    if (opts.claudeId && ref.claudeId !== opts.claudeId && ref.key !== opts.claudeId) continue;
    if (deps.allow && !deps.allow(ref)) continue;
    if (r.atMs < w.start) {
      addRow(prevBuckets[Math.floor((r.atMs - prevStart) / w.bucket)]!, r);
      addRow(prevTotals, r);
      continue;
    }
    const i = Math.floor((r.atMs - w.start) / w.bucket);
    if (i < 0 || i >= w.count) continue;
    addRow(buckets[i]!, r);
    addRow(totals, r);
    bump(claudes, ref.key, r, i, () => ({ ref, firstAtMs: r.atMs, totals: zeroTotals(), buckets: empty() }));
    bump(models, r.model, r, i, () => ({ firstAtMs: r.atMs, totals: zeroTotals(), buckets: empty() }));
  }

  const claudeSlots = slotsOf(deps.palette, 'claude', claudes);
  const modelSlots = slotsOf(deps.palette, 'model', models);
  const claudeList = [...claudes.entries()].sort((a, b) => byCost(a[1].totals, b[1].totals) || (a[0] < b[0] ? -1 : 1));
  const modelList = [...models.entries()].sort((a, b) => byCost(a[1].totals, b[1].totals) || (a[0] < b[0] ? -1 : 1));

  const firstAt = deps.reader.firstAtMs();
  const coverage: UsageComparison['coverage'] = firstAt === null || firstAt >= w.start ? 'none' : firstAt <= prevStart ? 'full' : 'partial';
  const changes: UsageChange = {
    costUsd: change(totals.costUsd, prevTotals.costUsd, coverage, true),
    tokens: change(spendTokens(totals), spendTokens(prevTotals), coverage, false),
    requests: change(totals.requests, prevTotals.requests, coverage, false),
  };

  const series = (kind: PaletteKind, key: string, a: Acc, label: string, sub: string | null, workspaceId: string | null, slot: number | null): UsageSeries => ({
    kind,
    key,
    label,
    sub,
    workspaceId,
    slot,
    totals: a.totals,
    cache: cacheSplit(a.totals),
    buckets: a.buckets,
  });
  const nameOfWorkspace = (id: string) => id.split('/').pop() ?? id;

  return {
    range,
    from: new Date(w.start).toISOString(),
    to: new Date(w.end).toISOString(),
    bucketMs: w.bucket,
    totals,
    buckets,
    byClaude: claudeList.map(([key, a]) => ({ ...a.totals, claudeId: a.ref.claudeId, name: a.ref.name, workspaceId: a.ref.workspaceId, slot: claudeSlots.get(key) ?? null, cache: cacheSplit(a.totals) })),
    byModel: modelList.map(([key, a]) => ({ ...a.totals, model: key, slot: modelSlots.get(key) ?? null, cache: cacheSplit(a.totals) })),
    cache: cacheSplit(totals),
    previous: { from: new Date(prevStart).toISOString(), to: new Date(w.start).toISOString(), coverage, totals: prevTotals, buckets: prevBuckets, change: changes },
    claudes: claudeList.map(([key, a]) => series('claude', key, a, a.ref.name, nameOfWorkspace(a.ref.workspaceId), a.ref.workspaceId, claudeSlots.get(key) ?? null)),
    models: modelList.map(([key, a]) => series('model', key, a, key, null, null, modelSlots.get(key) ?? null)),
    basis: REQUEST_BASIS,
  };
}
