// Keeping the reading position when an older page goes in above (T-376; QA-STANDARDS A9, lists that hold still). The transcript's scroll
// area has `overflow-anchor: none` (it follows the end itself, motion/useFollow), so the browser does not hold the view still: before the
// older rows are committed the transcript notes the first row in view and how far it is from the top of the view; after, it scrolls so
// that row is exactly as far again. Pure: the transcript measures the DOM and hands the numbers here.

/** A row as measured in the scroll area's content: its anchor key (`data-anchor`) and its top and bottom, in content pixels. */
export interface MeasuredRow {
  key: string;
  top: number;
  bottom: number;
}

/** Where the reader was: the first row in view, how far its top was below the view's top (negative: cut off above), and the old height. */
export interface Anchor {
  key: string | null;
  offset: number;
  scrollTop: number;
  scrollHeight: number;
}

/** The first row whose bottom is below the view's top (rows in order); with none, only the height is kept. */
export function pickAnchor(rows: readonly MeasuredRow[], scrollTop: number, scrollHeight: number): Anchor {
  const row = rows.find((r) => r.bottom > scrollTop);
  return row ? { key: row.key, offset: row.top - scrollTop, scrollTop, scrollHeight } : { key: null, offset: 0, scrollTop, scrollHeight };
}

/**
 * The scroll position that keeps the anchor where it was: its row's new top less the old offset. When the row is gone (it was folded
 * into another as the older page joined), what was added above is the growth of the content: the old position plus that growth.
 * Never above the top.
 */
export function restoreScroll(anchor: Anchor, now: { rowTop: number | null; scrollHeight: number }): number {
  const top = now.rowTop !== null && anchor.key !== null ? now.rowTop - anchor.offset : anchor.scrollTop + (now.scrollHeight - anchor.scrollHeight);
  return Math.max(0, top);
}

/** Close enough to the top to read the older page now: within a screen of it, so it is usually in before the reader gets there. */
export const nearTop = (scrollTop: number, clientHeight: number): boolean => scrollTop < Math.max(clientHeight, 400);
