import { RowsSkeleton } from '@isnanme/ui';
import { Hash } from 'lucide-react';
import { knowledgeApi } from './api';
import { useLoad } from './hooks';

/** Every tag with how many notes carry it; tapping one searches for it. */
export function TagsPane({ vaultId, tick, onTag }: { vaultId: string; tick: number; onTag: (tag: string) => void }) {
  const tags = useLoad(`tags|${vaultId}|${tick}`, () => knowledgeApi.tags(vaultId));
  if (!tags.data) return <div className="p-3"><RowsSkeleton rows={5} lines={1} /></div>;
  if (tags.data.length === 0) return <p className="px-3 py-6 text-center text-[14px] text-muted">No tags</p>;
  return (
    <ul className="h-full overflow-y-auto px-2 py-2 [scrollbar-width:thin]">
      {tags.data.map((t) => (
        <li key={t.tag}>
          <button type="button" onClick={() => onTag(t.tag)} className="press flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left hover:bg-surface-2/70">
            <Hash className="size-4 shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium">{t.tag}</span>
            <span className="shrink-0 text-[12px] text-muted">{t.count}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
