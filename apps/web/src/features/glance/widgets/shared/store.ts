import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { GLANCE_API, type GlanceSnapshot } from '@portal/contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from '@/lib/api';
import { useLive, useLiveConnected } from '@/lib/live';

/**
 * One copy of the glance snapshot for every place that shows it (the header, the dock, the Sessions list, the composer strip and the
 * app badge each call a widget's hook): the portal is asked once however many of them are on screen, and the live topic `glance`
 * says when to ask again. No polling of its own (docs/prd/glance-widgets.md §4).
 */
interface Snap {
  data: GlanceSnapshot | null;
  /** The last request failed (the previous data, if any, is kept and shown as old). */
  failed: boolean;
  /** The portal refused it (403): not a failure to try again. */
  denied: boolean;
  loadedAt: number;
}

let snap: Snap = { data: null, failed: false, denied: false, loadedAt: 0 };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

/** A copy this young is not asked for again by a component that only mounted. */
const FRESH_MS = 15_000;
/** Without the live socket nothing says the data is current; after this long it is shown as old. */
export const STALE_AFTER_MS = 45_000;

const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

async function fetchSnapshot(): Promise<GlanceSnapshot> {
  let res: Response;
  try {
    res = await fetch(GLANCE_API.snapshot, { credentials: 'same-origin' });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<GlanceSnapshot>(json)) return json.data;
  if (res.status === 401) void api.adminState().catch(() => undefined);
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

/** Loads the snapshot (one request at a time, however many ask). */
export function reloadGlance(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchSnapshot()
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
}

export interface GlanceState {
  data: GlanceSnapshot | null;
  /** Nothing could be loaded (and nothing was before). */
  failed: boolean;
  /** The portal said this person may not see it (multi-user): not something to retry. */
  denied: boolean;
  /** What is shown is old: a failed refresh, or the live socket has been down a while. */
  stale: boolean;
  reload: () => Promise<void>;
}

/** The snapshot, kept fresh: loaded on first use, again on each `glance` push and after the live socket comes back. */
export function useGlance(): GlanceState {
  const s = useSyncExternalStore(subscribe, () => snap);
  const connected = useLiveConnected();
  useLive('glance', () => void reloadGlance());
  useEffect(() => {
    if (!snap.data || Date.now() - snap.loadedAt > FRESH_MS) void reloadGlance();
  }, []);
  useEffect(() => {
    // The socket came back: whatever changed meanwhile was not pushed.
    if (connected && Date.now() - snap.loadedAt > 5_000) void reloadGlance();
  }, [connected]);
  // While the socket is down, the reading turns old after a while: a timer flips it, since nothing else would render again.
  const [, tick] = useState(0);
  useEffect(() => {
    if (connected) return;
    const t = window.setTimeout(() => tick((n) => n + 1), STALE_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [connected]);
  const old = !connected && s.loadedAt > 0 && Date.now() - s.loadedAt > STALE_AFTER_MS;
  return { data: s.data, failed: s.failed && !s.data, denied: s.denied && !s.data, stale: (s.failed && !!s.data) || old, reload: reloadGlance };
}
