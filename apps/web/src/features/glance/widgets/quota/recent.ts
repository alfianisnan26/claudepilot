import { useEffect, useSyncExternalStore } from 'react';
import { chatApi } from '@/features/chat/api';
import { useLive } from '@/lib/live';
import { recentClaudeOf } from './quota';

// "The Claude used most recently": the one whose open session was last active. One copy for every Quota chip; it is read when
// the first chip needs it (the open session's Claude needs no list at all), again when the portal says a usage reading came in
// (the live topic `claudeusage`, at most every 30 s) and when the tab comes back to the front after a minute away. Nothing polls.

let recent: string | null = null;
let loadedAt = 0;
let inflight = false;
const listeners = new Set<() => void>();

function load(minAgeMs: number) {
  if (inflight || Date.now() - loadedAt < minAgeMs) return;
  inflight = true;
  chatApi
    .list()
    .then(
      (sessions) => {
        const next = recentClaudeOf(sessions);
        loadedAt = Date.now();
        if (next !== recent) {
          recent = next;
          listeners.forEach((fn) => fn());
        }
      },
      () => undefined,
    )
    .finally(() => {
      inflight = false;
    });
}

/** The id of the Claude used most recently, or null until known. `enabled` false (a session is open) asks the portal for nothing. */
export function useRecentClaudeId(enabled: boolean): string | null {
  const id = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => recent,
    () => null,
  );
  useEffect(() => {
    if (!enabled) return;
    load(60_000);
    const onVisible = () => document.visibilityState === 'visible' && load(60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled]);
  useLive('claudeusage', () => load(30_000), enabled);
  return id;
}
