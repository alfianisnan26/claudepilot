import { Bell, Boxes, ChartColumn, House, KeyRound, Layers, Library, MessagesSquare, Server, Settings, Ticket, Workflow, type LucideIcon } from 'lucide-react';

export interface NavItem {
  id: string;
  to: string;
  label: string;
  icon: LucideIcon;
  /** `work`: what you do with workspaces and agents. `admin`: how the portal is set up and watched. The sidebar separates the two. */
  group: 'work' | 'admin';
  /** In the phone bar itself. Pages added later leave it unset: they go in its More sheet. */
  bar?: boolean;
}

/**
 * The signed-in sections. Add a page here with its `group` (leave `bar` unset): the desktop sidebar lists every item, work first and
 * then admin with a divider between, and the phone bar shows only the `bar` ones, icon only, with the rest in its More sheet.
 */
export const NAV: NavItem[] = [
  // The first page (glance-widgets PRD §18): what needs you and how things stand. The app opens here.
  { id: 'home', to: '/admin/home', label: 'Home', icon: House, group: 'work', bar: true },
  { id: 'workspaces', to: '/admin/workspaces', label: 'Workspaces', icon: Boxes, group: 'work', bar: true },
  { id: 'sessions', to: '/admin/sessions', label: 'Sessions', icon: MessagesSquare, group: 'work', bar: true },
  // One queue of work for people and agents (Tickets PRD).
  { id: 'tickets', to: '/admin/tickets', label: 'Tickets', icon: Ticket, group: 'work', bar: true },
  // Vaults of Markdown notes people and agents share, with their graphs (Knowledge PRD).
  // In More since Home took a place in the phone bar (at most five there: web-app-pwa PRD G2).
  { id: 'knowledge', to: '/admin/knowledge', label: 'Knowledge', icon: Library, group: 'work' },
  // A git remote on each workspace and the runs of the pipelines in its repositories (Local git and CI/CD PRD).
  { id: 'ci', to: '/admin/ci', label: 'CI', icon: Workflow, group: 'work' },
  { id: 'usage', to: '/admin/usage', label: 'Usage', icon: ChartColumn, group: 'admin' },
  // One hub for every pool type, Accounts first (Skillset PRD §18 A8).
  { id: 'pools', to: '/admin/pools', label: 'Pools', icon: Layers, group: 'admin' },
  // Where workspaces run, and machines that connect to the portal (Targets and Connect PRD §16).
  { id: 'targets', to: '/admin/targets', label: 'Targets', icon: Server, group: 'admin' },
  { id: 'access', to: '/admin/access', label: 'Access', icon: KeyRound, group: 'admin' },
  // What arrived and where it goes: devices, channels, quiet hours (PWA PRD §11).
  { id: 'notifications', to: '/admin/notifications', label: 'Notifications', icon: Bell, group: 'admin' },
  // Portal-wide switches areas define: MCP lockdown, agents, sessions (Settings PRD).
  { id: 'settings', to: '/admin/settings', label: 'Settings', icon: Settings, group: 'admin' },
];

export const HOME = NAV[0]!.to;

/** The sidebar's lists: work, then admin. Where an item sits in `NAV` does not matter, its group does. */
export const NAV_GROUPS: NavItem[][] = (['work', 'admin'] as const).map((g) => NAV.filter((i) => i.group === g)).filter((items) => items.length > 0);

/** What the phone bar shows, and what its More sheet lists. */
export const BAR_ITEMS = NAV.filter((i) => i.bar);
export const MORE_ITEMS = NAV.filter((i) => !i.bar);
