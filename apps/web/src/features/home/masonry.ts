// Home's dashboard columns (owner, 2026-10-18: "fix the dynamic dashboard layout without his silly gaps"): a CSS grid gives each ROW the
// height of its tallest card, so a short card leaves a hole under it. Instead each column is its own stack, and each card, in the person's
// order, goes to a column so that the tallest stack is as short as it can be (QA 2026-10-18: "shortest so far" left 354 px ragged ends at
// three columns; the best assignment of the same cards gives 37). Each column keeps the person's order.

/** The column (0..n-1) of each card, in order; heights unknown yet (0) fall back to round robin, so the first paint is stable. */
export function packColumns(heights: readonly number[], n: number, gap = 16): number[][] {
  const cols: number[][] = Array.from({ length: Math.max(1, n) }, () => []);
  if (cols.length === 1) return [heights.map((_, i) => i)];
  if (heights.some((h) => !(h > 0))) {
    heights.forEach((_, i) => cols[i % cols.length]!.push(i));
    return cols;
  }
  const k = cols.length;
  // Exhaustive search with pruning while it is small (10 cards, 3 columns: 59k leaves at most), else the greedy rule.
  if (k ** heights.length <= 200_000) {
    const sums = new Array<number>(k).fill(0);
    const pick = new Array<number>(heights.length).fill(0);
    let best: number[] | null = null;
    let bestMax = Infinity;
    let bestSpread = Infinity;
    const walk = (i: number) => {
      const max = Math.max(...sums);
      if (max > bestMax) return;
      if (i === heights.length) {
        const sp = max - Math.min(...sums);
        if (max < bestMax || sp < bestSpread) [best, bestMax, bestSpread] = [pick.slice(), max, sp];
        return;
      }
      const seen = new Set<number>();
      for (let c = 0; c < k; c++) {
        // Two columns of the same height are the same choice: try the left one only (fewer cases, and ties go left).
        if (seen.has(sums[c]!)) continue;
        seen.add(sums[c]!);
        pick[i] = c;
        sums[c]! += heights[i]! + gap;
        walk(i + 1);
        sums[c]! -= heights[i]! + gap;
      }
    };
    walk(0);
    (best ?? []).forEach((c, i) => cols[c]!.push(i));
    return cols;
  }
  const tall = cols.map(() => 0);
  heights.forEach((h, i) => {
    let at = 0;
    for (let c = 1; c < tall.length; c++) if (tall[c]! < tall[at]! - 1) at = c;
    cols[at]!.push(i);
    tall[at]! += h + gap;
  });
  return cols;
}

/** The tallest column's height minus the shortest's, for a packing. */
export function spread(heights: readonly number[], cols: readonly number[][], gap = 16): number {
  const sums = cols.map((c) => c.reduce((a, i) => a + (heights[i] ?? 0) + gap, 0));
  return Math.max(...sums) - Math.min(...sums);
}
