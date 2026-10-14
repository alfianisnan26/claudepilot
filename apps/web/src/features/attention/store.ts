import type { AttentionList } from '@portal/contracts';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { fetchAttention } from './api';

/**
 * What waits for the person, shared by the page, the nav badge and the app icon: one request, one copy. Loaded on first use, again on
 * each push of the live topic `attention` (an item appeared or was resolved), and once a minute only while the live socket is down.
 */
interface State {
  list: AttentionList | null;
  failed: boolean;
}

let state: State = { list: null, failed: false };
let seq = 0;
let started = false;
const listeners = new Set<() => void>();
const set = (next: State) => {
  state = next;
  for (const fn of listeners) fn();
};

export async function loadAttention(): Promise<void> {
  const mine = ++seq;
  try {
    const list = await fetchAttention({ limit: 200 });
    if (mine === seq) set({ list, failed: false });
  } catch {
    if (mine === seq) set({ list: state.list, failed: true });
  }
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** The list. Exactly one mounted `AttentionFeed` keeps it fresh; any number of readers share it. */
export function useAttention(): State & { reload: () => Promise<void> } {
  const s = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (started) return;
    started = true;
    void loadAttention();
  }, []);
  const reload = useCallback(() => loadAttention(), []);
  return { ...s, reload };
}

/** Signed out: forget everything. */
export function resetAttention() {
  seq++;
  started = false;
  set({ list: null, failed: false });
}
