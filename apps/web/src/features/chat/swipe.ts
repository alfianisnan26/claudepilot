// A row swiped sideways on a touch screen (Sessions list, chat PRD FR2): right reveals Pin, left reveals Archive; past the threshold the
// release does it, short of it the row snaps back. The gesture is an addition to the row's ⋯ menu, never the only way. The rules are
// pure (tested); the hook turns pointer events into them. Vertical scrolling wins: the axis is decided once by the first movement, and
// `touch-action: pan-y` on the row lets the browser take a vertical drag (it then cancels our pointer). The page never scrolls sideways:
// the row moves by transform inside an `overflow-hidden` box.
import { useCallback, useRef, useState } from 'react';

/** How far the row must travel for the release to act. */
export const SWIPE_THRESHOLD = 72;
/** The farthest the row travels (past the threshold it drags with resistance). */
export const SWIPE_MAX = 104;
/** The first movement decides the axis: shorter than this, nothing is decided yet. */
export const AXIS_LOCK = 8;

export interface SwipeState {
  pointerId: number;
  x0: number;
  y0: number;
  /** The row's travel: negative to the left. */
  dx: number;
  axis: 'none' | 'x' | 'y';
}

export const swipeStart = (pointerId: number, x: number, y: number): SwipeState => ({ pointerId, x0: x, y0: y, dx: 0, axis: 'none' });

/** The travel for a raw horizontal distance: full until the threshold, then a quarter of the rest, never past {@link SWIPE_MAX}. */
export function swipeTravel(raw: number): number {
  const sign = raw < 0 ? -1 : 1;
  const d = Math.abs(raw);
  const eased = d <= SWIPE_THRESHOLD ? d : SWIPE_THRESHOLD + (d - SWIPE_THRESHOLD) / 4;
  return sign * Math.min(SWIPE_MAX, eased);
}

/** A pointer move: decides the axis on the first clear movement; on the horizontal axis the row follows. */
export function swipeMove(s: SwipeState, x: number, y: number): SwipeState {
  const ddx = x - s.x0;
  const ddy = y - s.y0;
  if (s.axis === 'none') {
    if (Math.abs(ddx) < AXIS_LOCK && Math.abs(ddy) < AXIS_LOCK) return s;
    return { ...s, axis: Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y' };
  }
  if (s.axis === 'y') return s;
  return { ...s, dx: swipeTravel(ddx) };
}

/** What a release does: past the threshold to the right, `right`; to the left, `left`; else nothing. */
export const swipeOutcome = (s: SwipeState): 'left' | 'right' | null => (s.axis !== 'x' ? null : s.dx >= SWIPE_THRESHOLD ? 'right' : s.dx <= -SWIPE_THRESHOLD ? 'left' : null);

export interface RowSwipe {
  /** The row's travel to render (`translateX`); 0 at rest. */
  dx: number;
  /** A finger is on it (no transition while it follows). */
  dragging: boolean;
  /** Past the threshold: the pane says it will act. */
  armed: 'left' | 'right' | null;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
}

/** The gesture on one row: touch pointers only (a mouse has the menu); `onLeft` and `onRight` run on a release past the threshold. */
export function useRowSwipe({ onLeft, onRight, enabled = true }: { onLeft?: () => void; onRight?: () => void; enabled?: boolean }): RowSwipe {
  const state = useRef<SwipeState | null>(null);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const end = useCallback(
    (e: React.PointerEvent, act: boolean) => {
      const s = state.current;
      if (!s || s.pointerId !== e.pointerId) return;
      state.current = null;
      setDragging(false);
      setDx(0);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // already released
      }
      if (!act) return;
      const out = swipeOutcome(s);
      if (out === 'left') onLeft?.();
      else if (out === 'right') onRight?.();
    },
    [onLeft, onRight],
  );
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled || e.pointerType !== 'touch' || !e.isPrimary || state.current) return;
      state.current = swipeStart(e.pointerId, e.clientX, e.clientY);
    },
    [enabled],
  );
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const s = state.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const next = swipeMove(s, e.clientX, e.clientY);
    if (next === s) return;
    if (s.axis === 'none' && next.axis === 'x') {
      setDragging(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // a pointer already gone
      }
    }
    state.current = next;
    if (next.axis === 'x') setDx(next.dx);
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent) => end(e, true), [end]);
  const onPointerCancel = useCallback((e: React.PointerEvent) => end(e, false), [end]);
  const armed = dx >= SWIPE_THRESHOLD ? 'right' : dx <= -SWIPE_THRESHOLD ? 'left' : null;
  return { dx, dragging, armed, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } };
}
