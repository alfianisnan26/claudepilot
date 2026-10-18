// Home's dashboard columns (owner, 2026-10-18: "fix the dynamic dashboard layout without his silly gaps"): a CSS grid gives each ROW the
// height of its tallest card, so a short card leaves a hole under it. Instead each column is its own stack; each card, in the person's
// order, goes to a column so that the tallest stack is as short as it can be (QA 2026-10-18: "shortest so far" left 354 px ragged ends at
// three columns; the best assignment gives 37). Each column keeps the person's order.
//
// Holding still (QA A4; the second QA pass: the bare optimum flipped every card on each big change of the Sessions card): with the current
// packing given, any assignment whose tallest stack is within SETTLE_PX of the best counts as good, and of those the one that moves the
// fewest cards wins, so a packing that is still good is kept as it is.

/** How far above the best tallest stack a packing may be and still count as good (px). */
export const SETTLE_PX = 120;

/** Above this many cases the search gives way to the greedy rule (10 cards on 3 columns is 59k). */
const SEARCH_MAX = 200_000;

/**
 * The cards of each column, in order. Heights unknown yet (0) fall back to round robin, so the first paint is stable. `prev`: the
 * current packing (card index lists per column); when given, the good packing that moves the fewest of its cards is chosen.
 */
export function packColumns(heights: readonly number[], n: number, gap = 16, prev?: readonly (readonly number[])[]): number[][] {
  const k = Math.max(1, n);
  const cols: number[][] = Array.from({ length: k }, () => []);
  if (k === 1) return [heights.map((_, i) => i)];
  if (heights.some((h) => !(h > 0))) {
    heights.forEach((_, i) => cols[i % k]!.push(i));
    return cols;
  }
  if (k ** heights.length > SEARCH_MAX) return greedy(heights, k, gap);
  const was = new Map<number, number>();
  if (prev && prev.length === k) prev.forEach((c, ci) => c.forEach((i) => was.set(i, ci)));
  const usePrev = was.size === heights.length;
  // Pass 1: the best tallest stack. Pass 2: within SETTLE_PX of it, the fewest moves from `prev` (then the shorter tallest stack, then
  // the smaller spread). Without `prev`, pass 2 is the best packing itself.
  const best = search(heights, k, gap, Infinity, null);
  const pick = usePrev ? search(heights, k, gap, best.max + SETTLE_PX, was) : best;
  pick.cols.forEach((c, i) => cols[c]!.push(i));
  return cols;
}

function search(heights: readonly number[], k: number, gap: number, cap: number, was: Map<number, number> | null) {
  const sums = new Array<number>(k).fill(0);
  const pick = new Array<number>(heights.length).fill(0);
  let best = { cols: [] as number[], moves: Infinity, max: Infinity, spread: Infinity };
  const walk = (i: number, moves: number) => {
    const max = Math.max(...sums);
    if (max > cap || moves > best.moves || (was === null && max > best.max)) return;
    if (i === heights.length) {
      const spread = max - Math.min(...sums);
      const better = moves < best.moves || (moves === best.moves && (max < best.max || (max === best.max && spread < best.spread)));
      if (better) best = { cols: pick.slice(), moves, max, spread };
      return;
    }
    const seen = new Set<number>();
    for (let c = 0; c < k; c++) {
      // Without a previous packing, two columns of the same height are the same choice: the left one only (ties go left).
      if (was === null) {
        if (seen.has(sums[c]!)) continue;
        seen.add(sums[c]!);
      }
      pick[i] = c;
      sums[c]! += heights[i]! + gap;
      walk(i + 1, moves + (was !== null && was.get(i) !== c ? 1 : 0));
      sums[c]! -= heights[i]! + gap;
    }
  };
  walk(0, 0);
  return best;
}

function greedy(heights: readonly number[], k: number, gap: number): number[][] {
  const cols: number[][] = Array.from({ length: k }, () => []);
  const tall = cols.map(() => 0);
  heights.forEach((h, i) => {
    let at = 0;
    for (let c = 1; c < k; c++) if (tall[c]! < tall[at]! - 1) at = c;
    cols[at]!.push(i);
    tall[at]! += h + gap;
  });
  return cols;
}

/** The tallest column's height minus the shortest's, for a packing. */
export function spread(heights: readonly number[], cols: readonly (readonly number[])[], gap = 16): number {
  const sums = cols.map((c) => c.reduce((a, i) => a + (heights[i] ?? 0) + gap, 0));
  return Math.max(...sums) - Math.min(...sums);
}
