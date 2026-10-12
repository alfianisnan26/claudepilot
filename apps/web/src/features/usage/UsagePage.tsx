import { LoadError, Segmented, Select, StatGrid, StatTile } from '@isnanme/ui';
import { CHAT_USAGE_RANGES, type ChatUsageRange, type ChatUsageReport, type ChatUsageTotals } from '@portal/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/Card';
import { BarList, ColumnChart, type ChartColumn } from '@/components/charts';
import { PageHeader } from '@/components/PageHeader';
import { chatApi } from '@/features/chat/api';
import { formatTokens } from '@/features/chat/shared';
import { UsageTabs } from './claude/UsageTabs';

type Metric = 'cost' | 'tokens' | 'requests';

const RANGE_LABEL: Record<ChatUsageRange, string> = { '30m': '30m', '1h': '1h', '12h': '12h', '1d': '1d', '7d': '7d', '30d': '1M' };
const RANGE_WORDS: Record<ChatUsageRange, string> = {
  '30m': 'last 30 minutes',
  '1h': 'last hour',
  '12h': 'last 12 hours',
  '1d': 'last day',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
};
const RANGE_KEY = 'pilot.usage.range';
/** Short windows change by the minute: refresh them while the page is open. */
const LIVE: ReadonlySet<ChatUsageRange> = new Set(['30m', '1h', '12h']);

const tokensOf = (t: ChatUsageTotals) => t.input + t.cacheRead + t.cacheWrite + t.output;
const VALUE: Record<Metric, (t: ChatUsageTotals) => number> = { cost: (t) => t.costUsd, tokens: tokensOf, requests: (t) => t.requests };

/** "$0.084", "$1.23", "$12.3", "$1.2k": short enough for an axis. */
function formatCost(v: number): string {
  if (v === 0) return '$0';
  if (v < 1) return `$${v.toFixed(v < 0.1 ? 3 : 2)}`;
  if (v < 100) return `$${v.toFixed(2).replace(/\.?0+$/, '')}`;
  if (v < 1000) return `$${Math.round(v)}`;
  return `$${(v / 1000).toFixed(1)}k`;
}
const FORMAT: Record<Metric, (v: number) => string> = {
  cost: formatCost,
  tokens: (v) => formatTokens(Math.round(v)),
  requests: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
};

/** A bucket's place on the axis, and what it covers, in this device's time. */
function bucketWords(at: string, bucketMs: number, range: ChatUsageRange): { tick: string; span: string } {
  const start = new Date(at);
  const end = new Date(start.getTime() + bucketMs);
  const time = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (d: Date) => d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  const weekday = (d: Date) => d.toLocaleDateString([], { weekday: 'short' });
  if (range === '30d') return { tick: day(start), span: day(start) };
  if (range === '7d') return { tick: `${weekday(start)} ${time(start).slice(0, 2)}h`, span: `${weekday(start)} ${day(start)}, ${time(start)}–${time(end)}` };
  return { tick: time(start), span: `${time(start)}–${time(end)}` };
}

function savedRange(): ChatUsageRange {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    return (CHAT_USAGE_RANGES as readonly string[]).includes(v ?? '') ? (v as ChatUsageRange) : '1d';
  } catch {
    return '1d';
  }
}

/**
 * Usage over time, from every finished request (turn) stored as metrics: sub-agents count with the
 * request that started them. One row of filters scopes everything: the window (30 minutes to a month)
 * and the Claude, whose sign-in or pool the requests ran as. Then the totals, one chart over time
 * (cost, tokens or requests), and the split by Claude and by model.
 */
function RequestsTab() {
  const [range, setRange] = useState<ChatUsageRange>(savedRange);
  const [metric, setMetric] = useState<Metric>('cost');
  const [claude, setClaude] = useState('');
  const [report, setReport] = useState<ChatUsageReport | null>(null);
  const [claudes, setClaudes] = useState<ChatUsageReport['byClaude']>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const asked = useRef(0);

  const load = useCallback(async () => {
    const ask = ++asked.current;
    setLoading(true);
    try {
      const next = await chatApi.usage(range, claude || undefined);
      if (ask !== asked.current) return;
      setReport(next);
      setFailed(false);
      // The Claude filter lists everyone seen in the window, even while it shows one.
      if (!claude) setClaudes(next.byClaude);
    } catch {
      if (ask === asked.current) setFailed(true);
    } finally {
      if (ask === asked.current) setLoading(false);
    }
  }, [range, claude]);

  useEffect(() => {
    void load();
    if (!LIVE.has(range)) return;
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load, range]);

  const pickRange = (r: ChatUsageRange) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      // not remembered on this device
    }
  };

  const claudeKey = (c: { workspaceId: string; claudeId: string }) => c.claudeId || `default:${c.workspaceId}`;
  const value = VALUE[metric];
  const format = FORMAT[metric];

  const columns: ChartColumn[] = useMemo(
    () =>
      (report?.buckets ?? []).map((b) => ({
        key: b.at,
        value: value(b),
        ...bucketWords(b.at, report!.bucketMs, report!.range),
        detail:
          metric === 'tokens'
            ? `${formatTokens(b.input + b.cacheRead + b.cacheWrite)} in · ${formatTokens(b.output)} out`
            : b.requests
              ? `${b.requests} ${b.requests === 1 ? 'request' : 'requests'}${b.agents ? ` · ${b.agents} sub-agents` : ''}`
              : undefined,
      })),
    [report, metric, value],
  );

  const t = report?.totals;
  const inTokens = t ? t.input + t.cacheRead + t.cacheWrite : 0;

  return (
    <>
      <PageHeader title="Usage" description={`Every request, ${RANGE_WORDS[range]}.`} />

      {/* One row of filters, above everything they scope. */}
      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="sm:w-[360px]">
          <Segmented label="Window" value={range} options={CHAT_USAGE_RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))} onChange={pickRange} />
        </div>
        <div className="sm:w-56">
          <Select
            label="Claude"
            hideLabel
            value={claude}
            onChange={setClaude}
            options={[
              { value: '', label: 'All Claudes' },
              ...claudes.filter((c) => c.claudeId).map((c) => ({ value: c.claudeId, label: `${c.name} · ${c.workspaceId.split('/').pop()}` })),
            ]}
          />
        </div>
      </div>

      {failed && !report && <LoadError onRetry={load} />}

      <div className={loading && report ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        <StatGrid cols={4}>
          <StatTile label="Cost" value={t ? formatCost(t.costUsd) : undefined} hint="estimated" size="sm" />
          <StatTile label="Requests" value={t ? String(t.requests) : undefined} hint={t ? `${t.agents} sub-agents` : undefined} size="sm" />
          <StatTile
            label="Tokens in"
            value={t ? formatTokens(inTokens) : undefined}
            hint={t && inTokens ? `${Math.round((t.cacheRead / inTokens) * 100)}% from cache` : undefined}
            size="sm"
          />
          <StatTile label="Tokens out" value={t ? formatTokens(t.output) : undefined} size="sm" />
        </StatGrid>

        <Card className="mt-4 p-4 sm:p-5">
          <div className="mb-3 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-[15px] font-semibold">
              {metric === 'cost' ? 'Cost' : metric === 'tokens' ? 'Tokens' : 'Requests'}
              <span className="ml-1.5 font-normal text-muted">over time</span>
            </h2>
            <div className="w-full shrink-0 sm:w-[240px]">
              <Segmented
                label="Measure"
                value={metric}
                options={[
                  { value: 'cost', label: 'Cost' },
                  { value: 'tokens', label: 'Tokens' },
                  { value: 'requests', label: 'Requests' },
                ]}
                onChange={setMetric}
              />
            </div>
          </div>
          {report ? (
            <ColumnChart columns={columns} format={format} ariaLabel={`${metric} over the ${RANGE_WORDS[range]}`} empty="No requests in this window" dim={loading} />
          ) : (
            <div className="skeleton h-[188px] rounded-2xl" />
          )}
          {report && (
            <details className="mt-3 text-[13px]">
              <summary className="cursor-pointer text-muted">Show as a table</summary>
              <div className="mt-2 max-h-72 overflow-auto rounded-xl border border-line">
                <table className="w-full text-left tabular-nums">
                  <thead className="sticky top-0 bg-surface text-muted">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">Time</th>
                      <th className="px-3 py-1.5 text-right font-medium">Requests</th>
                      <th className="px-3 py-1.5 text-right font-medium">Tokens in</th>
                      <th className="px-3 py-1.5 text-right font-medium">Out</th>
                      <th className="px-3 py-1.5 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.buckets
                      .filter((b) => b.requests || b.costUsd)
                      .reverse()
                      .map((b) => (
                        <tr key={b.at} className="border-t border-line">
                          <td className="px-3 py-1.5">{bucketWords(b.at, report.bucketMs, report.range).span}</td>
                          <td className="px-3 py-1.5 text-right">{b.requests}</td>
                          <td className="px-3 py-1.5 text-right">{formatTokens(b.input + b.cacheRead + b.cacheWrite)}</td>
                          <td className="px-3 py-1.5 text-right">{formatTokens(b.output)}</td>
                          <td className="px-3 py-1.5 text-right">{formatCost(b.costUsd)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </Card>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card className="p-4 sm:p-5">
            <h2 className="mb-2 text-[15px] font-semibold">
              By Claude <span className="font-normal text-muted">· {metric}</span>
            </h2>
            <BarList
              rows={(report?.byClaude ?? []).map((c) => ({ key: claudeKey(c), label: c.name, sub: c.workspaceId.split('/').pop(), value: value(c) }))}
              format={format}
              picked={claude ? claudeKey({ workspaceId: '', claudeId: claude }) : null}
              onPick={(key) => setClaude((cur) => (key.startsWith('default:') ? '' : cur === key ? '' : key))}
              empty="Nothing yet in this window."
            />
          </Card>
          <Card className="p-4 sm:p-5">
            <h2 className="mb-2 text-[15px] font-semibold">
              By model <span className="font-normal text-muted">· {metric}</span>
            </h2>
            <BarList rows={(report?.byModel ?? []).map((m) => ({ key: m.model, label: prettyModel(m.model), value: value(m) }))} format={format} empty="Nothing yet in this window." />
          </Card>
        </div>
      </div>
    </>
  );
}

/** Usage: what requests cost, and (Claude usage PRD) what each Claude's plan has left. */
export function UsagePage() {
  return <UsageTabs requests={<RequestsTab />} />;
}

/** "claude-opus-5-5" reads "Opus 5.5". */
function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m) return id;
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}
