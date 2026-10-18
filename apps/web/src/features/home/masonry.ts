// Home's dashboard columns (owner, 2026-10-18: "fix the dynamic dashboard layout without his silly gaps"): a CSS grid gives each ROW the
// height of its tallest card, so a short card leaves a hole under it. Instead each column is its own stack, and each card, in the person's
// order, goes to the column that is shortest so far (the usual masonry rule), so the stacks end at about the same height.

/** The column (0..n-1) of each card, in order; heights unknown yet (0) fall back to round robin, so the first paint is stable. */
export function packColumns(heights: readonly number[], n: number, gap = 16): number[][] {
  const cols: number[][] = Array.from({ length: Math.max(1, n) }, () => []);
  if (cols.length === 1) return [heights.map((_, i) => i)];
  if (heights.some((h) => !(h > 0))) {
    heights.forEach((_, i) => cols[i % cols.length]!.push(i));
    return cols;
  }
  const tall = cols.map(() => 0);
  heights.forEach((h, i) => {
    let best = 0;
    for (let c = 1; c < tall.length; c++) if (tall[c]! < tall[best]! - 1) best = c;
    cols[best]!.push(i);
    tall[best]! += h + gap;
  });
  return cols;
}

/** The tallest column's height minus the shortest's, for a packing. */
export function spread(heights: readonly number[], cols: readonly number[][], gap = 16): number {
  const sums = cols.map((c) => c.reduce((a, i) => a + (heights[i] ?? 0) + gap, 0));
  return Math.max(...sums) - Math.min(...sums);
}
