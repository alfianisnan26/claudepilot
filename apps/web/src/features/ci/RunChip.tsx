import { cn } from '@isnanme/ui';
import { type CiRunSummary } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useLive } from '@/lib/live';
import { ciApi } from './api';
import { StatusIcon } from './parts';

/**
 * What CI says about a session or a ticket (local-git-ci PRD §15): the latest run of each pipeline as a small link to it, an
 * icon and its number. `compact` (the session page's header line) shows only the latest of all. Nothing when there is no run.
 */
export function RunChip({ sessionId, ticketId, compact, lead, className }: { sessionId?: string; ticketId?: string; compact?: boolean; /** Text shown before the chips, only when there are some (a separator in an inline line). */ lead?: string; className?: string }) {
  const [runs, setRuns] = useState<CiRunSummary[] | null>(null);
  const load = useCallback(() => {
    ciApi.runs({ session: sessionId, ticket: ticketId, limit: 20 }).then(
      (list) => setRuns(list.items),
      () => undefined,
    );
  }, [sessionId, ticketId]);
  useEffect(() => load(), [load]);
  useLive('ci', load);
  if (!runs?.length) return null;
  // Newest first: keep the first run seen of each pipeline.
  const latest = runs.filter((r, i) => runs.findIndex((x) => x.pipeline === r.pipeline) === i);
  const shown = compact ? latest.slice(0, 1) : latest;
  return (
    <>
      {lead}
      <span className={cn('inline-flex flex-wrap items-center gap-1.5 align-bottom', className)}>
      {shown.map((r) => (
        <Link
          key={r.id}
          to={`/admin/ci/runs/${r.id}`}
          title={`${r.pipeline} #${r.number}: ${r.status}${r.branch ? ` on ${r.branch}` : ''}`}
          className={cn(
            'inline-flex items-center gap-1 rounded-full font-semibold text-ink-soft hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
            compact ? 'text-[12px]' : 'border border-line bg-surface px-2.5 py-1 text-[12.5px]',
          )}
        >
          <StatusIcon status={r.status} className="[&_svg]:size-3.5" />
          <span className="tabular-nums">#{r.number}</span>
        </Link>
      ))}
      </span>
    </>
  );
}
