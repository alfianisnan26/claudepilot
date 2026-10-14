import { cn, ease } from '@isnanme/ui';
import { motion } from 'motion/react';
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PANEL_GAP, placePanels, type PanelSpec } from '@/lib/panels';
import { useSize } from '@/lib/size';

/** One panel of a Workbench page: where it goes is decided by `placePanels` (lib/panels.ts) from these. */
export interface Panel extends Omit<PanelSpec, 'rail'> {
  /** Its name, for screen readers (each panel is a labelled region). */
  label: string;
  /** What it shows; null when it has nothing now (a detail with no item open), and then it takes no room. */
  content: ReactNode | null;
  /** What it shows collapsed, as a narrow rail, when it has no room; without one it hides instead. */
  rail?: ReactNode;
  /**
   * Pinned, `panel` (the default) scrolls the panel as a whole; `self` leaves the scrolling to the content (a header and filters
   * that stay put over a list or a board that scrolls), which then fills the panel's height (`min-h-0 flex-1`).
   */
  scroll?: 'panel' | 'self';
}

export interface PanelInfo {
  /** The panels fill the window's height: the content scrolls inside its panel, never the page. */
  pinned: boolean;
  /** Other panels are on screen beside this one. */
  split: boolean;
}

const PanelContext = createContext<PanelInfo>({ pinned: false, split: false });

/** How the panel this content sits in is placed. */
export const usePanel = () => useContext(PanelContext);

/** Shortest a pinned workbench gets, on a very short window (the page scrolls a little then). */
const PINNED_MIN = 320;

/** The height that makes a pinned workbench end where the window does: below its top, less the frame's padding under it. */
function pinnedHeight(el: HTMLElement): number {
  let top = 0;
  for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) top += e.offsetTop;
  let below = 0;
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const s = getComputedStyle(a);
    below += parseFloat(s.paddingBottom) + parseFloat(s.borderBottomWidth);
  }
  return Math.max(PINNED_MIN, Math.floor(window.innerHeight - top - below));
}

/**
 * The panel layout of a page (T-158). The page declares its panels; this measures its own width and places them per size class: a phone
 * shows one at a time (the one the person is on: push navigation, as before), a tablet two panes when they fit, a desktop more. Fluid,
 * no max width: the room is shared by the panels' min, preferred and max widths. Side by side (or with `pinAlone`, on a desktop) the
 * workbench is pinned: it ends at the window's bottom and each panel scrolls inside, so the page never scrolls, sideways or down. Each
 * panel is a container (`@container`), so what it holds can answer to the panel's width rather than the window's.
 */
export function Workbench({ panels, focus, pinAlone = false }: { panels: Panel[]; focus?: string; pinAlone?: boolean }) {
  const size = useSize();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState<number | null>(null);
  const present = panels.filter((p) => p.content != null);
  const place = placePanels(
    present.map((p) => ({ id: p.id, min: p.min, pref: p.pref, max: p.max, grow: p.grow, priority: p.priority, rail: p.rail != null })),
    width,
    { size, focus, pinAlone },
  );

  // Its own width, before the first paint and on every change (the window, the sidebar, a scrollbar coming or going).
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = root.current;
    if (!place.pinned || !el) return setHeight(null);
    const fit = () => setHeight(pinnedHeight(el));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [place.pinned]);

  // Opening an item beside the list moves the keyboard to it (not on the first render: a deep link keeps the page's own focus).
  const first = useRef(true);
  const sections = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    if (first.current) return void (first.current = false);
    if (place.split && focus) sections.current.get(focus)?.focus({ preventScroll: true });
    // Only a change of focus moves it, not a re-render or a resize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const info: PanelInfo = { pinned: place.pinned, split: place.split };
  let index = 0;
  return (
    <div
      ref={root}
      data-workbench=""
      data-size={size}
      data-split={place.split ? '' : undefined}
      data-pinned={place.pinned ? '' : undefined}
      className={cn('min-w-0', place.pinned && 'flex')}
      style={place.pinned ? { columnGap: PANEL_GAP, ...(height ? { height } : null) } : undefined}
    >
      <PanelContext.Provider value={info}>
        {present.map((p) => {
          const at = place.panels.find((x) => x.id === p.id);
          if (!at || at.state === 'hidden') return null;
          const divided = index++ > 0;
          const rail = at.state === 'rail';
          return (
            <motion.section
              key={p.id}
              ref={(el: HTMLElement | null) => void (el ? sections.current.set(p.id, el) : sections.current.delete(p.id))}
              aria-label={p.label}
              tabIndex={-1}
              data-panel={p.id}
              data-state={at.state}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease }}
              className={cn(
                '@container min-w-0 outline-none',
                place.pinned && 'shrink-0',
                place.pinned && (rail || (p.scroll ?? 'panel') === 'panel') && 'overflow-y-auto overscroll-contain',
                place.pinned && !rail && p.scroll === 'self' && 'flex flex-col',
                divided && 'border-l border-line pl-6',
              )}
              style={place.pinned ? { width: at.width } : undefined}
            >
              {rail ? p.rail : p.content}
            </motion.section>
          );
        })}
      </PanelContext.Provider>
    </div>
  );
}
