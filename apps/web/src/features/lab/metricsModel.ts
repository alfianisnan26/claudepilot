// What the Metrics view says (T-2360, docs/prd/claude-usage.md §28.15): the efficiency and effectiveness scores, the stages of a done ticket,
// the leads side by side, the closures, the lead-time spread, the account pace, the findings and the drill-down rows. Pure, so the numbers and
// the wording are tested without a browser. A figure the portal does not have is "unavailable" with its reason, never 0.

import type {
  MetricsFlow,
  MetricsFlowGroup,
  MetricsInsight,
  MetricsInsights,
  MetricsOverview,
  MetricsProgram,
  MetricsScore,
  MetricsStage,
  MetricsStageStat,
  MetricsTickets,
  MetricsTicketRow,
  MetricsTrend,
  MetricsWindow,
} from '@portal/contracts';
import { UNAVAILABLE, formatSpan, histogramBins, type LinePoint, type StageRow } from '@/components/chartMath';
import type { ChartColumn } from '@/components/charts';
import { reasonText } from './scorecardModel';

export { UNAVAILABLE, formatSpan };

export const WINDOW_OPTIONS: { value: MetricsWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
];

/** The query string of a read: empty values are left out, the rest is encoded. */
export function metricsQuery(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, v);
  return q.toString();
}

/** The program choices: `all` first, then the rest in the server's order. A program without figures stays in the list (it says why). */
export function programOptions(programs: MetricsProgram[]): { value: string; label: string }[] {
  const all = programs.filter((p) => p.kind === 'all');
  return [...all, ...programs.filter((p) => p.kind !== 'all')].map((p) => ({ value: p.id, label: p.label }));
}

/** The program to show: the one asked for when it is in the list, else the first (`all`). */
export const pickProgram = (programs: MetricsProgram[], id: string | null): string =>
  id && programs.some((p) => p.id === id) ? id : (programOptions(programs)[0]?.value ?? 'all');

// ───────────────────────── scores ─────────────────────────

export interface ComponentLine {
  id: string;
  label: string;
  /** "40 %", or "40 % (45 % applied)" when the others' weight was shared with it. */
  weight: string;
  /** "72" or "unavailable". */
  value: string;
  /** "measured", "estimate" or "unavailable: no quota reading". */
  basis: string;
  source: string;
  raw: string;
}

export interface ScoreView {
  label: string;
  value: number | null;
  previous: number | null;
  /** Why there is no score. */
  reason: string | undefined;
  /** One line: the weights, what was left out, where the spec comes from (from the API). */
  basis: string;
  components: ComponentLine[];
}

const pct = (n: number) => `${Math.round(n * 10) / 10} %`;

export function componentLines(score: MetricsScore): ComponentLine[] {
  return score.components.map((c) => ({
    id: c.id,
    label: c.label,
    weight: c.value === null || c.appliedWeight === c.weight ? pct(c.weight) : `${pct(c.weight)} (${pct(c.appliedWeight)} applied)`,
    value: c.value === null ? UNAVAILABLE : String(Math.round(c.value)),
    basis: c.basis === 'unavailable' ? `unavailable: ${reasonText(c.reason)}` : c.basis,
    source: c.source,
    raw: c.raw,
  }));
}

/** One score tile. Without a value: the program's own reason (memor.id has no tickets), else the first component's. */
export function scoreView(label: string, score: MetricsScore | undefined, program: MetricsProgram | undefined): ScoreView {
  if (!score) return { label, value: null, previous: null, reason: 'not read yet', basis: '', components: [] };
  const value = score.value;
  let reason: string | undefined;
  if (value === null) {
    const first = score.components.find((c) => c.basis === 'unavailable');
    reason = program?.unavailable
      ? program.unavailable.text
      : first
        ? `${first.label}: ${reasonText(first.reason)}`
        : 'no input is available';
  }
  return { label, value, previous: score.previous, reason, basis: score.basis, components: componentLines(score) };
}

// ───────────────────────── stages and leads ─────────────────────────

export const STAGE_INFO: Record<MetricsStage, { label: string; tip: string }> = {
  start: { label: 'Start', tip: 'Created to the first move into in progress.' },
  report: { label: 'Report', tip: 'Created to the first comment by an agent session.' },
  implement: {
    label: 'Implement',
    tip: 'First in progress to the first verdict (a QA or review verdict, or a self-test line); with none, to the first merge.',
  },
  test: { label: 'Test', tip: 'First verdict to the last passing one.' },
  deliver: { label: 'Deliver', tip: 'The last merge to the close.' },
  resolve: { label: 'Resolve', tip: 'Created to done: the whole life of the ticket.' },
  work: { label: 'Work', tip: 'First in progress to done.' },
};

/** The five steps in order, then the two totals (shown apart: a total would swallow the steps on a shared axis). */
export const STEP_STAGES: MetricsStage[] = ['start', 'report', 'implement', 'test', 'deliver'];
export const TOTAL_STAGES: MetricsStage[] = ['resolve', 'work'];

const statOf = (g: MetricsFlowGroup['current'], stage: MetricsStage): MetricsStageStat | undefined =>
  g.stages.find((s) => s.stage === stage);

function noteFor(done: number, s: MetricsStageStat | undefined): string | undefined {
  if (s && s.n > 0) return undefined;
  if (done === 0) return 'no ticket was done in this window';
  return s && s.excluded > 0 ? 'no ticket had both ends of this stage recorded' : 'not recorded';
}

export function stageRows(group: MetricsFlowGroup | null, stages: MetricsStage[]): StageRow[] {
  if (!group) return [];
  return stages.map((stage) => {
    const s = statOf(group.current, stage);
    return {
      key: stage,
      label: STAGE_INFO[stage].label,
      median: s?.medianMs ?? null,
      p90: s?.p90Ms ?? null,
      n: s?.n ?? 0,
      excluded: s?.excluded,
      note: noteFor(group.current.done, s),
    };
  });
}

/** A group key in words: `area-x` stays, `lead:<session>` is "lead " and the first 8 characters, `unrecorded` is "Unrecorded". */
export function leadLabel(key: string): string {
  if (key === 'unrecorded') return 'Unrecorded';
  if (key.startsWith('lead:')) return `lead ${key.slice(5, 13)}`;
  return key;
}

export const MAX_LEAD_ROWS = 10;

/** One row per lead (created to done): the median and p90, n, and how many tickets the lead closed in the window. */
export function leadRows(flow: MetricsFlow | null, stage: MetricsStage = 'resolve'): { rows: StageRow[]; hidden: number } {
  if (!flow) return { rows: [], hidden: 0 };
  const rows = flow.groups.slice(0, MAX_LEAD_ROWS).map((g): StageRow => {
    const s = statOf(g.current, stage);
    return {
      key: g.key,
      label: leadLabel(g.key),
      sub: `${g.current.done} done`,
      median: s?.medianMs ?? null,
      p90: s?.p90Ms ?? null,
      n: s?.n ?? 0,
      excluded: s?.excluded,
      note: noteFor(g.current.done, s),
    };
  });
  return { rows, hidden: Math.max(0, flow.groups.length - rows.length) };
}

// ───────────────────────── closures and lead time ─────────────────────────

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const two = (n: number) => String(n).padStart(2, '0');

export interface Closures {
  columns: ChartColumn[];
  /** "hour" or "day": what a column covers. */
  per: 'hour' | 'day';
  done: number;
  /** Closed rows the read did not carry (the drill-down keeps the newest 200): older columns may be short. */
  missing: number;
}

/** Done tickets per hour over 24h, per day over 7d: the window cut into equal slices ending at `nowMs` (so the last column is the newest). */
export function closureColumns(tickets: MetricsTickets | null, window: MetricsWindow): Closures {
  const per = window === '24h' ? 'hour' : 'day';
  const step = per === 'hour' ? HOUR : DAY;
  const n = window === '24h' ? 24 : 7;
  const now = tickets?.nowMs ?? 0;
  const start = now - n * step;
  const counts = new Array<number>(n).fill(0);
  const wont = new Array<number>(n).fill(0);
  let done = 0;
  for (const r of tickets?.rows ?? []) {
    const i = Math.floor((r.closedAtMs - start) / step);
    if (i < 0 || i >= n) continue;
    if (r.status === 'done') {
      counts[i] = (counts[i] ?? 0) + 1;
      done++;
    } else wont[i] = (wont[i] ?? 0) + 1;
  }
  const columns = counts.map((value, i): ChartColumn => {
    const from = new Date(start + i * step);
    const to = new Date(start + (i + 1) * step);
    const hm = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;
    const day = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return {
      key: String(start + i * step),
      value,
      tick: per === 'hour' ? hm(from) : day(from),
      span: per === 'hour' ? `${hm(from)} to ${hm(to)}` : `${day(from)} ${hm(from)} to ${day(to)} ${hm(to)}`,
      detail: wont[i] ? `${wont[i]} won't do` : undefined,
      label: `${per === 'hour' ? hm(from) : day(from)}: ${value} done`,
    };
  });
  return { columns, per, done, missing: Math.max(0, (tickets?.total ?? 0) - (tickets?.rows.length ?? 0)) };
}

/** Nearest rank, as the server does (the scorecard's `percentile`): the value at ceil(p * n). Null with none. */
export function nearestRank(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))] ?? null;
}

export interface LeadTimeSpread {
  edges: number[];
  counts: number[];
  median: number | null;
  /** Done tickets in the chart. */
  n: number;
  /** Tickets longer than the last bin (the axis stops at 3 times the p90 so one outlier does not flatten the rest). */
  beyond: number;
  /** Tickets the read did not carry (more than 200 closed). */
  missing: number;
}

/** The created-to-done times of the window's done tickets in ten equal bins from 0. */
export function leadTimeSpread(tickets: MetricsTickets | null): LeadTimeSpread {
  const values = (tickets?.rows ?? [])
    .filter((r) => r.status === 'done')
    .flatMap((r) => (r.stages.resolve === null ? [] : [r.stages.resolve]));
  const missing = Math.max(0, (tickets?.total ?? 0) - (tickets?.rows.length ?? 0));
  if (!values.length) return { edges: [], counts: [], median: null, n: 0, beyond: 0, missing };
  const p90 = nearestRank(values, 0.9) ?? 0;
  const max = Math.max(...values);
  const top = p90 > 0 && max > 3 * p90 ? 3 * p90 : max;
  const { edges, counts } = histogramBins(values, 10, { min: 0, max: top });
  const inside = counts.reduce((a, c) => a + c, 0);
  return { edges, counts, median: nearestRank(values, 0.5), n: values.length, beyond: values.length - inside, missing };
}

// ───────────────────────── trend ─────────────────────────

export interface TrendView {
  series: { key: string; label: string; points: LinePoint[] }[];
  /** No snapshot has a score yet. */
  empty: boolean;
}

export function trendView(efficiency: MetricsTrend | null, effectiveness: MetricsTrend | null): TrendView {
  const mk = (key: string, label: string, t: MetricsTrend | null) => ({
    key,
    label,
    points: (t?.points ?? []).map((p): LinePoint => ({ t: p.atMs, v: p.value })),
  });
  const series = [mk('efficiency', 'Efficiency', efficiency), mk('effectiveness', 'Effectiveness', effectiveness)];
  return { series, empty: series.every((s) => s.points.every((p) => p.v === null)) };
}

// ───────────────────────── account pace ─────────────────────────

export interface PaceRow {
  key: string;
  label: string;
  /** usedPct / evenPct; 1 spends the quota exactly by the reset. */
  ratio: number;
  /** "used 40 % of 50 % even" */
  sub: string;
  state: 'under' | 'on' | 'over';
}

export interface PaceView {
  rows: PaceRow[];
  /** Said when there are no rows: why the pace is not shown. */
  note: string | null;
}

/** Each Claude's pace in its 5-hour window (the crew headline the overview carries); a note instead when it does not. */
export function paceView(o: MetricsOverview | null): PaceView {
  if (!o) return { rows: [], note: null };
  if (!o.crew) return { rows: [], note: 'Account pace: unavailable, the crew figures could not be read.' };
  const pace = o.crew.headline.pace;
  const rows = pace.claudes.flatMap((c): PaceRow[] =>
    c.ratio.value === null
      ? []
      : [
          {
            key: c.claude,
            label: c.label,
            ratio: c.ratio.value,
            sub: `used ${Math.round(c.usedPct)} % of ${Math.round(c.evenPct)} % even`,
            state: c.ratio.value < 0.9 ? 'under' : c.ratio.value > 1.1 ? 'over' : 'on',
          },
        ],
  );
  if (rows.length) return { rows, note: null };
  return { rows: [], note: `Account pace: unavailable, ${reasonText(pace.ratio.reason)}.` };
}

export const fmtRatio = (v: number) => `${v.toFixed(2)} : 1`;

// ───────────────────────── findings and the drill-down ─────────────────────────

export interface InsightRow {
  key: string;
  severity: MetricsInsight['severity'];
  /** The severity in words (never by colour alone). */
  word: string;
  text: string;
  tickets: string[];
}

const SEVERITY_WORD: Record<MetricsInsight['severity'], string> = { act: 'Act', warn: 'Look', info: 'Note' };

export function insightRows(i: MetricsInsights | null): InsightRow[] {
  return (i?.items ?? []).map((it, n) => ({
    key: `${it.kind}-${n}`,
    severity: it.severity,
    word: SEVERITY_WORD[it.severity],
    text: it.text,
    tickets: it.tickets,
  }));
}

export const ticketHref = (id: string) => `/admin/tickets/${id}`;

/** What a drill-down was asked: a stage, a lead (both optional). */
export interface DrillTarget {
  stage: MetricsStage | null;
  group: string | null;
}

export const drillTitle = (t: DrillTarget): string =>
  [t.group ? leadLabel(t.group) : null, t.stage ? STAGE_INFO[t.stage].label : null].filter(Boolean).join(' · ') || 'Tickets';

export interface DrillRow {
  ticket: string;
  href: string;
  /** The stage's duration, "unavailable" when it was left out. */
  duration: string;
  durationMs: number | null;
  meta: string;
}

/** The tickets behind a number, the slowest first (a ticket without the stage last). */
export function drillRows(data: MetricsTickets | null, stage: MetricsStage | null): DrillRow[] {
  const stageOf = stage ?? 'resolve';
  const ms = (r: MetricsTicketRow) => r.stages[stageOf];
  return (data?.rows ?? [])
    .map((r): DrillRow => ({
      ticket: r.ticket,
      href: ticketHref(r.ticket),
      duration: formatSpan(ms(r)),
      durationMs: ms(r),
      meta: `${r.type} · ${r.priority}${r.status === 'wont_do' ? " · won't do" : ''} · ${leadLabel(r.lead)}`,
    }))
    .sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1));
}

// ───────────────────────── the Glance widget ─────────────────────────

export interface HeadlineFigure {
  key: 'efficiency' | 'effectiveness' | 'resolved' | 'median';
  label: string;
  value: string;
  available: boolean;
}

/** The four numbers: both scores, tickets resolved in the window, the median created-to-done. */
export function headlineFigures(o: MetricsOverview | null): HeadlineFigure[] {
  const score = (key: 'efficiency' | 'effectiveness', label: string, s: MetricsScore | undefined): HeadlineFigure =>
    s && s.value !== null
      ? { key, label, value: String(Math.round(s.value)), available: true }
      : { key, label, value: '-', available: false };
  if (!o || o.program.unavailable) {
    return [
      score('efficiency', 'Efficiency', undefined),
      score('effectiveness', 'Effectiveness', undefined),
      { key: 'resolved', label: 'Resolved', value: '-', available: false },
      { key: 'median', label: 'Median', value: '-', available: false },
    ];
  }
  const resolve = o.flow.current.stages.find((s) => s.stage === 'resolve');
  const median = resolve?.medianMs ?? null;
  return [
    score('efficiency', 'Efficiency', o.efficiency),
    score('effectiveness', 'Effectiveness', o.effectiveness),
    { key: 'resolved', label: 'Resolved', value: String(o.flow.current.done), available: true },
    { key: 'median', label: 'Median', value: median === null ? '-' : formatSpan(median), available: median !== null },
  ];
}

// ───────────────────────── the figures under the scores ─────────────────────────

export interface SummaryStat {
  key: string;
  label: string;
  value: string;
  /** "was 12" (the window before), or why the number is not there; null when there is nothing to add. */
  sub: string | null;
}

/** Done, won't do, the median, and the open work now (review, blocked, stalled). `open` null (the store could not be read) is "unavailable". */
export function summaryStats(o: MetricsOverview | null): SummaryStat[] {
  if (!o) return [];
  const cur = o.flow.current;
  const prev = o.flow.previous;
  const median = (w: MetricsFlowGroup['current']) => w.stages.find((s) => s.stage === 'resolve')?.medianMs ?? null;
  const was = (v: string | null) => (v === null || v === UNAVAILABLE ? null : `was ${v}`);
  const open = o.open;
  const count = (n: number | undefined): Pick<SummaryStat, 'value' | 'sub'> =>
    n === undefined ? { value: '-', sub: UNAVAILABLE } : { value: String(n), sub: null };
  return [
    { key: 'done', label: 'Done', value: String(cur.done), sub: was(String(prev.done)) },
    { key: 'wontDo', label: "Won't do", value: String(cur.wontDo), sub: was(String(prev.wontDo)) },
    {
      key: 'median',
      label: 'Median',
      value: median(cur) === null ? '-' : formatSpan(median(cur)),
      sub: median(cur) === null ? UNAVAILABLE : was(median(prev) === null ? null : formatSpan(median(prev))),
    },
    {
      key: 'review',
      label: 'In review',
      ...count(open?.inReview),
      sub: open?.oldestReviewMs != null ? `oldest ${formatSpan(open.oldestReviewMs)}` : open ? null : UNAVAILABLE,
    },
    { key: 'blocked', label: 'Blocked', ...count(open?.blocked) },
    { key: 'stalled', label: 'Stalled', ...count(open?.stalled) },
  ];
}
