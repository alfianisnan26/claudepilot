import { Segmented } from '@isnanme/ui';
import type { ChatUsageRange, RequestsReport } from '@portal/contracts';
import { useId, useMemo, useState } from 'react';
import { Card } from '@/components/Card';
import { ColumnChart } from '@/components/charts';
import { InfoTip } from '@/components/InfoTip';
import { patternFill, PatternDefs, slotColor, stackItems, usePatterns } from '@/lib/usage';
import { DOLLARS_FORMULA } from './figure';
import { StackLegend, type PreviousState } from './StackLegend';
import { bucketWords, chartColumns, FORMAT, MEASURE, spentTokens, type Metric, type StackBy } from './requests';

const TITLE: Record<Metric, string> = { cost: 'Cost', tokens: 'Tokens', requests: 'Requests' };
const WHAT: Record<Metric, string> = {
  cost: DOLLARS_FORMULA,
  tokens: 'Input + output + cache writes. Cache reads are read, not spent, and are counted apart (Cache).',
  requests: 'Finished requests. Sub-agents run inside a request and count with it.',
};
const RANGE_WORDS: Record<ChatUsageRange, string> = { '30m': 'last 30 minutes', '1h': 'last hour', '12h': 'last 12 hours', '1d': 'last day', '7d': 'last 7 days', '30d': 'last 30 days' };

/**
 * Usage over time as a stack: one band per Claude or per model in its own fixed colour (top 6 by the measure, the rest folded into "Others"),
 * the previous period as a dashed line, a legend that switches bands off one by one, and the same numbers as a table. The tooltip of a column
 * names every band and what is inside "Others". (docs/prd/claude-usage.md §20.6, §20.8)
 */
export function SpendChart({
  report,
  range,
  metric,
  onMetric,
  stack,
  loading,
}: {
  report: RequestsReport | null;
  range: ChatUsageRange;
  metric: Metric;
  onMetric: (m: Metric) => void;
  stack: StackBy;
  loading: boolean;
}) {
  const pid = `uu-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [patterns] = usePatterns();
  const [hiddenBy, setHiddenBy] = useState<Record<StackBy, ReadonlySet<string>>>({ claude: new Set(), model: new Set() });
  const [previous, setPrevious] = useState(true);
  const hidden = hiddenBy[stack];
  const items = useMemo(() => (report ? stackItems(stack === 'claude' ? report.claudes : report.models, MEASURE[metric]) : []), [report, stack, metric]);
  const toggle = (key: string) =>
    setHiddenBy((cur) => {
      const next = new Set(cur[stack]);
      if (!next.delete(key)) next.add(key);
      return { ...cur, [stack]: next };
    });
  const noEarlier = report?.previous.coverage === 'none';
  const state: PreviousState = {
    on: previous,
    unavailable: noEarlier ? 'Nothing was recorded before this window, so there is nothing to compare with.' : hidden.size ? `It covers every ${stack}, so it is off while one is switched off.` : null,
  };
  const columns = useMemo(
    () =>
      report
        ? chartColumns({
            report,
            items,
            kind: stack,
            metric,
            hidden,
            previous: previous && !hidden.size,
            fillOf: (slot) => ({ fill: slotColor(slot), overlay: patterns ? patternFill(pid, slot) : null }),
          })
        : [],
    [report, items, stack, metric, hidden, previous, patterns, pid],
  );
  const format = FORMAT[metric];

  return (
    <Card className="mt-4 p-4 sm:p-5">
      <div className="mb-3 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="flex items-center gap-1 text-[15px] font-semibold">
          {TITLE[metric]}
          <InfoTip label={`About ${TITLE[metric].toLowerCase()}`}>{WHAT[metric]}</InfoTip>
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
            onChange={onMetric}
          />
        </div>
      </div>
      {report ? (
        <>
          <ColumnChart columns={columns} format={format} ariaLabel={`${TITLE[metric]} over the ${RANGE_WORDS[range]}, by ${stack}`} empty="No requests in this window" dim={loading} defs={<PatternDefs prefix={pid} />} />
          {items.length > 0 && <StackLegend items={items} kind={stack} hidden={hidden} onToggle={toggle} previous={state} onPrevious={() => setPrevious((p) => !p)} />}
          <details className="mt-3 text-[13px]">
            <summary className="cursor-pointer text-muted">Show as a table</summary>
            <div className="mt-2 max-h-72 overflow-auto rounded-xl border border-line">
              <table className="w-full text-left tabular-nums">
                <thead className="sticky top-0 bg-surface text-muted">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Time</th>
                    <th className="px-3 py-1.5 text-right font-medium">Requests</th>
                    <th className="px-3 py-1.5 text-right font-medium">Tokens</th>
                    <th className="px-3 py-1.5 text-right font-medium">Cache</th>
                    <th className="px-3 py-1.5 text-right font-medium">
                      <span className="inline-flex items-center">
                        Cost
                        <InfoTip text="est." label="How cost is estimated">
                          {DOLLARS_FORMULA}
                        </InfoTip>
                      </span>
                    </th>
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
                        <td className="px-3 py-1.5 text-right">{FORMAT.tokens(spentTokens(b))}</td>
                        <td className="px-3 py-1.5 text-right">{FORMAT.tokens(b.cacheRead)}</td>
                        <td className="px-3 py-1.5 text-right">{FORMAT.cost(b.costUsd)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <div className="skeleton h-[188px] rounded-2xl" />
      )}
    </Card>
  );
}
