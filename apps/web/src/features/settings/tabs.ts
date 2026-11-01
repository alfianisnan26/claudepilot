// Settings as tabs (owner request 2026-11-01: "refine the settings page, properly use tabbed menus, so not bloated in a single page"). The
// server's setting groups (each area's `defineSettingGroup`) and the page's own sections are sorted into six tabs; a group the page does not
// know yet (an area added later) lands in General, so no setting is ever left off the page.

import type { TabDef } from '@/lib/routedTabs';

export type SettingsTabId = 'general' | 'agents' | 'sessions' | 'claude' | 'people' | 'glance';

export const SETTINGS_BASE = '/admin/settings';

/** The tabs in order. The whole page is a platform area (D-82 S1a), so every tab is an admin's. */
export const SETTINGS_TABS: readonly (TabDef & { id: SettingsTabId })[] = [
  { id: 'general', label: 'General', adminOnly: true },
  { id: 'agents', label: 'Agents', adminOnly: true },
  { id: 'sessions', label: 'Sessions', adminOnly: true },
  { id: 'claude', label: 'Claude Code', adminOnly: true },
  { id: 'people', label: 'People', adminOnly: true },
  { id: 'glance', label: 'Glance', adminOnly: true },
];

/** Which tab shows a server setting group. */
const GROUP_TAB: Record<string, SettingsTabId> = {
  // What agents may do: the portal MCP lockdown and agent permissions, the sub-agent environment.
  mcp: 'agents',
  agents: 'agents',
  // How running agents behave: the session switches (Bypass, approvals, limits), keep going, flow, moving between Claudes.
  sessions: 'sessions',
  keepgoing: 'sessions',
  flow: 'sessions',
  automove: 'sessions',
  // The installed Claude Code, its canary.
  claude: 'claude',
};

export const settingsTabOf = (group: string): SettingsTabId => GROUP_TAB[group] ?? 'general';
