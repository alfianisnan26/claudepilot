import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * For a dialog opened over another one: Escape closes this one only. Every kit Dialog listens for
 * Escape on `document`, so the one underneath would close too (and a form with changes would ask to
 * discard them). This listens on `window` while capturing, which runs first, and stops the key there.
 */
export function useEscapeFirst(open: boolean, onClose: () => void) {
  const latest = useRef(onClose);
  useLayoutEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      latest.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
}
