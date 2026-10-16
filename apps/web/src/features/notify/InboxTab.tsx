import { Button, cn, EmptyState, LoadError, Menu, RowsSkeleton, useToast, ConfirmDialog } from '@isnanme/ui';
import { isMuteGuarded, type NotifyHistoryItem } from '@portal/contracts';
import { Bell, BellOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClampedText } from './ClampedText';
import { useNavigate } from 'react-router';
import { errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { notifyApi } from './api';
import { bodyText, dayLabel } from './inbox';
import { MuteDialog } from './MuteDialog';
import { loadNotifyOverview, patchOverview, useNotifyOverview } from './store';

/** The history, newest first: an unread dot, dimmed when dealt with; a tap opens the item. */
export function InboxTab() {
  const toast = useToast();
  const navigate = useNavigate();
  const { overview } = useNotifyOverview();
  const [items, setItems] = useState<NotifyHistoryItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const [clearing, setClearing] = useState(false);
  /** Items that arrived while the list is on screen: counted in a pill over the list, merged when the person asks, so nothing visible moves. */
  const [pending, setPending] = useState<NotifyHistoryItem[]>([]);
  const shown = useRef<Set<string>>(new Set());
  const seq = useRef(0);
  /** Muted items are kept but left out unless the person asks to see them. */
  const [withMuted, setWithMuted] = useState(false);
  const muted = useRef(false);
  muted.current = withMuted;
  const [muting, setMuting] = useState<string | null>(null);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const page = await notifyApi.history({ limit: 30, muted: muted.current });
      if (mine !== seq.current) return;
      patchOverview((o) => ({ ...o, unread: page.unread }));
      setFailed(false);
      if (shown.current.size === 0) {
        shown.current = new Set(page.items.map((i) => i.id));
        setItems(page.items);
        setNext(page.next);
        setPending([]);
        return;
      }
      // Later loads update what is on screen in place (read, dealt with) and hold new items back.
      const byId = new Map(page.items.map((i) => [i.id, i]));
      setItems((cur) => cur?.map((i) => byId.get(i.id) ?? i) ?? cur);
      setPending(page.items.filter((i) => !shown.current.has(i.id)));
    } catch {
      if (mine === seq.current) setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLive('notify', () => void load());

  const toggleMuted = () => {
    muted.current = !withMuted;
    setWithMuted(!withMuted);
    shown.current = new Set();
    void load();
  };

  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try {
      const page = await notifyApi.history({ before: next, limit: 30, muted: withMuted });
      for (const i of page.items) shown.current.add(i.id);
      setItems((cur) => [...(cur ?? []), ...page.items]);
      setNext(page.next);
    } catch (e) {
      toast(errorText(e, 'Could not load more.'), 'error');
    } finally {
      setMore(false);
    }
  };

  const markRead = async (upTo?: string) => {
    try {
      const { unread } = await notifyApi.markRead(upTo);
      setItems((cur) => cur?.map((i) => (!i.readAt && (!upTo || i.at <= upTo) ? { ...i, readAt: new Date().toISOString() } : i)) ?? cur);
      patchOverview((o) => ({ ...o, unread }));
    } catch (e) {
      toast(errorText(e, 'Could not mark it read.'), 'error');
    }
  };

  const merge = () => {
    for (const i of pending) shown.current.add(i.id);
    setItems((cur) => [...pending, ...(cur ?? [])]);
    setPending([]);
    window.scrollTo({ top: 0 });
  };

  const open = (i: NotifyHistoryItem) => {
    if (!i.readAt) void markRead(i.at);
    if (i.path) navigate(i.path);
  };

  const clear = async () => {
    try {
      await notifyApi.clearHistory();
      shown.current = new Set();
      setItems([]);
      setNext(null);
      setPending([]);
      setClearing(false);
      await loadNotifyOverview();
    } catch (e) {
      toast(errorText(e, 'Could not clear the Inbox.'), 'error');
      setClearing(false);
    }
  };

  if (failed && !items) return <LoadError onRetry={load} />;
  if (!items) return <RowsSkeleton rows={4} lines={1} icon="rounded-full" />;
  const mutedButton = (
    <Button variant={withMuted ? 'secondary' : 'ghost'} size="sm" aria-pressed={withMuted} aria-label="Show muted" icon={<BellOff className="size-4" />} onClick={toggleMuted}>
      <span className="hidden sm:inline">Muted</span>
    </Button>
  );
  if (items.length === 0)
    return (
      <>
        <div className="mb-3 flex justify-end">{mutedButton}</div>
        <EmptyState icon={<Bell className="size-6" />} title="Nothing yet">
          Approvals, failures and the rest land here for 30 days.
        </EmptyState>
      </>
    );

  let day = '';
  return (
    <>
      <div className="mb-3 flex items-center justify-end gap-2">
        {mutedButton}
        <Button variant="secondary" size="sm" disabled={!overview?.unread} onClick={() => void markRead()}>
          Mark all read
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setClearing(true)}>
          Clear
        </Button>
      </div>
      {/* Zero height and sticky: the pill floats over the list and never pushes it. */}
      <div className="sticky top-20 z-10 h-0 sm:top-4">
        {pending.length > 0 && (
          <div className="flex justify-center">
            <button type="button" onClick={merge} aria-live="polite" className="press rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-ink shadow-lift focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
              {pending.length} new
            </button>
          </div>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((i) => {
          const label = dayLabel(i.at);
          const heading = label !== day ? ((day = label), label) : null;
          return (
            <li key={i.id} className="list-none">
              {heading && <h3 className="mt-2 mb-1.5 px-1 text-[12.5px] font-semibold text-muted">{heading}</h3>}
              <div className="flex items-start rounded-2xl border border-line bg-surface">
                <button
                  type="button"
                  onClick={() => open(i)}
                  className={cn(
                    'flex min-h-14 min-w-0 flex-1 items-start gap-3 rounded-2xl px-3.5 py-3 text-left transition-opacity focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden',
                    (i.resolvedAt || i.muted) && 'opacity-60',
                  )}
                >
                  <span aria-hidden="true" className={cn('mt-1.5 size-2 shrink-0 rounded-full', i.readAt ? 'bg-transparent' : 'bg-accent')} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={cn('min-w-0 flex-1 text-[14.5px]', i.readAt ? 'font-medium' : 'font-semibold')}>
                        {i.muted && <BellOff className="mr-1 inline size-3.5 align-[-2px] text-muted" aria-label="Muted" />}
                        <ClampedText>{i.title}</ClampedText>
                        {!i.readAt && <span className="sr-only"> (unread)</span>}
                      </span>
                      <time dateTime={i.at} className="shrink-0 text-[12px] text-muted">
                        {timeAgo(i.at)}
                      </time>
                    </span>
                    <ClampedText lines={2} className="text-[13px] text-muted">{bodyText(i)}</ClampedText>
                    {i.resolvedAt && i.resolution && <ClampedText className="mt-0.5 text-[12.5px] text-muted">{i.resolution}</ClampedText>}
                  </span>
                </button>
                {i.kind !== 'test' && !isMuteGuarded(i.kind) && (
                  <div className="shrink-0 self-center pr-1">
                    <Menu label={`${i.title} actions`} items={[{ label: 'Mute similar…', onSelect: () => setMuting(i.id) }]} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {next && (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" loading={more} onClick={() => void loadMore()}>
            Older
          </Button>
        </div>
      )}
      <MuteDialog muteRef={muting} onClose={() => setMuting(null)} onMuted={() => void load()} />
      <ConfirmDialog open={clearing} title="Clear the Inbox" description="Removes every item. Devices and channels keep their settings." confirmLabel="Clear" onConfirm={() => void clear()} onClose={() => setClearing(false)} />
    </>
  );
}
