// On a phone the kit's Dialog is a bottom sheet whose header and grab bar start a drag: the whole sheet follows the finger and a long enough
// drag dismisses it. Here the header and the bar must stay put (a drag that starts on them moved the sheet unexpectedly): only the content
// inside the sheet scrolls, and the sheet closes with its ×, Esc or a tap outside. The kit starts the drag from a pointerdown on those two
// zones, so this stops that event before it gets there. (The proper home for this is a `draggable` option in @isnanme/ui's Dialog.)

/** The kit's phone-only drag zones: the grab bar and the header (both `touch-none`, the bar also `cursor-grab`). */
export const SHEET_DRAG_ZONES = '[role="dialog"][aria-modal="true"] > header.touch-none, [role="dialog"][aria-modal="true"] > div.touch-none.cursor-grab';

interface Target {
  closest?(selector: string): unknown;
}

/** Whether a pointerdown started in one of the sheet's drag zones. */
export function startsSheetDrag(target: unknown): boolean {
  const t = target as Target | null;
  return !!t && typeof t.closest === 'function' && !!t.closest(SHEET_DRAG_ZONES);
}

/** Listens for the rest of the page's life (capture phase, ahead of React); returns a function that stops it. */
export function installNoSheetDrag(doc: Document = document): () => void {
  const stop = (e: Event) => {
    if (startsSheetDrag(e.target)) e.stopPropagation();
  };
  doc.addEventListener('pointerdown', stop, true);
  return () => doc.removeEventListener('pointerdown', stop, true);
}
