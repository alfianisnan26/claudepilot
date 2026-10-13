import { useEffect, useState } from 'react';

/** The visual viewport, which shrinks under the on-screen keyboard while the layout viewport doesn't. */
export interface VisualViewportBox {
  height: number;
  top: number;
  /** The on-screen keyboard is up. */
  keyboard: boolean;
}

/** How much shorter than the full screen the visible area must be for the keyboard to count as up. */
const KEYBOARD_MIN = 120;

/**
 * The tallest the visible area has been at this width (a turn of the phone starts over). The keyboard
 * is measured against it rather than against the window: in an installed iOS app the window can shrink
 * with the keyboard too, so comparing the two would never see it.
 */
let full = { width: 0, height: 0 };

const typing = () => {
  const el = document.activeElement;
  return !!el && (el.matches('input, textarea, select') || (el as HTMLElement).isContentEditable);
};

/** A phone or tablet without a mouse: focusing a field there brings up the on-screen keyboard. */
const touchFirst = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/**
 * Whether the on-screen keyboard is up: a field has focus and the visible area is well short of the
 * full screen. With `onFocus`, on a touch screen a focused field is enough, whatever the sizes say
 * (iOS reports them differently from one version and mode to the next).
 */
function keyboardUp(vv: VisualViewport, onFocus = false): boolean {
  if (Math.abs(vv.width - full.width) > 1) full = { width: vv.width, height: Math.max(vv.height, window.innerHeight) };
  full.height = Math.max(full.height, vv.height);
  return typing() && ((onFocus && touchFirst()) || full.height - vv.height > KEYBOARD_MIN);
}

/** The on-screen keyboard is up, by the visible area shrinking (a hardware keyboard doesn't shrink it). */
export function viewportKeyboard(): boolean {
  const vv = window.visualViewport;
  return !!vv && keyboardUp(vv);
}

/**
 * The visual viewport's size and offset, at most once a frame. A full-screen page sized and moved to
 * it keeps its header in view and its bottom bar above the keyboard, on iOS too, where the keyboard
 * scrolls the page instead of resizing it.
 */
export function useVisualViewport(opts: { keyboardOnFocus?: boolean } = {}): VisualViewportBox | null {
  const onFocus = opts.keyboardOnFocus === true;
  const [box, setBox] = useState<VisualViewportBox | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBox({ height: vv.height, top: vv.offsetTop, keyboard: keyboardUp(vv, onFocus) }));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    // Focus moves before the keyboard animates in or out: measure again then too.
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, [onFocus]);
  return box;
}

/**
 * Inline style that pins a `fixed inset-x-0 top-0` page to the visual viewport (none until it's known). It follows the viewport's
 * offset only while the keyboard is up (iOS scrolls the page to keep the field in view). Otherwise the offset is just the page
 * rubber-banding under a finger, and following it dragged the whole session screen up and down with every swipe on its header.
 */
export const pinnedToViewport = (box: VisualViewportBox | null) =>
  box ? { height: box.height, ...(box.keyboard ? { transform: `translateY(${box.top}px)` } : null) } : undefined;
