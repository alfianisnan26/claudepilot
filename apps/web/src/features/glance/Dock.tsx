import { cn, ease, useMediaQuery } from '@isnanme/ui';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, Pin, PinOff, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBadgeTotal } from './badge';
import { CLOSE_DELAY_MS, DOCK_COLUMN_QUERY, DOCK_MIN_QUERY, dockForm, OPEN_DELAY_MS } from './dockLayout';
import { useGlanceFocusValue } from './focus';
import { FullBody, FullHeader } from './Host';
import { Quiet } from './Quiet';
import { useStripWidgets } from './Strip';
import { updateGlanceSettings, useGlanceSettings } from './settings';
import type { GlanceContext, GlanceWidget } from './types';

/** How wide the panel is; a pinned column pads the shell's content by it (`--glance-dock-w`), so nothing sits under it. */
const DOCK_WIDTH = '20rem';

const iconButton =
  'press inline-flex size-11 items-center justify-center rounded-full text-muted outline-hidden hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent';

/**
 * The desktop's side dock (when the person turned it on in Settings > Glance), auto-hiding (dockLayout.ts; owner, 2026-11-01): a thin handle
 * on the right edge, with a dot when something waits on the person; hovering the edge (after a short delay), focusing or tapping the handle
 * slides the panel in over the page, and it slides back out after the pointer leaves, on a tap outside or Esc. Pin keeps it: a pinned dock
 * is a column of its own beside the content (from 1280 px) and never covers it.
 */
export function GlanceDock() {
  const wide = useMediaQuery(DOCK_MIN_QUERY);
  const roomy = useMediaQuery(DOCK_COLUMN_QUERY);
  const { dockOpen: pinned } = useGlanceSettings();
  const widgets = useStripWidgets('dock');
  const focus = useGlanceFocusValue();
  const ctx: GlanceContext = { focus, placement: 'dock' };
  const waiting = (useBadgeTotal() ?? 0) > 0;
  const [shown, setShown] = useState(false);
  // How it was opened: by hover it closes when the pointer leaves; by a tap or the keyboard it stays until a tap outside, Esc or Close.
  const byHover = useRef(false);
  const returning = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const panel = useRef<HTMLElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const form = dockForm({ wide, roomy, widgets: widgets.length, pinned, shown });

  const clear = () => window.clearTimeout(timer.current);
  const open = useCallback((hover: boolean) => {
    window.clearTimeout(timer.current);
    byHover.current = hover;
    setShown(true);
  }, []);
  const close = useCallback((refocus = false) => {
    window.clearTimeout(timer.current);
    setShown(false);
    // Focus goes back to the handle, which must not take that focus as a request to open again.
    if (refocus) requestAnimationFrame(() => ((returning.current = true), handle.current?.focus(), (returning.current = false)));
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // The pointer on the edge, the handle or the panel: open after a short delay (or stay open). Off them: a hover-opened panel closes after
  // a moment (moving back in keeps it); one opened by a tap or the keyboard stays.
  const enterEdge = () => {
    clear();
    if (!shown) timer.current = window.setTimeout(() => open(true), OPEN_DELAY_MS);
  };
  const leaveEdge = () => {
    clear();
    if (shown && byHover.current) timer.current = window.setTimeout(() => close(), CLOSE_DELAY_MS);
  };

  // A pinned column makes room; the handle and the overlay do not.
  useEffect(() => {
    if (form !== 'column') return;
    const root = document.documentElement;
    root.style.setProperty('--glance-dock-w', DOCK_WIDTH);
    return () => void root.style.removeProperty('--glance-dock-w');
  }, [form]);

  // The overlay: Esc and a tap outside close it; opened by a tap or the keyboard, the panel takes the focus.
  useEffect(() => {
    if (form !== 'overlay') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(true);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !handle.current?.contains(t)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    if (!byHover.current) requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('button')?.focus());
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [form, close]);

  if (form === 'none') return null;

  const body = (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 pb-6 [scrollbar-width:thin]">
      {widgets.map((w) => (
        <Quiet key={w.id} what={`${w.id} (dock)`}>
          <DockSection widget={w} ctx={ctx} />
        </Quiet>
      ))}
    </div>
  );
  const pin = (
    <button
      type="button"
      onClick={() => (updateGlanceSettings({ dockOpen: !pinned }), pinned && close())}
      aria-label={pinned ? 'Unpin dock' : 'Pin dock'}
      aria-pressed={pinned}
      title={pinned ? 'Unpin: hide it again' : 'Pin: keep it open'}
      className={iconButton}
    >
      {pinned ? <PinOff className="size-[18px]" /> : <Pin className="size-[18px]" />}
    </button>
  );

  if (form === 'column')
    return (
      <aside aria-label="Dock" data-dock="column" style={{ width: DOCK_WIDTH }} className="fixed inset-y-0 right-0 z-30 flex flex-col border-l border-line bg-bg">
        <div className="flex h-14 shrink-0 items-center justify-end px-2">{pin}</div>
        {body}
      </aside>
    );

  return (
    <>
      {/* The handle: a slim tab at the middle of the right edge (44 px tall; wider on touch), and an invisible hover strip the full height. */}
      <div
        aria-hidden="true"
        data-dock-edge=""
        className="fixed inset-y-0 right-0 z-30 w-2"
        onPointerEnter={(e) => e.pointerType === 'mouse' && enterEdge()}
        onPointerLeave={(e) => e.pointerType === 'mouse' && leaveEdge()}
      />
      <button
        ref={handle}
        type="button"
        data-dock="handle"
        aria-label={waiting ? 'Show dock (something waits on you)' : 'Show dock'}
        aria-expanded={form === 'overlay'}
        aria-controls="glance-dock"
        title="Dock"
        onClick={() => (form === 'overlay' ? close() : open(false))}
        onFocus={(e) => !returning.current && e.currentTarget.matches(':focus-visible') && form === 'handle' && open(false)}
        onPointerEnter={(e) => e.pointerType === 'mouse' && enterEdge()}
        onPointerLeave={(e) => e.pointerType === 'mouse' && leaveEdge()}
        className="press fixed top-1/2 right-0 z-30 flex h-14 w-5 -translate-y-1/2 items-center justify-center rounded-l-xl border border-r-0 border-line bg-surface text-muted shadow-card outline-hidden hover:text-ink focus-visible:ring-2 focus-visible:ring-accent tap:w-11"
      >
        <ChevronLeft className="size-4" />
        {waiting && <span data-dock-dot="" className="absolute -top-1 left-0.5 size-2.5 rounded-full bg-amber-500 ring-2 ring-bg" />}
      </button>
      <AnimatePresence>
        {form === 'overlay' && (
          <motion.aside
            ref={panel}
            id="glance-dock"
            aria-label="Dock"
            data-dock="overlay"
            style={{ width: DOCK_WIDTH }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.2, ease }}
            onPointerEnter={(e) => e.pointerType === 'mouse' && clear()}
            onPointerLeave={(e) => e.pointerType === 'mouse' && leaveEdge()}
            className={cn('fixed inset-y-0 right-0 z-40 flex flex-col border-l border-line bg-bg shadow-lift')}
          >
            <div className="flex h-14 shrink-0 items-center justify-end gap-1 px-2">
              {roomy && pin}
              <button type="button" onClick={() => close(true)} aria-label="Hide dock" title="Hide" className={iconButton}>
                <X className="size-[18px]" />
              </button>
            </div>
            {body}
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}

function DockSection({ widget, ctx }: { widget: GlanceWidget; ctx: GlanceContext }) {
  return (
    <section aria-label={widget.label} className="rounded-[20px] border border-line bg-surface">
      <FullHeader widget={widget} />
      <div className="px-4 pb-4">
        <FullBody widget={widget} ctx={ctx} surface="dock" close={() => undefined} />
      </div>
    </section>
  );
}
