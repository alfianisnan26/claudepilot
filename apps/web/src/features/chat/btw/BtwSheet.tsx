import { cn } from '@isnanme/ui';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';

const CLOSE_PX = 90;
const STEP_PX = 60;

/**
 * The phone's btw: a bottom sheet above the composer (the composer stays in reach, so a follow-up is one tap), half the screen high, dragged
 * up to full height (never over the header), dragged down or Esc to close. With the keyboard up it stays at half. It overlays the transcript
 * without changing its size, so the transcript's scroll is untouched.
 */
export function BtwSheet({ bottom, keyboard, onClose, children }: { bottom: number; keyboard: boolean; onClose: () => void; children: ReactNode }) {
  const [full, setFull] = useState(false);
  const [dy, setDy] = useState(0);
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const expanded = full && !keyboard;

  useEffect(() => {
    if (keyboard) setFull(false);
  }, [keyboard]);

  const down = (e: PointerEvent) => {
    drag.current = { y: e.clientY, moved: false };
    dragged.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const delta = e.clientY - d.y;
    if (Math.abs(delta) > 4) d.moved = true;
    setDy(Math.max(delta, expanded ? -STEP_PX : -STEP_PX * 2));
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) return setDy(0); // a tap: the click that follows toggles
    dragged.current = true;
    if (dy > CLOSE_PX && !expanded) onClose();
    else if (dy > STEP_PX) setFull(false);
    else if (dy < -STEP_PX) setFull(true);
    setDy(0);
  };

  return (
    <div
      data-btw-sheet={expanded ? 'full' : 'half'}
      style={{
        bottom,
        height: expanded ? '100%' : '50%',
        maxHeight: `calc(100% - ${bottom}px - 3.5rem - env(safe-area-inset-top))`,
        transform: dy ? `translateY(${Math.max(0, dy)}px)` : undefined,
      }}
      className={cn('btw-sheet absolute inset-x-0 z-30 flex flex-col rounded-t-2xl border border-b-0 border-line bg-surface shadow-lift', dy === 0 && 'transition-none')}
    >
      <button
        type="button"
        aria-label={expanded ? 'Smaller' : 'Taller'}
        onClick={() => (dragged.current ? (dragged.current = false) : setFull((v) => !v))}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          drag.current = null;
          setDy(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setFull(true);
          else if (e.key === 'ArrowDown') (full ? setFull(false) : onClose());
        }}
        className="flex h-6 w-full shrink-0 touch-none items-center justify-center rounded-t-2xl text-muted tap:h-8"
      >
        <span aria-hidden="true" className="h-1 w-10 rounded-full bg-line" />
      </button>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
