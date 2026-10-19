import { Button } from '@isnanme/ui';
import { Archive, CircleStop, Trash2 } from 'lucide-react';

export type BulkAction = 'end' | 'archive' | 'delete';

/**
 * Runs `act` on each item, three at a time, and says how it went. A failure never stops the rest: the
 * ones that went through stay done, and the failures come back with their errors.
 */
export async function runBulk<T>(items: T[], act: (item: T) => Promise<unknown>, concurrency = 3): Promise<{ ok: number; failed: { item: T; error: unknown }[] }> {
  const failed: { item: T; error: unknown }[] = [];
  let ok = 0;
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await act(item);
        ok++;
      } catch (error) {
        failed.push({ item, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { ok, failed };
}

/**
 * What can be done to the selected sessions. Fixed to the bottom on phones, just above the tab bar, so
 * it's under the thumb; sticky under the toolbar on wider screens. Every action asks first.
 */
export function BulkBar({
  count,
  total,
  onAll,
  onNone,
  onDone,
  onAction,
}: {
  count: number;
  total: number;
  onAll: () => void;
  onNone: () => void;
  onDone: () => void;
  onAction: (a: BulkAction) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Selected agents"
      className="glass-card fixed inset-x-3 bottom-[calc(var(--tabbar-h,0px)+env(safe-area-inset-bottom)+0.5rem)] z-40 mx-auto flex max-w-[860px] flex-col gap-2 rounded-[24px] p-3 sm:bottom-6 sm:flex-row sm:items-center sm:gap-2 sm:px-4 sm:py-2.5"
    >
      <p className="flex items-center gap-2 text-[14px] font-semibold sm:mr-auto" aria-live="polite">
        {count} selected
        <button type="button" onClick={count === total ? onNone : onAll} className="text-[13px] font-semibold text-muted underline underline-offset-2">
          {count === total ? 'Clear' : 'Select all'}
        </button>
        <button type="button" onClick={onDone} className="ml-auto text-[13px] font-semibold text-muted underline underline-offset-2 sm:hidden">
          Done
        </button>
      </p>
      <div className="grid grid-cols-3 gap-2 sm:flex">
        <Button size="sm" variant="secondary" icon={<CircleStop className="size-4" />} disabled={count === 0} onClick={() => onAction('end')}>
          End
        </Button>
        <Button size="sm" variant="secondary" icon={<Archive className="size-4" />} disabled={count === 0} onClick={() => onAction('archive')}>
          Archive
        </Button>
        <Button size="sm" variant="danger" icon={<Trash2 className="size-4" />} disabled={count === 0} onClick={() => onAction('delete')}>
          Delete
        </Button>
        <Button size="sm" variant="ghost" className="hidden sm:inline-flex" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
