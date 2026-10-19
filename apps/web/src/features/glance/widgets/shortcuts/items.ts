import { TICKET_STATUS_LABEL, workspaceDisplayName, workspaceLabel, type ChatSession, type TicketItem, type Workspace } from '@portal/contracts';
import { SESSION_WORD } from '../sessions/model';
import type { PaletteItem } from './search';

// The palette's items, made from what the portal already lists (docs/prd/glance-widgets.md §6.5). Plain data in, plain items out.

/** The page's own words stay where they are defined: the sidebar's list of pages (`app/nav.ts`) is passed in. */
export function pageItems(nav: readonly { id: string; to: string; label: string }[]): PaletteItem[] {
  return nav.map((p) => ({ id: `page:${p.id}`, kind: 'page', title: p.label, hint: '', to: p.to }));
}

/**
 * What a person can do from anywhere: start a session, and look at one of the glance widgets' full forms (`?glance=<id>` opens it as a
 * sheet on whatever page this is: the frame's own deep link, which keeps the rest of the URL).
 */
export function actionItems(here: { pathname: string; search: string }): PaletteItem[] {
  const glance = (id: string) => {
    const q = new URLSearchParams(here.search);
    q.set('glance', id);
    return `${here.pathname}?${q.toString()}`;
  };
  return [
    { id: 'action:new-session', kind: 'action', title: 'New agent', hint: '', to: '/admin/sessions?new=1', keywords: 'create start chat' },
    { id: 'action:attention', kind: 'action', title: 'Needs attention', hint: 'Approvals, tickets, CI', to: glance('attention'), keywords: 'approve deny waiting failed' },
    { id: 'action:quota', kind: 'action', title: 'Quota', hint: 'Plan left', to: glance('quota'), keywords: 'limit usage left reset' },
    { id: 'action:agents', kind: 'action', title: 'Agents', hint: 'Running now', to: glance('agents'), keywords: 'workers sub-agents stop' },
  ];
}

/** Sessions that are not archived, the latest used first among equals; an ended one stays findable. */
export function sessionItems(sessions: readonly ChatSession[]): PaletteItem[] {
  return sessions
    .filter((s) => !s.archivedAt)
    .map((s) => ({
      id: `session:${s.id}`,
      kind: 'session' as const,
      title: s.title || 'Untitled',
      hint: `${SESSION_WORD[s.state]} · ${workspaceLabel(s.workspaceId)}`,
      to: `/admin/sessions/${encodeURIComponent(s.id)}`,
      // What the Sessions page's own search looks in, beside the title.
      keywords: [s.claudeName, s.workspaceId, s.worktree?.branch, s.ticketId, s.id].filter(Boolean).join(' '),
      recent: Date.parse(s.lastActivityAt) || 0,
      state: s.state,
    }));
}

/**
 * A workspace opens in its shell while it runs (the one place that is about that workspace alone), else on the Workspaces page, and
 * the row says which ("Shell" or the status), so Enter never surprises.
 */
export function workspaceItems(workspaces: readonly Workspace[]): PaletteItem[] {
  return workspaces.map((w) => ({
    id: `workspace:${w.id}`,
    kind: 'workspace' as const,
    title: workspaceDisplayName(w),
    hint: w.status === 'running' ? 'Shell' : w.status,
    to: w.status === 'running' ? `/admin/workspaces/${encodeURIComponent(w.target)}/${encodeURIComponent(w.name)}/shell` : '/admin/workspaces',
    keywords: w.target,
  }));
}

/** Tickets the portal's text search returned for the words typed: matched already, so the words need not show on the row. */
export function ticketItems(tickets: readonly TicketItem[]): PaletteItem[] {
  return tickets.map((t) => ({
    id: `ticket:${t.id}`,
    kind: 'ticket' as const,
    title: t.summary,
    hint: `${t.id} · ${TICKET_STATUS_LABEL[t.status]}`,
    to: `/admin/tickets/${encodeURIComponent(t.id)}`,
    keywords: t.tags.join(' '),
    matched: true,
  }));
}
