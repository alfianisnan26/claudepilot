import { useEffect, useRef } from 'react';

/**
 * Dialogs opened over another dialog (the sign-in opens over a workspace's Configuration): the kit's dialogs all listen for
 * Escape on `document`, so one key press would close the whole stack. While `active`, this takes the key first (capture
 * phase) and hands it to `onEscape` alone, so only the top dialog closes.
 */
export function useEscapeFirst(active: boolean, onEscape: () => void) {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      latest.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active]);
}
