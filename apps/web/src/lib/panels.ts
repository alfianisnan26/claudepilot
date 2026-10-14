import { atLeast, sizeClassOf, type SizeClass } from './size';

/**
 * Where a Workbench page's panels go (T-158), as a pure function of the panels and the room: the component
 * (components/Workbench.tsx) only measures and renders what this decides. Widths are CSS px.
 */
export interface PanelSpec {
  id: string;
  /** The narrowest it stays usable: it is shown beside others only with at least this much room. */
  min: number;
  /** What it gets before any panel grows (default: `min`). */
  pref?: number;
  /** The widest it grows (default: no limit). */
  max?: number;
  /** Its share of the room left once every shown panel has its preferred width (default 0: it stays at `pref`). */
  grow?: number;
  /** Lower is more important: when room is short the higher numbers give way first (0 is the page's main panel). */
  priority: number;
  /** It collapses to a rail (RAIL_WIDTH) when it has no room, instead of disappearing. */
  rail?: boolean;
}

export type PanelState = 'shown' | 'rail' | 'hidden';

export interface PlacedPanel {
  id: string;
  state: PanelState;
  /** Its width (0 when hidden); in a single panel, the whole room. */
  width: number;
}

export interface Placement {
  size: SizeClass;
  /** Every panel, in the page's order. */
  panels: PlacedPanel[];
  /** More than one panel (a rail counts) side by side. */
  split: boolean;
  /** The panels fill the window's height and scroll inside; the page itself does not scroll. */
  pinned: boolean;
}

/** The room between two panels (a divider sits in it). */
export const PANEL_GAP = 24;
/** A collapsed panel's rail. */
export const RAIL_WIDTH = 56;
/** At most this many panels side by side, per size class: one at a time on a phone, two panes on a tablet, more above. */
export const MAX_PANELS: Record<SizeClass, number> = { compact: 1, medium: 2, expanded: 3, large: 4, xlarge: 5 };

export interface PlaceOptions {
  /** The window's size class (default: the class of `width`). */
  size?: SizeClass;
  /** The panel the person is on: it is always shown (on a phone, alone). Default: the most important one. */
  focus?: string;
  /** Pin a lone panel too on expanded and wider (a board whose header and filters stay put). */
  pinAlone?: boolean;
}

/**
 * Places `specs` in `width`: the focused panel always shows; the others follow in priority order while they fit at their minimum
 * (and the size class allows another), and the first one that does not fit ends the run, so a less important panel never shows while
 * a more important one is missing. One that does not fit becomes a rail when it has one and a rail fits, else it hides. Shown panels
 * start at `min`, rise toward `pref` together, then the growers share what is left by `grow`, each up to its `max`. Widths are whole
 * px and never add up to more than `width`.
 */
export function placePanels(specs: readonly PanelSpec[], width: number, opts: PlaceOptions = {}): Placement {
  const size = opts.size ?? sizeClassOf(width);
  const byPriority = [...specs].sort((a, b) => a.priority - b.priority);
  const focus = specs.find((p) => p.id === opts.focus) ?? byPriority[0];
  if (!focus) return { size, panels: [], split: false, pinned: false };

  const state = new Map<string, PanelState>(specs.map((p) => [p.id, 'hidden']));
  state.set(focus.id, 'shown');
  let used = focus.min;
  let shown = 1;
  let rails = 0;
  if (size !== 'compact') {
    let full = false;
    for (const p of byPriority) {
      if (p === focus) continue;
      if (!full && shown < MAX_PANELS[size] && used + PANEL_GAP + p.min <= width) {
        state.set(p.id, 'shown');
        used += PANEL_GAP + p.min;
        shown++;
        continue;
      }
      full = true;
      if (p.rail && used + PANEL_GAP + RAIL_WIDTH <= width) {
        state.set(p.id, 'rail');
        used += PANEL_GAP + RAIL_WIDTH;
        rails++;
      }
    }
  }

  const split = shown + rails > 1;
  const pinned = split || (!!opts.pinAlone && atLeast(size, 'expanded'));
  const widths = new Map<string, number>();
  if (!split) {
    widths.set(focus.id, Math.max(0, Math.floor(width)));
  } else {
    const open = specs.filter((p) => state.get(p.id) === 'shown');
    for (const p of open) widths.set(p.id, p.min);
    let room = Math.floor(width) - PANEL_GAP * (shown + rails - 1) - rails * RAIL_WIDTH - open.reduce((n, p) => n + p.min, 0);
    // Toward the preferred widths, all together.
    const need = open.reduce((n, p) => n + Math.max(0, (p.pref ?? p.min) - p.min), 0);
    if (need > 0 && room > 0) {
      const k = Math.min(1, room / need);
      for (const p of open) {
        const add = Math.floor(Math.max(0, (p.pref ?? p.min) - p.min) * k);
        widths.set(p.id, widths.get(p.id)! + add);
        room -= add;
      }
    }
    // Then the growers share the rest, up to their max; what a capped one cannot take goes round again (room is whole px and falls
    // every round, so this ends).
    const cap = (p: PanelSpec) => (p.max ?? Infinity) - widths.get(p.id)!;
    while (room > 0) {
      const growers = open.filter((p) => (p.grow ?? 0) > 0 && cap(p) > 0);
      if (growers.length === 0) break;
      const total = growers.reduce((n, p) => n + p.grow!, 0);
      let given = 0;
      for (const p of growers) {
        const add = Math.min(cap(p), Math.floor((room * p.grow!) / total));
        widths.set(p.id, widths.get(p.id)! + add);
        given += add;
      }
      room -= given;
      if (given > 0) continue;
      // A remainder of a few px, smaller than any share: it goes to the first growers with room for it.
      for (const p of growers) {
        const add = Math.min(room, cap(p));
        widths.set(p.id, widths.get(p.id)! + add);
        room -= add;
        if (room === 0) break;
      }
      break;
    }
  }

  return {
    size,
    split,
    pinned,
    panels: specs.map((p) => {
      const s = state.get(p.id)!;
      return { id: p.id, state: s, width: s === 'rail' ? RAIL_WIDTH : s === 'shown' ? (widths.get(p.id) ?? 0) : 0 };
    }),
  };
}

/**
 * The pages laid out by a Workbench (T-158). The app frame gives them its whole width (no centred column) and keeps one page
 * mounted across their own sub-paths (a list and its open item are one page). Later slices add theirs.
 */
export const WORKBENCH_PAGES = ['/admin/tickets'] as const;

/** The Workbench page `pathname` belongs to (its root path), or null. */
export function workbenchPage(pathname: string): string | null {
  return WORKBENCH_PAGES.find((p) => pathname === p || pathname.startsWith(`${p}/`)) ?? null;
}
