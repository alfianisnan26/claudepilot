// The windowed full-page list (owner, 2026-11-01: "no unbounded page growth"; docs/coord/UI-STANDARD.md §4, docs/prd/ui-layout.md §3).
// A full-page list (Tickets, Agents, Needs you, the Inbox, CI runs, the console's Users and Audit) draws only the lines in view plus a few
// on each side; the rest is two spacers of the right height. Lines are measured once drawn and estimated before. Pure, so the range, the
// offsets, the line grouping and the "load more" rule are tested without a browser; components/WindowedList.tsx draws it. No UI-kit import:
// the Admin console uses it too.

/** Where each line starts (offsets[i]) and the total height (offsets[n]); a line not measured yet counts as `estimate`. */
export function offsetsOf(heights: readonly (number | undefined)[], estimate: number): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i]! + (heights[i] ?? estimate);
  return out;
}

/** The first line whose bottom is below `y` (binary search over the offsets). */
export function lineAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Range {
  /** first line drawn */
  start: number;
  /** one past the last line drawn */
  end: number;
}

/**
 * The lines to draw for a view of `height` px scrolled to `top` px (both relative to the list's own top; `top` may be negative when the list
 * starts below the viewport's top), with `overscan` lines more on each side. Always at least one line when there are any.
 */
export function rangeOf(offsets: readonly number[], top: number, height: number, overscan = 6): Range {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  const total = offsets[n]!;
  const from = Math.min(Math.max(0, top), Math.max(0, total - 1));
  const to = Math.max(from, Math.min(total, top + Math.max(height, 1)));
  const first = lineAt(offsets, from);
  const last = lineAt(offsets, Math.max(from, to - 0.5));
  return { start: Math.max(0, first - overscan), end: Math.min(n, last + 1 + overscan) };
}

/** Items in lines of `cols` (a grid of rows on a wide screen; one per line on a phone). */
export function linesOf<T>(items: readonly T[], cols: number): T[][] {
  const c = Math.max(1, Math.floor(cols));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += c) out.push(items.slice(i, i + c));
  return out;
}

/** How many columns of at least `min` px (with `gap` between) fit in `width` px; at least one. */
export function columnsFor(width: number, min: number | undefined, gap: number): number {
  if (!min || min <= 0 || width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (min + gap)));
}

/** Ask for the next page when the drawn range reaches within `threshold` lines of the end, there is more, and nothing is loading. */
export function wantsMore(o: { end: number; lines: number; hasMore: boolean; loading: boolean; threshold?: number }): boolean {
  return o.hasMore && !o.loading && o.end >= o.lines - (o.threshold ?? 4);
}

/** The line a key moves to from line `at` of `n` (`page` lines for PageUp/PageDown), or null for any other key. */
export function moveTo(key: string, at: number, n: number, page: number): number | null {
  if (n <= 0) return null;
  const clamp = (i: number) => Math.min(n - 1, Math.max(0, i));
  switch (key) {
    case 'ArrowDown':
      return clamp(at + 1);
    case 'ArrowUp':
      return clamp(at - 1);
    case 'Home':
      return 0;
    case 'End':
      return n - 1;
    case 'PageDown':
      return clamp(at + Math.max(1, page));
    case 'PageUp':
      return clamp(at - Math.max(1, page));
    default:
      return null;
  }
}

/** The height a list that fills its scroll pane gets: what is left of the pane under the list's top, less the padding under it. */
export function fillHeight(o: { paneHeight: number; topInPane: number; below: number; min: number }): number {
  return Math.max(o.min, Math.floor(o.paneHeight - o.topInPane - o.below));
}
