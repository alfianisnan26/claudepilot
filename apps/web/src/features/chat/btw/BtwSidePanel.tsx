import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef } from 'react';
import { PANEL_MAX, PANEL_MIN } from './layout';

/** The wide desktop's btw: a panel on the right of the row (not a second chat), resizable by its left edge (drag, or the arrow keys), closed with the card's Close. */
export function BtwSidePanel({ width, maxWidth, onResize, children }: { width: number; maxWidth: number; onResize: (w: number) => void; children: ReactNode }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const down = (e: PointerEvent) => {
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => drag.current && onResize(drag.current.w + (drag.current.x - e.clientX));
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') onResize(width + step);
    else if (e.key === 'ArrowRight') onResize(width - step);
    else return;
    e.preventDefault();
  };
  return (
    <aside
      aria-label="btw"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-line bg-surface pt-[var(--safe-top)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize btw"
        aria-valuemin={PANEL_MIN}
        aria-valuemax={maxWidth || PANEL_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={key}
        className="absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none outline-hidden after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 hover:after:bg-line focus-visible:after:bg-accent"
      />
      <div className="min-h-0 flex-1">{children}</div>
    </aside>
  );
}
