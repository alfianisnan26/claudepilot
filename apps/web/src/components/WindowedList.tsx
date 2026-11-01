import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { scrollPageTo } from '@/lib/pane';
import { columnsFor, fillHeight, linesOf, moveTo, offsetsOf, rangeOf, wantsMore } from '@/lib/windowed';

// No UI-kit import: the Admin console draws its Users and Audit with this too and keeps its bundle small.
const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** How the list scrolls: inside itself filling the scroll pane (a desktop), inside itself filling a flex parent, or with the document. */
export type WindowedMode = 'fill' | 'parent' | 'window';

export interface WindowedListProps<T> {
  items: readonly T[];
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** The list's accessible name. */
  label: string;
  /** A line's height before it is measured (px). */
  estimate?: number;
  /** Space between lines and between columns (px). */
  gap?: number;
  /** Columns of at least this width (px): a wide screen shows more rows side by side, not longer rows. */
  minColumn?: number;
  /** There is another page; it is asked for (`onLoadMore`) when the drawn lines near the end. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Filters and the like: above the list when it scrolls inside itself, sticky (`stickyClassName`) when the document scrolls. */
  header?: ReactNode;
  stickyClassName?: string;
  /** `auto`: fill the scroll pane when there is one (a desktop), else scroll with the document (a phone). `parent`: fill a flex parent. */
  fill?: 'auto' | 'parent';
  /** Shown in place of the list when there are no items. */
  empty?: ReactNode;
  /** Under the last line (a count, "x of y shown"). */
  footer?: ReactNode;
  className?: string;
  /** Classes of the scrolling box (padding for focus rings). */
  scrollClassName?: string;
  /** Shortest the list gets when it fills the pane (px): on a very short window the pane scrolls a little. */
  minHeight?: number;
}

/** The nearest ancestor that scrolls vertically (the content pane on a desktop), or null when the document scrolls. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let a = el?.parentElement ?? null; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    const y = getComputedStyle(a).overflowY;
    if (y === 'auto' || y === 'scroll') return a;
  }
  return null;
}

/** An element's top in the page's layout, transforms and scrolling left out (a page's enter animation moves it for 220 ms). */
function layoutTop(el: HTMLElement): number {
  let top = 0;
  for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) top += e.offsetTop;
  return top;
}

/** The padding and borders under `el` up to (and with) `pane`: the frame's bottom padding the list must leave. */
function spaceBelow(el: HTMLElement, pane: HTMLElement): number {
  let below = 0;
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const s = getComputedStyle(a);
    below += parseFloat(s.paddingBottom) + parseFloat(s.borderBottomWidth);
    if (a === pane) break;
  }
  return below;
}

/**
 * The height that makes `ref` end where its scroll pane does (the content pane on a desktop): what is left under its top, less the padding
 * under it; again when the pane or anything above it changes size. Null when `on` is false or nothing scrolls (the document does). A side
 * panel beside a windowed list (the console's master-detail) uses it too.
 */
export function usePaneFill(ref: RefObject<HTMLElement | null>, on: boolean, min = 240): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const pane = on ? scrollParent(el) : null;
    if (!el || !pane) return setHeight(null);
    const fit = () => {
      const next = fillHeight({ paneHeight: pane.clientHeight, topInPane: layoutTop(el) - layoutTop(pane), below: spaceBelow(el, pane), min });
      setHeight((cur) => (cur !== null && Math.abs(cur - next) < 1 ? cur : next));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(pane);
    if (pane.firstElementChild) ro.observe(pane.firstElementChild);
    window.addEventListener('resize', fit);
    return () => (ro.disconnect(), window.removeEventListener('resize', fit));
  }, [ref, on, min]);
  return height;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex="0"]';

/** Where a windowed list's filters stick on a page whose routed tab bar (57 px) sticks above them (CI, Notifications). */
export const STICKY_UNDER_TABS = 'sticky top-[calc(var(--safe-top)+4rem+57px)] z-20 -mx-4 bg-bg/95 px-4 pt-1 backdrop-blur-md sm:top-[57px] sm:-mx-6 sm:px-6';

/**
 * THE full-page list (docs/coord/UI-STANDARD.md §4; owner, 2026-11-01: "no unbounded page growth"): it fills the content pane and scrolls
 * inside it on a desktop, with its filters (`header`) above it, so the pane never grows; on a phone the document is the one scroll
 * container, the filters stick under the top bar and the list is windowed against the document. Either way only the lines in view (and a
 * few more) are drawn, measured once drawn; the next page loads as the end comes into view. Arrow keys, Home, End, PageUp and PageDown move
 * between rows. Rows are `role=listitem` with their place in the set; a row's own `<li>` becomes a `<div>`.
 */
export function WindowedList<T>({
  items,
  itemKey,
  renderItem,
  label,
  estimate = 72,
  gap = 8,
  minColumn,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  header,
  stickyClassName = 'sticky top-[calc(var(--safe-top)+4rem)] z-20 -mx-4 bg-bg/95 px-4 pt-1 backdrop-blur-md sm:top-0 sm:-mx-6 sm:px-6',
  fill = 'auto',
  empty,
  footer,
  className,
  scrollClassName,
  minHeight = 240,
}: WindowedListProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<WindowedMode>(fill === 'parent' ? 'parent' : 'window');
  const [view, setView] = useState({ top: 0, height: typeof window === 'undefined' ? 800 : window.innerHeight });
  const [width, setWidth] = useState(0);
  const heights = useRef(new Map<string, number>());
  const [measured, setMeasured] = useState(0);

  // Which way it scrolls: again on a resize (the pane scrolls from 1024 px up).
  useLayoutEffect(() => {
    if (fill === 'parent') return setMode('parent');
    const pick = () => setMode(scrollParent(root.current) ? 'fill' : 'window');
    pick();
    window.addEventListener('resize', pick);
    return () => window.removeEventListener('resize', pick);
  }, [fill]);

  const height = usePaneFill(scroller, mode === 'fill', minHeight);

  // The view: the scroller's own scroll, or the document's with the list's place in it.
  const readView = useCallback(() => {
    if (mode === 'window') {
      const r = rows.current?.getBoundingClientRect();
      if (r) setView((v) => (v.top === -r.top && v.height === window.innerHeight ? v : { top: -r.top, height: window.innerHeight }));
    } else {
      const s = scroller.current;
      if (s) setView((v) => (v.top === s.scrollTop && v.height === s.clientHeight ? v : { top: s.scrollTop, height: s.clientHeight }));
    }
  }, [mode]);
  useLayoutEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(readView);
    };
    readView();
    const target: HTMLElement | Window | null = mode === 'window' ? window : scroller.current;
    target?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const ro = new ResizeObserver(onScroll);
    if (scroller.current) ro.observe(scroller.current);
    return () => {
      cancelAnimationFrame(frame);
      target?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      ro.disconnect();
    };
  }, [mode, readView, height]);

  // Columns from the list's width.
  useLayoutEffect(() => {
    const el = rows.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length === 0]);

  const cols = columnsFor(width, minColumn, gap);
  const lines = useMemo(() => linesOf(items.map((item, index) => ({ item, index })), cols), [items, cols]);
  const lineKeys = useMemo(() => lines.map((l) => l.map((x) => itemKey(x.item, x.index)).join('|')), [lines, itemKey]);
  // `measured` bumps when a drawn line reports a new height.
  const offsets = useMemo(() => offsetsOf(lineKeys.map((k) => heights.current.get(k)), estimate + gap), [lineKeys, estimate, gap, measured]);
  const range = rangeOf(offsets, view.top, view.height);
  const total = offsets[offsets.length - 1] ?? 0;

  // Drawn lines are measured (their gap included), and again when they change size (a row that wraps, an image).
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const key = el.dataset.wlLine;
        if (!key) continue;
        const h = el.offsetHeight;
        if (h > 0 && heights.current.get(key) !== h) {
          heights.current.set(key, h);
          changed = true;
        }
      }
      if (changed) setMeasured((n) => n + 1);
    });
    return () => observer.current?.disconnect();
  }, []);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (el) observer.current?.observe(el);
  }, []);

  // The next page, once per arrival: a failed load does not ask again in a loop (the More button under the list asks by hand).
  const asked = useRef(-1);
  useEffect(() => {
    if (!onLoadMore || !wantsMore({ end: range.end, lines: lines.length, hasMore, loading: loadingMore })) return;
    if (asked.current === items.length) return;
    asked.current = items.length;
    onLoadMore();
  }, [range.end, lines.length, hasMore, loadingMore, onLoadMore, items.length]);
  const stalled = hasMore && !loadingMore && asked.current === items.length && range.end >= lines.length;

  // Keys: move between rows; a row out of the drawn range is scrolled to, then focused once drawn.
  const pending = useRef<number | null>(null);
  const focusRow = useCallback((i: number) => {
    const el = rows.current?.querySelector<HTMLElement>(`[data-wl-index="${i}"]`);
    if (!el) return false;
    (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    return true;
  }, []);
  useEffect(() => {
    if (pending.current !== null && focusRow(pending.current)) pending.current = null;
  });
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea, [role=menu], [contenteditable=true]')) return;
    const at = t.closest<HTMLElement>('[data-wl-index]');
    if (!at) return;
    const page = Math.max(1, Math.floor(view.height / (estimate + gap)));
    const to = moveTo(e.key, Number(at.dataset.wlIndex), items.length, page * cols);
    if (to === null) return;
    e.preventDefault();
    if (focusRow(to)) return;
    pending.current = to;
    const y = offsets[Math.floor(to / cols)] ?? 0;
    if (mode === 'window') {
      const r = rows.current?.getBoundingClientRect();
      if (r) scrollPageTo(window.scrollY + r.top + y - 120);
    } else scroller.current?.scrollTo({ top: y });
  };

  const own = mode !== 'window';
  return (
    <div
      ref={root}
      data-windowed={mode}
      className={cn(mode === 'parent' && 'flex min-h-0 flex-1 flex-col', className)}
    >
      {header && <div data-windowed-header="" className={cn(mode === 'window' && stickyClassName)}>{header}</div>}
      <div
        ref={scroller}
        data-windowed-scroll=""
        // `relative`: the scroller is the containing block of what is absolutely placed in its rows (a screen-reader-only "(unread)"), so it
        // clips it too; without it such text hangs at its place far down the list and makes the document scroll.
        className={cn(own && 'relative overflow-y-auto overscroll-contain [scrollbar-width:thin]',mode === 'parent' && 'min-h-0 flex-1', scrollClassName)}
        style={mode === 'fill' && height !== null ? { height } : undefined}
      >
        {items.length === 0 ? (
          empty
        ) : (
          <div
            ref={rows}
            role="list"
            aria-label={label}
            aria-busy={loadingMore || undefined}
            onKeyDown={onKey}
            style={{ paddingTop: offsets[range.start] ?? 0, paddingBottom: Math.max(0, total - (offsets[range.end] ?? total)) }}
          >
            {lines.slice(range.start, range.end).map((line, n) => {
              const at = range.start + n;
              const last = at === lines.length - 1;
              return (
                <div
                  key={lineKeys[at]}
                  ref={measure}
                  data-wl-line={lineKeys[at]}
                  role="none"
                  className={cols > 1 ? 'grid' : undefined}
                  style={{ paddingBottom: last ? 0 : gap, ...(cols > 1 ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, columnGap: gap } : null) }}
                >
                  {line.map(({ item, index }) => (
                    <div key={itemKey(item, index)} role="listitem" aria-posinset={index + 1} aria-setsize={hasMore ? -1 : items.length} data-wl-index={index} tabIndex={-1} className="min-w-0 outline-hidden">
                      {renderItem(item, index)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        {items.length > 0 && (loadingMore || stalled || footer) && (
          <div className="flex flex-col items-center gap-2 py-3" style={{ minHeight: loadingMore ? estimate : undefined }}>
            {loadingMore && <div className="skeleton h-12 w-full rounded-2xl" aria-hidden="true" />}
            {stalled && (
              <button
                type="button"
                onClick={() => ((asked.current = -1), onLoadMore?.())}
                className="press min-h-11 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink-soft outline-hidden hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
              >
                More
              </button>
            )}
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
