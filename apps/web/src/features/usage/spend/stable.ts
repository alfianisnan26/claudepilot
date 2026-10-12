// A list that updates while it is on screen must not move what the person is looking at (QA standard A9). The rows keep the order they had; rows that
// are new go after them. A reload on purpose (a new window, a saved budget) starts the order again from the sort. Pure, so it is tested.

/** `rows` in the order of `previous` for the keys that are still there, then the ones that were not, in the order `rows` gave them. */
export function stableOrder<T>(rows: readonly T[], keyOf: (row: T) => string, previous: readonly string[]): T[] {
  const place = new Map(previous.map((k, i) => [k, i]));
  const known = rows.filter((r) => place.has(keyOf(r))).sort((a, b) => place.get(keyOf(a))! - place.get(keyOf(b))!);
  const fresh = rows.filter((r) => !place.has(keyOf(r)));
  return [...known, ...fresh];
}
