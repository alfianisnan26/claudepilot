// What the Requests tab draws, as pure functions of the server's report (docs/prd/claude-usage.md §20.3, §20.6, §20.8): the stacked columns with
// their tooltip rows, the previous period beside them and the change figures on the tiles. Tested without a browser.

import { reasonText, type ChatUsageRange, type ChatUsageTotals, type Figure, type RequestsReport, type SpendFigure, type UnavailableReason } from '@portal/contracts';
import type { ChartColumn, ChartRow, ChartSegment } from '@/components/charts';
import { formatChange, formatCost, formatTokens, prettyModel } from '@/lib/usage/format';
import { stackColumns, type Measure, type StackItem } from '@/lib/usage/fold';

export type Metric = 'cost' | 'tokens' | 'requests';
/** What a stack is cut by: one band per Claude or per model. */
export type StackBy = 'claude' | 'model';

/** Tokens spent: input + output + cache writes. Cache reads are read, not spent, and are given apart (PRD §20.1, the one rule everywhere). */
export const spentTokens = (t: Pick<ChatUsageTotals, 'input' | 'output' | 'cacheWrite'>): number => t.input + t.output + t.cacheWrite;

export const MEASURE: Record<Metric, Measure> = { cost: (t) => t.costUsd, tokens: spentTokens, requests: (t) => t.requests };
export const FORMAT: Record<Metric, (v: number) => string> = {
  cost: formatCost,
  tokens: (v) => formatTokens(Math.round(v)),
  requests: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
};

/** A bucket's place on the axis, and what it covers, in this device's time. */
export function bucketWords(at: string, bucketMs: number, range: ChatUsageRange): { tick: string; span: string } {
  const start = new Date(at);
  const end = new Date(start.getTime() + bucketMs);
  const time = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (d: Date) => d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  const weekday = (d: Date) => d.toLocaleDateString([], { weekday: 'short' });
  if (range === '30d') return { tick: day(start), span: day(start) };
  if (range === '7d') return { tick: `${weekday(start)} ${time(start).slice(0, 2)}h`, span: `${weekday(start)} ${day(start)}, ${time(start)}–${time(end)}` };
  return { tick: time(start), span: `${time(start)}–${time(end)}` };
}

/** How many series carry each name, counting what is folded into "Others" too: a name shared by two Claudes needs its workspace. */
export function nameCounts(items: readonly StackItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);
  for (const it of items) {
    if (it.members) it.members.forEach((m) => add(m.label));
    else add(it.label);
  }
  return counts;
}

/**
 * What a segment is called: a Claude's name (with its workspace when two Claudes share the name: every workspace has a Default), a model in
 * words ("Opus 4.5"), or "Others".
 */
export function displayName(label: string, sub: string | null, kind: StackBy, counts: ReadonlyMap<string, number>): string {
  if (kind === 'model') return prettyModel(label);
  return (counts.get(label) ?? 0) > 1 && sub ? `${label} · ${sub}` : label;
}

/** How a slot is drawn: its colour, and the pattern over it when patterns are on. */
export type FillOf = (slot: number | null) => { fill: string; overlay: string | null };

export interface ColumnsInput {
  report: RequestsReport;
  items: readonly StackItem[];
  kind: StackBy;
  metric: Metric;
  /** Legend items switched off, by key. */
  hidden: ReadonlySet<string>;
  /** The previous period as a dashed line (off while a legend item is hidden: it covers everyone). */
  previous: boolean;
  fillOf: FillOf;
}

/** Members of "Others" shown in a tooltip row before "+N more". */
const OTHERS_SHOWN = 3;

/** The chart's columns: one band per shown series, a tooltip row per band (top first, "Others" naming who is in it), the previous period at the same position. */
export function chartColumns({ report, items, kind, metric, hidden, previous, fillOf }: ColumnsInput): ChartColumn[] {
  const measure = MEASURE[metric];
  const format = FORMAT[metric];
  const stacks = stackColumns(items, report.buckets.length, hidden);
  const byKey = new Map(items.map((it) => [it.key, it]));
  const counts = nameCounts(items);
  const names = new Map(items.map((it) => [it.key, it.members ? it.label : displayName(it.label, it.sub, kind, counts)]));
  const showPrevious = previous && report.previous.coverage !== 'none';
  return report.buckets.map((b, i) => {
    const stack = stacks[i]!;
    const words = bucketWords(b.at, report.bucketMs, report.range);
    const segments: ChartSegment[] = stack.segments.map((s) => ({ key: s.key, value: s.value, ...fillOf(byKey.get(s.key)!.slot) }));
    const rows: ChartRow[] = [...stack.segments]
      .reverse()
      .filter((s) => s.value > 0)
      .map((s) => {
        const it = byKey.get(s.key)!;
        const inBucket = (it.members ?? []).map((m) => ({ ...m, v: m.values[i] ?? 0 })).filter((m) => m.v > 0).sort((a, c) => c.v - a.v);
        const sub = it.members
          ? [...inBucket.slice(0, OTHERS_SHOWN).map((m) => ({ key: m.key, label: displayName(m.label, m.sub, kind, counts), value: format(m.v) })), ...(inBucket.length > OTHERS_SHOWN ? [{ key: 'more', label: `+${inBucket.length - OTHERS_SHOWN} more`, value: '' }] : [])]
          : undefined;
        return { key: s.key, label: names.get(s.key)!, value: format(s.value), ...fillOf(it.slot), sub };
      });
    const prev = showPrevious ? measure(report.previous.buckets[i] ?? ZERO) : null;
    const compare = prev === null ? undefined : `Before ${format(prev)}${prev > 0 ? ` · ${formatChange(((stack.total - prev) / prev) * 100)}` : ''}${report.previous.coverage === 'partial' ? ' (partial)' : ''}`;
    const detail =
      metric === 'tokens'
        ? `${formatTokens(b.input + b.cacheWrite)} in · ${formatTokens(b.output)} out · ${formatTokens(b.cacheRead)} cached`
        : b.requests
          ? `${b.requests} ${b.requests === 1 ? 'request' : 'requests'}${b.agents ? ` · ${b.agents} sub-agents` : ''}`
          : undefined;
    return {
      key: b.at,
      value: stack.total,
      tick: words.tick,
      span: words.span,
      detail,
      segments,
      rows,
      marker: prev,
      compare,
      label: `${words.span}: ${format(stack.total)}${rows.length ? `. ${rows.map((r) => `${r.label} ${r.value}`).join(', ')}` : ''}${compare ? `. ${compare}` : ''}`,
    };
  });
}

const ZERO: ChatUsageTotals = { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, agents: 0 };

/** What a tile says under its number about the previous period. */
export interface TileChange {
  /** "+321 % vs $1", "no earlier data". */
  hint: string;
  reason: UnavailableReason | null;
  /** The longer note for the tile's tip: the whole sentence. */
  note: string;
}

const SHORT_REASON: Partial<Record<string, string>> = { not_recorded: 'no earlier data', no_baseline: 'none before', no_history: 'no earlier data' };

/** The change of one measure against the previous period: "+321 % vs $1" when known, else a short reason (the tip has the whole sentence). */
export function tileChange(figure: SpendFigure | Figure, before: number, format: (v: number) => string, periodWords: string): TileChange {
  if (figure.basis === 'unavailable') {
    return { hint: SHORT_REASON[figure.reason] ?? '-', reason: figure.reason as UnavailableReason, note: `Against the ${periodWords} before: ${reasonText(figure.reason)}` };
  }
  return { hint: `${formatChange(figure.value)} vs ${format(before)}`, reason: null, note: `Against the ${periodWords} before (${format(before)}).` };
}
