import { Search } from 'lucide-react';
import { lazy } from 'react';
import type { GlanceWidget } from '../../types';
import { ShortcutsGlobal } from './Global';
import { openPalette } from './paletteStore';
import { useShortcutsCompact } from './useShortcuts';

/**
 * The quick search (Ctrl/Cmd+K): sessions by title, workspaces, tickets, pages and actions. Its chip is the icon alone and a tap opens
 * the search; the key listener and the palette are its `Global` part (PRD glance-widgets §6.5).
 */
export const shortcutsWidget: GlanceWidget = {
  id: 'shortcuts',
  label: 'Shortcuts',
  icon: Search,
  about: 'Quick search for sessions, workspaces, tickets, pages and actions, from anywhere with Ctrl+K (Cmd+K on a Mac), and a new session in a tap.',
  placements: ['header', 'dock'],
  useCompact: useShortcutsCompact,
  activate: () => openPalette(),
  Global: ShortcutsGlobal,
  Full: lazy(() => import('./Full').then((m) => ({ default: m.ShortcutsFull }))),
};
