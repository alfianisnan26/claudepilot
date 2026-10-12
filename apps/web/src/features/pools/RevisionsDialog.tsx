import { Badge, Button, Dialog, RowsSkeleton, SwitchRow, useToast } from '@isnanme/ui';
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
  // Secrets & env FR18: rolling back asks first, because a secret's old versions are a choice.
  const [rolling, setRolling] = useState<{ revision: number; restoreSecrets: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

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
    setRolling(null);
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
  const rollBack = async () => {
    if (!rolling || !pool) return;
    setBusy(true);
    try {
      await api.pools.makeCurrent(type, pool.id, rolling.revision, { restoreSecretVersions: rolling.restoreSecrets });
      toast(`Rolled back to r${rolling.revision}`);
      setRolling(null);
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not roll back.'), 'error');
    } finally {
      setBusy(false);
    }
  };
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
                    <Button size="sm" variant="secondary" onClick={() => act(() => api.pools.approve(type, pool.id, r.revision), type === 'persona' ? `r${r.revision} published` : `r${r.revision} approved`)}>
                      {type === 'persona' ? 'Publish' : 'Approve'}
                    </Button>
                  )}
                  {r.status === 'deliverable' && !r.current && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        type === 'secrets' && current && r.revision < current.revision
                          ? setRolling({ revision: r.revision, restoreSecrets: false })
                          : act(() => api.pools.makeCurrent(type, pool.id, r.revision), current && r.revision < current.revision ? `Rolled back to r${r.revision}` : `r${r.revision} is current`)
                      }
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
      <Dialog
        open={!!rolling}
        onClose={() => !busy && setRolling(null)}
        size="sm"
        title={rolling ? `Roll back to r${rolling.revision}?` : 'Roll back?'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRolling(null)} disabled={busy} data-autofocus>
              Cancel
            </Button>
            <Button variant={rolling?.restoreSecrets ? 'danger' : 'primary'} onClick={() => void rollBack()} loading={busy}>
              Roll back
            </Button>
          </>
        }
      >
        {rolling && (
          <div className="flex flex-col gap-3">
            <p className="text-[15px] text-ink-soft">
              Entries and plain variables go back to r{rolling.revision}. Secrets keep their current versions, so a value you rotated since is not delivered again.
            </p>
            <SwitchRow
              label="Restore secret versions"
              description={`Restore the secret values r${rolling.revision} held. Not after a leak.`}
              checked={rolling.restoreSecrets}
              onChange={(restoreSecrets) => setRolling({ ...rolling, restoreSecrets })}
            />
            {rolling.restoreSecrets && (
              <p role="alert" className="rounded-xl bg-amber-500/12 px-3.5 py-2.5 text-[13px] font-medium text-amber-700 dark:text-amber-400">
                Workspaces get r{rolling.revision}’s secret values again. A version you revoked can’t be restored.
              </p>
            )}
          </div>
        )}
      </Dialog>
    </Dialog>
  );
}
