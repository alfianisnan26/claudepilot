// The quick-search shortcut (docs/prd/glance-widgets.md §6.5): Cmd+K on a Mac, Ctrl+K elsewhere. Pure, so it can be tested.

/** The part of a keyboard event the shortcut reads. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/** Whether this is an Apple platform, where Cmd is the shortcut key (and Ctrl+K belongs to the text field: it deletes to the end of the line). */
export function isMacPlatform(nav: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  const p = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(p);
}

/**
 * Cmd+K (Mac) or Ctrl+K (everywhere else), with no other modifier: Ctrl+Shift+K is a browser's console, Alt+K is a character on some
 * keyboards. Not while an input method is composing, and not when something already handled the key.
 */
export function isPaletteShortcut(e: KeyLike, mac: boolean): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** The terminal passes Ctrl+K to the shell (readline's kill-line): the palette never takes it there. */
export function inTerminal(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return !!el && typeof el.closest === 'function' && !!el.closest('.xterm');
}

/** How the shortcut reads on this platform. */
export const shortcutLabel = (mac: boolean): string => (mac ? '⌘K' : 'Ctrl K');
