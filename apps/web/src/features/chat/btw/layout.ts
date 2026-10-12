import { useMediaQuery } from '@isnanme/ui';
import { useCallback, useEffect, useState, type RefObject } from 'react';
import { currentUserId } from '@/features/glance/user';

/** The chat column never gets narrower than this because of the side panel. */
export const MIN_COLUMN = 560;
export const PANEL_MIN = 300;
export const PANEL_MAX = 560;
const PANEL_DEFAULT = 380;

export type BtwMode = 'card' | 'panel' | 'sheet';

interface Pref {
  /** The person chose the side panel on this device. */
  side: boolean;
  width: number;
}

// Remembered per device AND per person (a shared browser keeps two people's choices apart).
const key = () => `claudepilot.btw.${currentUserId()}`;
const load = (): Pref => {
  try {
    const v = JSON.parse(localStorage.getItem(key()) ?? 'null') as Partial<Pref> | null;
    return { side: v?.side === true, width: Math.min(PANEL_MAX, Math.max(PANEL_MIN, Number(v?.width) || PANEL_DEFAULT)) };
  } catch {
    return { side: false, width: PANEL_DEFAULT };
  }
};

/**
 * Where the btw lives: a phone gets the bottom sheet; everything else the card above the composer; from 1280 px the person may expand it into a
 * side panel (resizable, remembered), offered only while the row leaves the chat column its minimum width, and handed back to the card by
 * itself when it does not.
 */
export function useBtwLayout(row: RefObject<HTMLElement | null>) {
  const wide = useMediaQuery('(min-width: 1280px)');
  const phone = useMediaQuery('(max-width: 639px)');
  const [pref, setPref] = useState(load);
  const [rowWidth, setRowWidth] = useState(0);

  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRowWidth(el.clientWidth));
    ro.observe(el);
    setRowWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [row]);

  const maxWidth = Math.max(PANEL_MIN, Math.min(PANEL_MAX, rowWidth - MIN_COLUMN));
  const canSide = wide && !phone && rowWidth >= MIN_COLUMN + PANEL_MIN;
  const width = Math.min(pref.width, maxWidth);
  const mode: BtwMode = phone ? 'sheet' : pref.side && canSide ? 'panel' : 'card';

  const save = useCallback((next: Pref) => {
    setPref(next);
    try {
      localStorage.setItem(key(), JSON.stringify(next));
    } catch {
      // private mode: the choice just isn't remembered
    }
  }, []);
  const setSide = useCallback((side: boolean) => save({ ...pref, side }), [pref, save]);
  const setWidth = useCallback((w: number) => save({ ...pref, width: Math.round(Math.min(maxWidth, Math.max(PANEL_MIN, w))) }), [pref, save, maxWidth]);
  return { mode, canSide, width, maxWidth, setSide, setWidth };
}
