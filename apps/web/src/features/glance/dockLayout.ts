// The side dock auto-hides (owner, 2026-11-01: "side widget panel should be auto hide"). Unpinned, it is a thin handle on the right edge that
// opens the panel over the page (on hover after a short delay, on focus, on a tap) and closes again after the pointer leaves, on a tap
// outside or Esc. Pinned (the `dockOpen` setting, kept per person), it is a column of its own beside the content on a wide screen and never
// covers it. Pure, so which form shows is tested without a browser.

/** Hovering the edge this long opens the panel (an accidental pass does not). */
export const OPEN_DELAY_MS = 250;
/** The panel closes this long after the pointer leaves it (moving back in keeps it). */
export const CLOSE_DELAY_MS = 600;
/** From here the dock is offered (a desktop); a pinned dock takes a column of its own from `DOCK_COLUMN_MIN`. */
export const DOCK_MIN_QUERY = '(min-width: 1024px)';
export const DOCK_COLUMN_QUERY = '(min-width: 1280px)';

export type DockForm = 'none' | 'column' | 'handle' | 'overlay';

/**
 * What the dock draws: nothing (a narrow screen, no widget), its own column (pinned, wide enough), the handle (unpinned and hidden), or the
 * panel over the page (unpinned and shown, or pinned where there is no room for a column).
 */
export function dockForm(s: { wide: boolean; roomy: boolean; widgets: number; pinned: boolean; shown: boolean }): DockForm {
  if (!s.wide || s.widgets === 0) return 'none';
  if (s.pinned && s.roomy) return 'column';
  return s.shown ? 'overlay' : 'handle';
}
