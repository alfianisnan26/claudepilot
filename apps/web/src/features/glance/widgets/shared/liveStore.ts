import type { LiveMessage, LiveTopic } from '@portal/contracts';
import { useEffect, useSyncExternalStore } from 'react';
import { ApiError } from '@/lib/api';
import { useLive, useLiveConnected } from '@/lib/live';

// One shared copy of something the portal answers, for every chip and card that shows it (the pattern of `useGlance` and
// `useClaudeUsage`): loaded on first use, again when one of its live topics says so and when the live socket comes back. No timer
// asks the portal anything (docs/prd/glance-widgets.md G3).

export interface LiveReading<T> {
  data: T | null;
  /** Nothing could be loaded (and nothing was before). */
  failed: boolean;
  /** The portal refused it (403): not something to retry. */
  denied: boolean;
  /** What is shown is from before a failed refresh. */
  stale: boolean;
  reload: () => Promise<void>;
}

interface Snap<T> {
  data: T | null;
  failed: boolean;
  denied: boolean;
  loadedAt: number;
}

/** A copy this young is not asked for again by a component that only mounted. */
const FRESH_MS = 15_000;

export interface LiveStoreOptions<T> {
  /** Reads it (given what is held now, so a part a push keeps fresh is not thrown away). */
  load: (prev: T | null) => Promise<T>;
  /** Topics whose push means "load again". */
  topics: readonly LiveTopic[];
  /** A topic whose push carries the data itself (`workspaces`, `usage`): fold it in without asking the portal. Null: load again. */
  apply?: (msg: LiveMessage, prev: T | null) => T | null;
}

export function createLiveStore<T>(opts: LiveStoreOptions<T>): { use: () => LiveReading<T>; reload: () => Promise<void>; reset: () => void } {
  let snap: Snap<T> = { data: null, failed: false, denied: false, loadedAt: 0 };
  let inflight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  };
  const reload = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = opts
      .load(snap.data)
      .then(
        (data) => {
          snap = { data, failed: false, denied: false, loadedAt: Date.now() };
        },
        (e: unknown) => {
          snap = { ...snap, failed: true, denied: e instanceof ApiError && e.status === 403 };
        },
      )
      .finally(() => {
        inflight = null;
        emit();
      });
    return inflight;
  };
  const onPush = (msg: LiveMessage) => {
    const next = opts.apply?.(msg, snap.data) ?? null;
    if (next === null) return void reload();
    snap = { ...snap, data: next, loadedAt: snap.loadedAt || Date.now() };
    emit();
  };
  const reset = () => {
    snap = { data: null, failed: false, denied: false, loadedAt: 0 };
    emit();
  };

  function use(): LiveReading<T> {
    const s = useSyncExternalStore(subscribe, () => snap);
    const connected = useLiveConnected();
    // Hooks in a fixed order: one subscription per possible topic, switched on for the ones this store listens to.
    useLive('workspaces', onPush, opts.topics.includes('workspaces'));
    useLive('usage', onPush, opts.topics.includes('usage'));
    useLive('tickets', onPush, opts.topics.includes('tickets'));
    useLive('ci', onPush, opts.topics.includes('ci'));
    useLive('claudeusage', onPush, opts.topics.includes('claudeusage'));
    useLive('autotransfer', onPush, opts.topics.includes('autotransfer'));
    useLive('keepgoing', onPush, opts.topics.includes('keepgoing'));
    useEffect(() => {
      if (!snap.data || Date.now() - snap.loadedAt > FRESH_MS) void reload();
    }, []);
    useEffect(() => {
      // The socket came back: whatever changed meanwhile was not pushed.
      if (connected && snap.loadedAt > 0 && Date.now() - snap.loadedAt > 5_000) void reload();
    }, [connected]);
    return { data: s.data, failed: s.failed && !s.data, denied: s.denied && !s.data, stale: s.failed && !!s.data, reload };
  }

  return { use, reload, reset };
}
