import { Badge, Button, Dialog, RowsSkeleton, useToast } from '@isnanme/ui';
import type { MultiPoolType, PoolDetail, PoolSummary } from '@portal/contracts';
import { CirclePause, CirclePlay } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { STATUS_LABEL } from './labels';

/**
 * A pool's revisions, newest first (Skillset PRD §18 A3): approve one waiting for review, make a
 * deliverable one current (a roll back, or a revision held back for a trial), and pause or resume the
 * current revision's rollout (FR23).
 */
export function RevisionsDialog({ type, pool, onClose }: { type: MultiPoolType; pool: PoolSummary | null; onClose: () => void }) {
  const toast = useToast();
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!pool) return;
    try {
      setDetail(await api.pools.get(type, pool.id));
      setError(null);
    } catch (e) {
      setError(errorText(e, 'Could not load the revisions.'));
    }
  }, [type, pool]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    void load();
  }, [load]);
  useLive('pools', () => void load(), !!pool);

  const act = async (run: () => Promise<PoolSummary>, done: string) => {
    try {
      await run();
      toast(done);
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not change it.'), 'error');
    }
  };

  const current = detail?.revisions.find((r) => r.current);
  return (
    <Dialog open={!!pool} onClose={onClose} title="Revisions" description={pool ? `${pool.name}: every saved change, newest first.` : undefined}>
      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {!detail && !error && <RowsSkeleton rows={3} lines={1} trailing />}
      {detail && pool && (
        <div className="flex flex-col gap-4">
          {current && (
            <div className="flex flex-col gap-2 rounded-2xl bg-surface-2 px-4 py-3 text-[13px] sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1 text-ink-soft">
                {current.rolloutPaused ? (
                  <>
                    <span className="font-semibold text-ink">r{current.revision} paused.</span> {current.rolloutPaused.reason} Workspaces it hasn’t
                    reached keep the revision before it.
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-ink">r{current.revision} is current.</span> Workspaces follow it unless pinned.
                  </>
                )}
              </p>
              {current.rolloutPaused ? (
                <Button size="sm" variant="secondary" icon={<CirclePlay className="size-4" />} onClick={() => act(() => api.pools.rollout(type, pool.id, false), 'Rollout resumed')}>
                  Resume
                </Button>
              ) : (
                <Button size="sm" variant="ghost" icon={<CirclePause className="size-4" />} onClick={() => act(() => api.pools.rollout(type, pool.id, true), 'Rollout paused')}>
                  Pause rollout
                </Button>
              )}
            </div>
          )}
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {detail.revisions.map((r) => (
              <li key={r.revision} className="flex items-start gap-3 px-4 py-3">
                <span className="w-9 shrink-0 pt-0.5 font-mono text-[12.5px] font-semibold text-ink-soft">r{r.revision}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {r.current ? <Badge tone="success">Current</Badge> : <Badge tone={r.status === 'waiting_review' ? 'warning' : 'neutral'}>{STATUS_LABEL[r.status]}</Badge>}
                    {r.rolloutPaused && <Badge tone="danger">Paused</Badge>}
                    <span className="text-[12px] text-muted" title={formatDateTime(r.createdAt)}>
                      {timeAgo(r.createdAt)}
                    </span>
                  </div>
                  {r.note && <p className="mt-1 text-[13px] text-ink-soft">{r.note}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  {r.status !== 'deliverable' && (
                    <Button size="sm" variant="secondary" onClick={() => act(() => api.pools.approve(type, pool.id, r.revision), `r${r.revision} approved`)}>
                      Approve
                    </Button>
                  )}
                  {r.status === 'deliverable' && !r.current && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => act(() => api.pools.makeCurrent(type, pool.id, r.revision), current && r.revision < current.revision ? `Rolled back to r${r.revision}` : `r${r.revision} is current`)}
                    >
                      {current && r.revision < current.revision ? 'Roll back' : 'Make current'}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {detail.assignedTo.some((a) => a.pinnedRevision !== null) && (
            <p className="text-[12px] text-muted">
              Pinned: {detail.assignedTo.filter((a) => a.pinnedRevision !== null).map((a) => `${a.workspaceId.split('/').pop()} at r${a.pinnedRevision}`).join(', ')}.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
