import { useSyncExternalStore } from 'react';

// Whether the quick-search palette is open: one flag for the whole app, so the key listener, the chip and the Settings row agree.
let open = false;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const set = (next: boolean) => {
  if (open === next) return;
  open = next;
  listeners.forEach((fn) => fn());
};

export const openPalette = () => set(true);
export const closePalette = () => set(false);
export const togglePalette = () => set(!open);
export const usePaletteOpen = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
