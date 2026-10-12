import { Badge, RowsSkeleton } from '@isnanme/ui';
import { knowledgeApi } from './api';
import { useLoad } from './hooks';
import { activityOp, actorLabel } from './labels';
import { timeAgo } from '@/lib/format';

/** Recent changes and refusals, with who did them. */
export function ActivityPane({ vaultId, tick, onOpen }: { vaultId: string; tick: number; onOpen: (path: string) => void }) {
  const a = useLoad(`activity|${vaultId}|${tick}`, () => knowledgeApi.activity(vaultId));
  if (!a.data)
    return (
      <div className="p-4">
        <RowsSkeleton rows={5} lines={1} />
      </div>
    );
  if (a.data.length === 0) return <p className="py-10 text-center text-[14px] text-muted">Nothing yet</p>;
  return (
    <ul className="mx-auto w-full max-w-2xl p-2 sm:p-4">
      {a.data.map((e, i) => (
        <li key={`${e.at}|${i}`}>
          <button type="button" disabled={!e.path} onClick={() => e.path && onOpen(e.path)} className="press flex w-full min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left hover:bg-surface-2/70 disabled:cursor-default">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">
                {activityOp(e.op)} · {actorLabel(e.actor)}
              </span>
              <span className="block truncate text-[12.5px] text-muted">
                {[e.path, e.detail].filter(Boolean).join(' · ')}
              </span>
            </span>
            {e.outcome !== 'ok' && <Badge tone={e.outcome === 'conflict' ? 'warning' : 'danger'}>{e.outcome}</Badge>}
            <span className="shrink-0 text-[12px] text-muted">{timeAgo(e.at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
