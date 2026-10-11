import { useEffect, useState } from 'react';

/** The visual viewport, which shrinks under the on-screen keyboard while the layout viewport doesn't. */
export interface VisualViewportBox {
  height: number;
  top: number;
  /** The on-screen keyboard is up. */
  keyboard: boolean;
}

/** The on-screen keyboard is up when the visual viewport is well short of the layout viewport. */
export function viewportKeyboard(): boolean {
  const vv = window.visualViewport;
  return !!vv && vv.height < window.innerHeight * 0.85;
}

/**
 * The visual viewport's size and offset, at most once a frame. A full-screen page sized and moved to
 * it keeps its header in view and its bottom bar above the keyboard, on iOS too, where the keyboard
 * scrolls the page instead of resizing it.
 */
export function useVisualViewport(): VisualViewportBox | null {
  const [box, setBox] = useState<VisualViewportBox | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBox({ height: vv.height, top: vv.offsetTop, keyboard: viewportKeyboard() }));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return box;
}

/** Inline style that pins a `fixed inset-x-0 top-0` page to the visual viewport (none until it's known). */
export const pinnedToViewport = (box: VisualViewportBox | null) =>
  box ? { height: box.height, transform: `translateY(${box.top}px)` } : undefined;
