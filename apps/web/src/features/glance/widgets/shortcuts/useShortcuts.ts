import type { GlanceCompact, GlanceContext } from '../../types';
import { isMacPlatform, shortcutLabel } from './keys';

/** The Shortcuts chip: the icon alone (no number, no dot), named for the key that opens the search on this platform. */
export function useShortcutsCompact(_ctx: GlanceContext): GlanceCompact {
  const key = shortcutLabel(isMacPlatform(typeof navigator === 'undefined' ? undefined : navigator));
  return { value: null, level: 'idle', title: `Search and shortcuts (${key})` };
}
