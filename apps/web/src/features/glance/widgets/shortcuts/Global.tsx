import { AnimatePresence } from 'motion/react';
import { lazy, Suspense, useEffect } from 'react';
import { inTerminal, isMacPlatform, isPaletteShortcut } from './keys';
import { togglePalette, usePaletteOpen } from './paletteStore';

// The palette's UI loads when it first opens; this part, always mounted, is only the key listener.
const Palette = lazy(() => import('./Palette'));

/**
 * Mounted once for the whole signed-in app (by the glance frame's root): Cmd+K on a Mac, Ctrl+K elsewhere opens the quick search, and
 * the same key closes it. Not in the terminal (the shell takes Ctrl+K), and the browser's own use of the key is held back only when
 * the palette takes it.
 */
export function ShortcutsGlobal() {
  const open = usePaletteOpen();
  useEffect(() => {
    const mac = isMacPlatform(typeof navigator === 'undefined' ? undefined : navigator);
    const on = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e, mac) || inTerminal(e.target)) return;
      e.preventDefault();
      togglePalette();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  return (
    <Suspense fallback={null}>
      <AnimatePresence>{open && <Palette key="palette" />}</AnimatePresence>
    </Suspense>
  );
}
