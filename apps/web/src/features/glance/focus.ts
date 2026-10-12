import { useEffect, useSyncExternalStore } from 'react';
import type { GlanceFocus } from './types';

// What the person is looking at. A page publishes it while it is mounted (`useGlanceFocus`), the frame reads it for every
// widget (`useGlanceFocusValue`). A tiny external store, so the header, the dock and the composer strip all agree.

const NONE: GlanceFocus = { sessionId: null, claudeId: null, workspaceId: null };
let current: GlanceFocus = NONE;
const listeners = new Set<() => void>();

const same = (a: GlanceFocus, b: GlanceFocus) => a.sessionId === b.sessionId && a.claudeId === b.claudeId && a.workspaceId === b.workspaceId;

function publish(next: GlanceFocus) {
  if (same(current, next)) return;
  current = next;
  listeners.forEach((fn) => fn());
}

/** The session page calls this with its session: the Quota widget then follows that session's Claude. Cleared on unmount. */
export function useGlanceFocus(focus: Partial<GlanceFocus> | null): void {
  const sessionId = focus?.sessionId ?? null;
  const claudeId = focus?.claudeId || null;
  const workspaceId = focus?.workspaceId ?? null;
  useEffect(() => {
    if (!sessionId && !claudeId && !workspaceId) return;
    publish({ sessionId, claudeId, workspaceId });
    return () => publish(NONE);
  }, [sessionId, claudeId, workspaceId]);
}

export function useGlanceFocusValue(): GlanceFocus {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => current,
    () => NONE,
  );
}
