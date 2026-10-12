import { LoadError, Menu, RowsSkeleton, Segmented, useToast } from '@isnanme/ui';
import type { SpikeEvent } from '@portal/contracts';
import { BellOff } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { errorText } from '@/lib/api';
import { agoText, localTime } from '../claude/format';
import { useNow } from '../claude/useClaudeUsage';
import { usageSpendApi } from './api';
import { NotAvailable } from './shared';
import { evidenceText, KIND_WORD, sensitivityText } from './spikes';
import { useLoad } from './useLoad';

type Range = '1d' | '7d' | '30d';
const RANGES: { value: Range; label: string }[] = [
  { value: '1d', label: '1d' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '1M' },
];

/** One event: what the rule noticed, in a line, and under it the kind, the session it names, the Claude and when. The evidence is in the ⓘ. */
function Event({ e, nowMs, onChanged }: { e: SpikeEvent; nowMs: number; onChanged: () => void }) {
  const toast = useToast();
  const run = async (what: () => Promise<unknown>) => {
    try {
      await what();
      onChanged();
    } catch (err) {
      toast(errorText(err, 'Couldn’t change the snooze.'), 'error');
    }
  };
  return (
    <li className="flex items-start gap-1 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-[14px] font-semibold">
          <span dir="auto" className="min-w-0 truncate" title={e.summary}>
            {e.summary}
          </span>
          <InfoTip label="Evidence">{evidenceText(e.evidence)}</InfoTip>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
          <span>{KIND_WORD[e.kind]}</span>
          {e.sessionTitle && e.sessionId && (
            <Link to={`/admin/sessions/${encodeURIComponent(e.sessionId)}`} dir="auto" className="press min-w-0 max-w-full truncate hover:text-ink tap:-my-3.5 tap:py-3.5" title={e.sessionTitle}>
              {e.sessionTitle}
            </Link>
          )}
          <span dir="auto" className="min-w-0 max-w-full truncate" title={e.claudeName}>
            {e.claudeName}
          </span>
          <span title={localTime(e.at, nowMs)}>{agoText(e.at, nowMs)}</span>
          {e.snoozedUntil && <span>snoozed until {localTime(e.snoozedUntil, nowMs)}</span>}
        </p>
      </div>
      <Menu
        label={`Snooze ${e.kind === 'rate' ? e.claudeName : (e.sessionTitle ?? 'this session')}`}
        align="right"
        trigger={<BellOff className={e.snoozedUntil ? 'size-4 text-gold' : 'size-4'} aria-hidden="true" />}
        items={[
          { label: 'Snooze 1 hour', onSelect: () => void run(() => usageSpendApi.snoozeSpike(e.subject, '1h')) },
          { label: 'Snooze 4 hours', onSelect: () => void run(() => usageSpendApi.snoozeSpike(e.subject, '4h')) },
          { label: 'Until tomorrow', onSelect: () => void run(() => usageSpendApi.snoozeSpike(e.subject, 'day')) },
          ...(e.snoozedUntil ? [{ label: 'Alert me again', onSelect: () => void run(() => usageSpendApi.unsnoozeSpike(e.subject)) }] : []),
        ]}
      />
    </li>
  );
}

/**
 * Usage → Spikes: what the heuristics noticed (docs/prd/claude-usage.md §24): spend far above a Claude's usual, a session finishing many
 * requests in minutes, one request far above the median. Rules of thumb, labelled so, that alert and never act; each names its evidence.
 */
export function SpikesTab() {
  const [range, setRange] = useState<Range>('7d');
  const { data, failed, forbidden, loading, reload } = useLoad(() => usageSpendApi.spikes(range), range);
  const now = useNow(30_000);
  return (
    <>
      <PageHeader title="Spikes" description="Unusual spend, found by rules of thumb. They alert and never stop anything; each names its evidence." />
      <div className="mb-4 sm:w-[240px]">
        <Segmented label="Window" value={range} options={RANGES} onChange={setRange} />
      </div>
      {forbidden ? (
        <NotAvailable />
      ) : failed ? (
        <LoadError onRetry={reload} />
      ) : !data ? (
        <RowsSkeleton rows={3} lines={1} label="Loading spikes" />
      ) : data.events.length === 0 ? (
        <p className="py-3 text-[13px] text-muted">No spikes in this window.</p>
      ) : (
        <Card className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
          <div className="flex items-center border-b border-line px-4 py-2 text-[12.5px] text-muted sm:px-5">
            heuristic
            <InfoTip label="About spikes">{sensitivityText(data.settings)}</InfoTip>
          </div>
          <ul className="divide-y divide-line">
            {data.events.map((e) => (
              <Event key={e.id} e={e} nowMs={now} onChanged={() => void reload()} />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
