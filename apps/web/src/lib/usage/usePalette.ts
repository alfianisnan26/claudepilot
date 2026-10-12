import type { PaletteKind, PaletteSlot, UsagePalette } from '@portal/contracts';
import { useEffect, useSyncExternalStore } from 'react';
import { usageApi } from './api';

/**
 * One copy of the palette assignments for every place that draws a Claude or a model: the portal is asked once however many are on
 * screen. A key the copy does not know (a Claude or model first seen since) asks again, at most every 30 seconds.
 */
let snap: UsagePalette | null = null;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let loadedAt = 0;
const MISS_EVERY_MS = 30_000;
const STALE_MS = 5 * 60_000;

const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** Loads the assignments (one request at a time). A failure keeps what there was: a colour never disappears because a refresh failed. */
export function reloadPalette(): Promise<void> {
  if (inflight) return inflight;
  inflight = usageApi
    .palette()
    .then(
      (next) => {
        snap = next;
        loadedAt = Date.now();
      },
      () => {
        loadedAt = Date.now() - STALE_MS + MISS_EVERY_MS; // try again after the miss interval, not at once
      },
    )
    .finally(() => {
      inflight = null;
      emit();
    });
  return inflight;
}

/** A key's slot: a number, null (no colour left: grey), or undefined while it is not known. */
export function slotOf(p: UsagePalette | null, kind: PaletteKind, key: string | null | undefined): PaletteSlot | undefined {
  if (!p || !key) return undefined;
  const table = kind === 'claude' ? p.claudes : p.models;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** The palette assignments, loaded on first use and kept; null until they arrive. */
export function useUsagePalette(): UsagePalette | null {
  const p = useSyncExternalStore(subscribe, () => snap);
  useEffect(() => {
    if (!snap || Date.now() - loadedAt > STALE_MS) void reloadPalette();
  }, []);
  return p;
}

/**
 * The slot of one Claude (by id; `default:<workspaceId>` for requests recorded without one) or one model, for a chip or a dot. Draw it
 * with `slotColor(slot)`: undefined (not loaded, not known) and null (no colour left) both draw the neutral grey.
 */
export function useSlot(kind: PaletteKind, key: string | null | undefined): PaletteSlot | undefined {
  const p = useUsagePalette();
  const slot = slotOf(p, kind, key);
  const missing = !!p && !!key && slot === undefined;
  useEffect(() => {
    if (missing && Date.now() - loadedAt > MISS_EVERY_MS) void reloadPalette();
  }, [missing, key]);
  return slot;
}
