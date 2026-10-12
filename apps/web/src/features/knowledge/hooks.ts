import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  data: T | null;
  error: Error | null;
  /** A load is in flight (the previous data stays until the new arrives). */
  loading: boolean;
  reload: () => Promise<void>;
  /** Replace what is shown without a request (after a change the caller made itself). */
  set: (value: T | null) => void;
}

/**
 * Loads once per `key` and again on `reload`. The data from the previous key stays on screen while the next
 * one loads, so lists don't flash; a stale answer (an older key finishing late) is dropped.
 */
export function useLoad<T>(key: string, load: () => Promise<T>, enabled = true): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: enabled });
  const latest = useRef(load);
  latest.current = load;
  const run = useRef(0);
  const reload = useCallback(async () => {
    const n = ++run.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await latest.current();
      if (n === run.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (n === run.current) setState((s) => ({ data: s.data, error: e instanceof Error ? e : new Error(String(e)), loading: false }));
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [key, enabled, reload]);
  const set = useCallback((value: T | null) => {
    run.current++;
    setState({ data: value, error: null, loading: false });
  }, []);
  return { ...state, reload, set };
}

/** `fn` after `ms` of quiet: the latest call wins, and `flush` runs a pending one now. */
export function useDebounced(fn: () => void, ms: number) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(fn);
  latest.current = fn;
  const pending = useRef(false);
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    pending.current = false;
  }, []);
  const call = useCallback(() => {
    clearTimeout(timer.current);
    pending.current = true;
    timer.current = setTimeout(() => {
      pending.current = false;
      latest.current();
    }, ms);
  }, [ms]);
  const flush = useCallback(() => {
    if (!pending.current) return;
    clearTimeout(timer.current);
    pending.current = false;
    latest.current();
  }, []);
  useEffect(() => cancel, [cancel]);
  return { call, flush, cancel };
}

/** Calls `fn` when the tab becomes visible again and every `ms` while it is. */
export function useRefresh(fn: () => void, ms: number, enabled = true) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const tick = () => document.visibilityState === 'visible' && latest.current();
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [ms, enabled]);
}

/** A small line diff (longest common subsequence) for showing what a version changed. Lines, not characters. */
export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

export function diffLines(before: string, after: string, limit = 4000): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > limit || b.length > limit) return null;
  // Trim the common head and tail first: most edits touch a small part.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const n = x.length;
  const m = y.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = x[i] === y[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push({ kind: 'del', text: x[i++]! });
    else out.push({ kind: 'add', text: y[j++]! });
  }
  while (i < n) out.push({ kind: 'del', text: x[i++]! });
  while (j < m) out.push({ kind: 'add', text: y[j++]! });
  for (const text of a.slice(a.length - tail)) out.push({ kind: 'same', text });
  return out;
}
