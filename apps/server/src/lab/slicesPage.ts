// One page of the lab's slices for `GET /api/lab/slices` (D-58, T-382 S4). The views are derived in memory (outcomes, sizes and arms come from
// tickets and experiments, not from one table), so the keyset is applied over the derived list: newest start first, then the session and slice id
// as the unique tie-break. The cursor is the shared signed one (store/keyset.ts), bound to a scope the route builds from the caller and every
// filter value, so a forged cursor, one from another filter and one from another caller are all a 400.

import type { LabSlicePage, LabSliceView } from '@portal/contracts';
import { clampLimit, cursorAfter, decodeCursor } from '../store/keyset.js';

const startOf = (v: LabSliceView): number => v.startMs ?? 0;
const keyOf = (v: LabSliceView): string => `${v.sessionId}\u0000${v.sliceId}`;

/** `rows` are the caller's own view of the slices (already filtered to what the caller may read); `scope` names the caller and the filters. */
export function slicesPage(rows: readonly LabSliceView[], args: { scope: string; cursor?: string | undefined; limit?: unknown }): LabSlicePage {
  const limit = clampLimit(args.limit);
  const sorted = [...rows].sort((x, y) => startOf(y) - startOf(x) || (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0));
  let from = 0;
  if (args.cursor) {
    const at = decodeCursor(args.cursor, args.scope);
    const k = typeof at.sort === 'number' ? at.sort : Number.NaN;
    from = sorted.findIndex((v) => startOf(v) < k || (startOf(v) === k && keyOf(v) > String(at.id)));
    if (Number.isNaN(k)) from = sorted.length;
    if (from < 0) from = sorted.length;
  }
  const items = sorted.slice(from, from + limit);
  const last = items[items.length - 1];
  const next = from + limit < sorted.length && last ? cursorAfter(args.scope, startOf(last), keyOf(last)) : null;
  return { items, next, ...(args.cursor ? {} : { total: sorted.length }) };
}
