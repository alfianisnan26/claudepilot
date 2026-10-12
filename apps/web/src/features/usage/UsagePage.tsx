import { LoadError, Segmented, Select, StatGrid, StatTile } from '@isnanme/ui';
import type { ChatUsageRange, RequestsReport } from '@portal/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { BarList } from '@/components/charts';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { useLive } from '@/lib/live';
import { formatCost, formatShare, formatTokens, prettyModel, slotColor, usageApi } from '@/lib/usage';
import { UsageTabs } from './claude/UsageTabs';
import { RANGE_OPTIONS, RANGE_WORDS, saveRange, savedRange } from './range';
import { DOLLARS_FORMULA, figureTip } from './figure';
import { ExportMenu } from './ExportMenu';
import { FORMAT, spentTokens, tileChange, type Metric, type StackBy } from './requests';
import { SpendChart } from './SpendChart';
import { SummaryStrip } from './SummaryStrip';
import { HIT_RATE_FORMULA, TokensCard } from './TokensCard';

/** What the previous period is called in a tile's note: the stretch of the same length before the window. */
const PERIOD_WORDS: Record<ChatUsageRange, string> = { '30m': '30 minutes', '1h': 'hour', '12h': '12 hours', '1d': '24 hours', '7d': '7 days', '30d': '30 days' };
/** Short windows change by the minute: refresh them while the page is open. */
const LIVE: ReadonlySet<ChatUsageRange> = new Set(['30m', '1h', '12h']);

/**
 * Usage over time, from every finished request (turn) stored as metrics: sub-agents count with the request that started them. One row of
 * filters scopes everything: the window (30 minutes to a month), the Claude whose sign-in or pool the requests ran as, and what the stack is
 * cut by. Then the totals against the previous period, one stacked chart over time (cost, tokens or requests), and the split by Claude, by
 * model and by token kind with the cache apart.
 */
function RequestsTab({ claude, onClaude }: { claude: string; onClaude: (id: string) => void }) {
  const [range, setRange] = useState<ChatUsageRange>(savedRange);
  const [metric, setMetric] = useState<Metric>('cost');
  const [stack, setStack] = useState<StackBy>('claude');
  const [report, setReport] = useState<RequestsReport | null>(null);
  const [claudes, setClaudes] = useState<RequestsReport['byClaude']>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const asked = useRef(0);

  const load = useCallback(async () => {
    const ask = ++asked.current;
    setLoading(true);
    try {
      const next = await usageApi.requests(range, claude || undefined);
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
  // A reading or an alert landed: the plan windows moved, and the requests may have too.
  useLive('claudeusage', () => void load());

  const pickRange = (r: ChatUsageRange) => {
    setRange(r);
    saveRange(r);
  };

  const claudeKey = (c: { workspaceId: string; claudeId: string }) => c.claudeId || `default:${c.workspaceId}`;
  const t = report?.totals;
  const prev = report?.previous;
  const words = PERIOD_WORDS[range];
  const cost = report && prev ? tileChange(prev.change.costUsd, prev.totals.costUsd, formatCost, words) : null;
  const requests = report && prev ? tileChange(prev.change.requests, prev.totals.requests, String, words) : null;
  const tokens = report && prev ? tileChange(prev.change.tokens, spentTokens(prev.totals), FORMAT.tokens, words) : null;
  const hit = report?.cache.hitRate;
  const fmt = FORMAT[metric];
  const value = (x: { costUsd: number; input: number; output: number; cacheWrite: number; requests: number }) => (metric === 'cost' ? x.costUsd : metric === 'tokens' ? spentTokens(x) : x.requests);

  return (
    <>
      <PageHeader
        title="Usage"
        description={`Every finished request, ${RANGE_WORDS[range]}. Sub-agents count with the request that started them. Tokens are input + output + cache writes; cache reads are counted apart. Dollars are Claude Code’s estimate at API list prices, not a bill.`}
        action={
          <ExportMenu
            items={[
              { label: 'Requests · CSV', url: usageApi.exportUrl({ what: 'requests', format: 'csv', range, claudeId: claude || undefined }) },
              { label: 'Requests · JSON', url: usageApi.exportUrl({ what: 'requests', format: 'json', range, claudeId: claude || undefined }) },
            ]}
          />
        }
      />

      {/* One row of filters, above everything they scope. */}
      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="sm:w-[360px]">
          <Segmented label="Window" value={range} options={RANGE_OPTIONS} onChange={pickRange} />
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:flex sm:gap-2.5">
          <div className="sm:w-52">
            <Select
              label="Claude"
              hideLabel
              value={claude}
              onChange={onClaude}
              options={[
                { value: '', label: 'All Claudes' },
                ...claudes.filter((c) => c.claudeId).map((c) => ({ value: c.claudeId, label: `${c.name} · ${c.workspaceId.split('/').pop()}` })),
              ]}
            />
          </div>
          <div className="sm:w-48">
            <Segmented
              label="Stack by"
              value={stack}
              options={[
                { value: 'claude', label: 'Claude' },
                { value: 'model', label: 'Model' },
              ]}
              onChange={setStack}
            />
          </div>
        </div>
      </div>

      {failed && !report && <LoadError onRetry={load} />}

      <div className={loading && report ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        <StatGrid cols={4}>
          <StatTile
            label="Cost"
            size="sm"
            value={t ? formatCost(t.costUsd) : undefined}
            extra={t ? figureTip({ value: t.costUsd, basis: 'estimate' }, `${DOLLARS_FORMULA} ${cost?.note ?? ''}`) : undefined}
            hint={cost ? <span title={cost.note}>{cost.hint}</span> : undefined}
          />
          <StatTile label="Requests" size="sm" value={t ? String(t.requests) : undefined} hint={requests ? <span title={requests.note}>{requests.hint}</span> : undefined} />
          <StatTile
            label="Tokens"
            size="sm"
            value={t ? formatTokens(spentTokens(t)) : undefined}
            extra={
              t ? (
                <InfoTip label="About tokens">
                  Input + output + cache writes. Cache reads are read, not spent, and are counted apart. {tokens?.note}
                </InfoTip>
              ) : undefined
            }
            hint={tokens ? <span title={tokens.note}>{tokens.hint}</span> : undefined}
          />
          <StatTile
            label="Cache"
            size="sm"
            value={hit ? (hit.basis === 'unavailable' ? '-' : formatShare(hit.value)) : undefined}
            extra={hit ? hit.basis === 'unavailable' ? figureTip(hit) : <InfoTip label="About the cache">{HIT_RATE_FORMULA}</InfoTip> : undefined}
            hint={report ? `${formatTokens(report.cache.read)} read` : undefined}
          />
        </StatGrid>

        <SpendChart report={report} range={range} metric={metric} onMetric={setMetric} stack={stack} loading={loading} />

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card className="min-w-0 p-4 sm:p-5">
            <h2 className="mb-2 text-[15px] font-semibold">
              By Claude <span className="font-normal text-muted">· {metric}</span>
            </h2>
            {!report ? (
              <div className="skeleton h-40 rounded-2xl" aria-hidden="true" />
            ) : (
              <BarList
                rows={report.byClaude.map((c) => ({
                  key: claudeKey(c),
                  label: c.name,
                  sub: c.workspaceId.split('/').pop(),
                  value: value(c),
                  color: slotColor(c.slot),
                  title: c.cache.hitRate.basis === 'unavailable' ? undefined : `${formatShare(c.cache.hitRate.value)} of its input from cache`,
                }))}
                format={fmt}
                picked={claude ? claudeKey({ workspaceId: '', claudeId: claude }) : null}
                onPick={(key) => onClaude(key.startsWith('default:') ? '' : claude === key ? '' : key)}
                empty="Nothing yet in this window."
              />
            )}
          </Card>
          <Card className="min-w-0 p-4 sm:p-5">
            <h2 className="mb-2 text-[15px] font-semibold">
              By model <span className="font-normal text-muted">· {metric}</span>
            </h2>
            {!report ? (
              <div className="skeleton h-40 rounded-2xl" aria-hidden="true" />
            ) : (
              <BarList
                rows={report.byModel.map((m) => ({
                  key: m.model,
                  label: prettyModel(m.model),
                  value: value(m),
                  color: slotColor(m.slot),
                  title: m.cache.hitRate.basis === 'unavailable' ? undefined : `${formatShare(m.cache.hitRate.value)} of its input from cache`,
                }))}
                format={fmt}
                empty="Nothing yet in this window."
              />
            )}
          </Card>
          <TokensCard totals={t} cache={report?.cache} />
        </div>
      </div>
    </>
  );
}

/** Usage: what requests cost, and (Claude usage PRD) what each Claude's plan has left. The summary strip sits above the tabs. */
export function UsagePage() {
  const [params] = useSearchParams();
  const [claude, setClaude] = useState('');
  const tab = params.get('tab');
  // The Claude picked in the Requests filter scopes the strip while that tab shows; elsewhere the strip is every Claude.
  const scoped = useMemo(() => (!tab || tab === 'requests' ? claude : ''), [tab, claude]);
  return <UsageTabs top={<SummaryStrip claudeId={scoped} />} requests={<RequestsTab claude={claude} onClaude={setClaude} />} />;
}
