import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { useClaudeUsage, useNow } from '@/features/usage/claude/useClaudeUsage';
import { useGlanceSettings } from '../../settings';
import { CardFoot } from '../shared/card';
import { shortAgo } from '../shared/format';
import { GlanceFailed, GlanceLine } from '../shared/states';
import { autoStore } from './autoStore';
import { AUTO_MODE_WORD, autoLine, quotaBoard } from './board';
import { ClaudeBlock } from './Full';

/**
 * Home's Quota: every Claude, the one closest to running out first and open (each window with its meter and reset; a tap opens the pace),
 * the others one line each with what is left; then auto move as it applies to you: its mode, its threshold, the last move it made.
 */
export function QuotaCard() {
  const { report, failed, reload } = useClaudeUsage();
  const { thresholds } = useGlanceSettings();
  const nowMs = useNow(30_000);
  if (!report) return failed ? <GlanceFailed reload={reload} message="Could not load quota." /> : <div className="skeleton h-28 rounded-2xl" aria-busy="true" />;
  const rows = quotaBoard(report.claudes, nowMs, thresholds);
  return (
    <>
      {rows.length === 0 ? (
        <GlanceLine>No Claudes.</GlanceLine>
      ) : (
        <ul aria-label="Claudes, closest to running out first" className="flex flex-col divide-y divide-line">
          {rows.map((r, i) => (
            <li key={r.reading.claude.claudeId} className={i === 0 ? 'pb-1' : 'py-0.5'}>
              <ClaudeBlock claude={r.reading.claude} nowMs={nowMs} thresholds={thresholds} startOpen={i === 0} />
            </li>
          ))}
        </ul>
      )}
      <AutoMove nowMs={nowMs} />
      <CardFoot to="/admin/usage?tab=claudes">Usage</CardFoot>
    </>
  );
}

/** Auto move in one line: off, ask or automatic, at what is left, and the last move the portal made by itself. */
function AutoMove({ nowMs }: { nowMs: number }) {
  const { data, failed, denied } = autoStore.use();
  let body: ReactNode;
  if (!data) body = failed ? <span>{denied ? 'Not allowed' : 'Unavailable'}</span> : <span className="skeleton inline-block h-3 w-24 rounded-full" aria-label="Loading" />;
  else {
    const a = autoLine(data.effective, data.moves);
    body = (
      <>
        <span className="font-semibold text-ink">{AUTO_MODE_WORD[a.mode]}</span>
        {a.thresholdPct !== null && <span className="tabular-nums">at {a.thresholdPct} % left</span>}
        {a.last ? (
          <span className="flex min-w-0 items-center gap-1" title={new Date(a.last.at).toLocaleString()}>
            <span className="shrink-0">· last {shortAgo(a.last.at, nowMs)}</span>
            {a.last.from && a.last.to && (
              <span className="flex min-w-0 items-center gap-0.5 truncate">
                <span className="truncate">{a.last.from}</span>
                <ArrowRight className="size-3 shrink-0" aria-label="to" />
                <span className="truncate">{a.last.to}</span>
              </span>
            )}
          </span>
        ) : (
          a.mode !== 'off' && <span>· no move yet</span>
        )}
      </>
    );
  }
  return (
    <div className="mt-2 flex min-h-11 min-w-0 flex-wrap items-center gap-x-1.5 border-t border-line pt-2 text-xs text-muted">
      <span className="flex items-center">
        Auto move
        <InfoTip label="About auto move">
          Moves a chat to another Claude when the one it runs on has this much or less left of the limit that stops it. Ask suggests the move; Automatic makes it. The last move is the latest one the portal made by itself.
        </InfoTip>
      </span>
      {body}
    </div>
  );
}
