import { Boxes, KeyRound, KeySquare, MessagesSquare, type LucideIcon } from 'lucide-react';

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
  { id: 'accounts', to: '/admin/accounts', label: 'Accounts', icon: KeySquare },
  { id: 'access', to: '/admin/access', label: 'Access', icon: KeyRound },
];

export const HOME = NAV[0]!.to;
