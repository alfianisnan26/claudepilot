import { useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';

// A live list must never move what is under the person's pointer or focus (QA standard A9): a row that jumps as a request is answered
// somewhere else is how a person presses Allow on the wrong one. `steady` keeps a list in place while it is being used.

export interface SteadyRow<T> {
  row: T;
  /** It left the list while the person was using it: kept where it was, to be dimmed and inert, until they let go. */
  gone: boolean;
}

/**
 * The rows to draw. Not `engaged` (no pointer over the list, no focus inside): the list as it is now. Engaged: rows keep the order they had;
 * one still in the list is updated in place, one that left stays where it was as `gone`, and a new one goes to the end, or is held back
 * until the person lets go (`defer`, for a tree whose rows belong under a parent). Pure, so the movement can be checked by hand.
 */
export function steady<T>(prev: readonly SteadyRow<T>[], next: readonly T[], key: (t: T) => string, engaged: boolean, defer = false): SteadyRow<T>[] {
  if (!engaged) return next.map((row) => ({ row, gone: false }));
  const fresh = new Map(next.map((r) => [key(r), r]));
  const out: SteadyRow<T>[] = prev.map((p) => {
    const now = fresh.get(key(p.row));
    return now ? { row: now, gone: false } : { row: p.row, gone: true };
  });
  // With nothing drawn yet there is nothing to protect: a list that was empty shows what arrives.
  if (!defer || prev.length === 0) {
    const had = new Set(prev.map((p) => key(p.row)));
    for (const r of next) if (!had.has(key(r))) out.push({ row: r, gone: false });
  }
  return out;
}

/** Whether the pointer is over the list or focus is inside it, and the props that tell. */
export function useEngaged() {
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const bind = useMemo(
    () => ({
      onPointerEnter: () => setPointer(true),
      onPointerLeave: () => setPointer(false),
      onFocus: () => setFocus(true),
      onBlur: (e: FocusEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
      },
    }),
    [],
  );
  return { engaged: pointer || focus, bind };
}

/** `steady` as a hook: it remembers what it drew last. `key` must be stable (a module-level function). */
export function useSteadyRows<T>(rows: readonly T[], key: (t: T) => string, engaged: boolean, defer = false): SteadyRow<T>[] {
  const drawn = useRef<SteadyRow<T>[]>([]);
  const out = useMemo(() => steady(drawn.current, rows, key, engaged, defer), [rows, key, engaged, defer]);
  useEffect(() => {
    drawn.current = out;
  }, [out]);
  return out;
}

/** Whether two lists of ids are the same ids in the same order. */
export const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** How long what answers or stops stays inert after a list changes under it (the session's approval card ignores input for 500 ms the same way). */
export const SETTLE_MS = 500;

/**
 * True for a moment after the ids change (not on the first render): the buttons that answer a request or stop an agent are off, so a press
 * aimed at a row that has just moved cannot land on another. Decided while rendering, so there is no frame in between.
 */
export function useSettling(ids: readonly string[], ms = SETTLE_MS): boolean {
  const [, tick] = useState(0);
  const last = useRef<readonly string[]>(ids);
  const changedAt = useRef(0);
  if (!sameIds(last.current, ids)) {
    last.current = ids;
    changedAt.current = Date.now();
  }
  const left = changedAt.current > 0 ? ms - (Date.now() - changedAt.current) : 0;
  const settling = left > 0;
  useEffect(() => {
    if (!settling) return;
    const t = window.setTimeout(() => tick((n) => n + 1), left + 20);
    return () => window.clearTimeout(t);
  }, [settling, left]);
  return settling;
}
