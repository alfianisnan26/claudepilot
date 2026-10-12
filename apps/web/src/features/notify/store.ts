import type { NotifyOverview } from '@portal/contracts';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { notifyApi } from './api';

/**
 * The caller's notification overview, shared by the page, the nav and the onboarding checklist: one request, one copy.
 * `null` until the first answer; `failed` after a first load that did not work.
 */
interface State {
  overview: NotifyOverview | null;
  failed: boolean;
}

let state: State = { overview: null, failed: false };
let started = false;
let seq = 0;
const listeners = new Set<() => void>();

const set = (next: State) => {
  state = next;
  for (const fn of listeners) fn();
};

export async function loadNotifyOverview(): Promise<void> {
  const mine = ++seq;
  try {
    const overview = await notifyApi.overview();
    if (mine === seq) set({ overview, failed: false });
  } catch {
    if (mine === seq) set({ overview: state.overview, failed: state.overview === null });
  }
}

/** Replace a piece of the overview without a round trip (after a PATCH the server answered). */
export function patchOverview(fn: (o: NotifyOverview) => NotifyOverview) {
  if (state.overview) set({ overview: fn(state.overview), failed: false });
}

/** Forget everything (signed out): the next user starts empty. */
export function resetNotifyStore() {
  seq++;
  started = false;
  set({ overview: null, failed: false });
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** The overview, loaded once on first use. The onboarding checklist reads "this device has a push destination" from here. */
export function useNotifyOverview(): { overview: NotifyOverview | null; failed: boolean; reload: () => Promise<void> } {
  const s = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (started) return;
    started = true;
    void loadNotifyOverview();
  }, []);
  const reload = useCallback(() => loadNotifyOverview(), []);
  return { overview: s.overview, failed: s.failed, reload };
}
