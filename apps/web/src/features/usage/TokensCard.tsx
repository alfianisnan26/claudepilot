import type { CacheSplit, ChatUsageTotals } from '@portal/contracts';
import { Card } from '@/components/Card';
import { BarList } from '@/components/charts';
import { InfoTip } from '@/components/InfoTip';
import { formatShare, formatTokens } from '@/lib/usage';

/** "Cache hit rate", the formula in one line. */
export const HIT_RATE_FORMULA = 'Cache reads ÷ (cache reads + uncached input + cache writes): the share of input tokens the prompt cache served.';

/**
 * Tokens by kind, the cache apart (docs/prd/claude-usage.md §20.3): input that was not cached, what was written to the cache, what was read
 * from it, and the output, with the hit rate beside the title. All stored counts, so measured.
 */
export function TokensCard({ totals, cache }: { totals: ChatUsageTotals | undefined; cache: CacheSplit | undefined }) {
  const rows = totals && cache
    ? [
        { key: 'read', label: 'Cache read', value: cache.read },
        { key: 'write', label: 'Cache write', value: cache.written },
        { key: 'in', label: 'Input', sub: 'uncached', value: cache.uncached },
        { key: 'out', label: 'Output', value: totals.output },
      ].sort((a, b) => b.value - a.value)
    : [];
  return (
    <Card className="min-w-0 p-4 sm:p-5 lg:col-span-2">
      <h2 className="mb-2 flex items-center gap-1 text-[15px] font-semibold">
        Tokens
        <span className="font-normal text-muted">
          · {cache && cache.hitRate.basis !== 'unavailable' ? `${formatShare(cache.hitRate.value)} from cache` : 'no cache use'}
        </span>
        <InfoTip label="About the cache">{HIT_RATE_FORMULA}</InfoTip>
      </h2>
      {!totals ? <div className="skeleton h-32 rounded-2xl" aria-hidden="true" /> : <BarList rows={rows} format={(v) => formatTokens(Math.round(v))} empty="Nothing yet in this window." />}
    </Card>
  );
}
