import { Button, EmptyState, LoadError, RowsSkeleton, useToast } from '@isnanme/ui';
import type { TicketFilter, TicketTimeline } from '@portal/contracts';
import { ChartGantt } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { ticketsApi } from '../api';
import { FlowChart } from './FlowChart';
import { windowFor, type Scale } from './layout';

/** Rows a page: the API's most (T-119). */
const PAGE = 200;
/** Live changes are read again at most this often: a burst of ticket events is one request, and the rows don't flicker. */
const LIVE_MS = 1_500;

/**
 * T-119: the Tickets page's third view. It reads the timeline of the scale's window (up to now, the API's default length) with the queue's
 * filters, 200 tickets a page with More, and reads page 1 again when tickets change (rows keep their number order, so the ones on screen do not
 * move). A lazy chunk: the List and the Board never load it.
 */
export function TimelineView({ filter, scale, onScale, search }: { filter: TicketFilter; scale: Scale; onScale: (s: Scale) => void; search: string }) {
  const toast = useToast();
  const [data, setData] = useState<TicketTimeline | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const w = windowFor(scale, Date.now());
    try {
      const t = await ticketsApi.timeline(filter, { from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString(), granularity: scale, limit: PAGE });
      if (mine !== seq.current) return;
      setData(t);
      setFailed(false);
    } catch {
      if (mine === seq.current) setFailed(true);
    }
  }, [filter, scale]);
  // A new scale or filter shows the skeleton, not the old chart at the wrong scale.
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const timer = useRef<number | null>(null);
  useLive('tickets', () => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void load();
    }, LIVE_MS);
  });
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);
  // Open spans grow with the clock: a quiet minute still moves the now line (page 1 again, like a live change).
  useEffect(() => {
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const loadMore = async () => {
    if (!data?.next || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      // The next page asks the same window as the first: the cursor is bound to it.
      const more = await ticketsApi.timeline(filter, { from: data.from, to: data.to, granularity: data.granularity, limit: PAGE, cursor: data.next });
      if (mine !== seq.current) return;
      setData((d) => (d ? { ...d, items: [...d.items, ...more.items.filter((m) => !d.items.some((x) => x.id === m.id))], next: more.next } : d));
    } catch (e) {
      toast(errorText(e, 'Couldn’t load more.'), 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  if (failed && !data) return <LoadError onRetry={load} />;
  if (!data) return <RowsSkeleton rows={6} lines={1} />;
  const range = { from: Date.parse(data.from), to: Date.parse(data.to) };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {data.items.length === 0 ? (
        <>
          <FlowChart rows={[]} range={range} now={Date.parse(data.now)} scale={scale} onScale={onScale} search={search} />
          <EmptyState icon={<ChartGantt className="size-6" />} title="Nothing in this window" />
        </>
      ) : (
        <FlowChart rows={data.items} range={range} now={Date.parse(data.now)} scale={scale} onScale={onScale} search={search} />
      )}
      {data.next && (
        <div className="flex justify-center py-1">
          <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
            More
          </Button>
        </div>
      )}
    </div>
  );
}
