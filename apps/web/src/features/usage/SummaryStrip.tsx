import { LoadError, StatGrid, StatTile } from '@isnanme/ui';
import { reasonText, type UsageSummary } from '@portal/contracts';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { useLive } from '@/lib/live';
import { usageApi } from '@/lib/usage';
import { TONE_TEXT } from './claude/format';
import { useNow } from './claude/useClaudeUsage';
import { limitTile, resetTile, speedTile, todayTile, type TileText } from './strip';

/** The summary, kept fresh: loaded on mount and when the Claude changes, again on each `claudeusage` push and every minute while the page shows. */
export function useUsageSummary(claudeId: string) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const asked = useRef(0);
  const load = useCallback(async () => {
    const ask = ++asked.current;
    try {
      const next = await usageApi.summary(claudeId || undefined);
      if (ask !== asked.current) return;
      setSummary(next);
      setFailed(false);
    } catch {
      if (ask === asked.current) setFailed(true);
    }
  }, [claudeId]);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
    return () => window.clearInterval(t);
  }, [load]);
  useLive('claudeusage', () => void load());
  return { summary, failed: failed && !summary, reload: load };
}

/** The tile's value with what goes beside it: "est." and the numbers behind it, or the reason it is "-". */
function Tip({ t }: { t: TileText }): ReactNode {
  if (t.reason) return <InfoTip label="Why not available">{reasonText(t.reason)}</InfoTip>;
  if (!t.estimate && !t.note) return null;
  return (
    <InfoTip text={t.estimate ? 'est.' : undefined} label={t.estimate ? 'How this is estimated' : 'More'}>
      {t.note}
    </InfoTip>
  );
}

/**
 * The strip on top of the Usage page: spend today, speed, time until the limit and the next reset (PRD claude-usage §20.7), for every
 * Claude or for the one picked in the Requests filter. Each figure keeps its basis: an estimate says "est." and a tap shows the numbers
 * behind it, a figure that cannot be known is "-" with the reason. The countdowns tick on this device's clock between loads.
 */
export function SummaryStrip({ claudeId }: { claudeId: string }) {
  const { summary: s, failed, reload } = useUsageSummary(claudeId);
  const now = useNow(15_000);
  if (failed) return <LoadError onRetry={() => void reload()} />;
  const named = !!s && s.scope.claudeId === null;
  const tiles: { label: string; t: TileText | null }[] = [
    { label: 'Today', t: s ? todayTile(s.today) : null },
    { label: 'Speed', t: s ? speedTile(s.speed.trailing, s.speed.today) : null },
    { label: 'Limit', t: s ? limitTile(s.limit, now, named) : null },
    { label: 'Reset', t: s ? resetTile(s.nextReset, now, named) : null },
  ];
  return (
    <StatGrid cols={4} className="mb-4">
      {tiles.map(({ label, t }) => (
        <StatTile
          key={label}
          label={label}
          size="sm"
          value={
            t ? (
              <span className={t.value === '-' ? 'text-muted' : t.tone === 'quiet' ? undefined : TONE_TEXT[t.tone]}>
                {t.value}
                {t.unit && <span className="text-[13px] font-medium text-muted">{t.unit}</span>}
              </span>
            ) : undefined
          }
          hint={t?.hint ? <span dir="auto" title={t.hint}>{t.hint}</span> : undefined}
          extra={t ? <Tip t={t} /> : undefined}
        />
      ))}
    </StatGrid>
  );
}
