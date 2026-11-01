// Who is signed in (`GET /api/me`), once per page load and shared: the account menu and the Profile read it, the Profile writes it back
// after a change, sign-out clears it. Null while loading or when the answer did not come (the menu then shows a neutral line, never a guess).

import type { SignedInAs } from '@portal/contracts';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';

let current: SignedInAs | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function setMe(me: SignedInAs | null): void {
  current = me;
  emit();
}

/** Asks again (after a change elsewhere); one request at a time. */
export function reloadMe(): Promise<void> {
  loading ??= api
    .me()
    .then(setMe, () => undefined)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Forgets it (sign-out): the next person's menu never shows the last one's name. */
export const resetMe = () => setMe(null);

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** The signed-in person; loads on first use. */
export function useMe(): SignedInAs | null {
  const me = useSyncExternalStore(subscribe, () => current, () => current);
  useEffect(() => {
    if (!current) void reloadMe();
  }, []);
  return me;
}
