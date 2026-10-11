import { Boxes, KeyRound, Layers, MessagesSquare, type LucideIcon } from 'lucide-react';

export interface NavItem {
  id: string;
  to: string;
  label: string;
  icon: LucideIcon;
}

/** The signed-in sections. Add a page here and it shows in the sidebar and the phone tab bar. */
export const NAV: NavItem[] = [
  { id: 'workspaces', to: '/admin/workspaces', label: 'Workspaces', icon: Boxes },
  { id: 'sessions', to: '/admin/sessions', label: 'Sessions', icon: MessagesSquare },
  // One hub for every pool type, Accounts first (Skillset PRD §18 A8).
  { id: 'pools', to: '/admin/pools', label: 'Pools', icon: Layers },
  { id: 'access', to: '/admin/access', label: 'Access', icon: KeyRound },
];

export const HOME = NAV[0]!.to;
