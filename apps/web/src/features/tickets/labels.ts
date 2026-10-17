import type { BadgeTone } from '@isnanme/ui';
import {
  TICKET_PRIORITIES,
  TICKET_TYPES,
  type TicketFilter,
  type TicketOrphanWhy,
  type TicketPriority,
  type TicketSessionState,
  type TicketStatus,
  type TicketType,
} from '@portal/contracts';

/** Status words and tones (tickets PRD §13). Done is quiet green, blocked is warm, the rest are neutral. */
export const STATUS_TONE: Record<TicketStatus, BadgeTone> = {
  open: 'neutral',
  in_progress: 'success',
  blocked: 'danger',
  in_review: 'warning',
  done: 'success',
  wont_do: 'neutral',
};

/** The board's columns, left to right. Closed tickets share the last. */
export const BOARD_COLUMNS: TicketStatus[] = ['open', 'in_progress', 'blocked', 'in_review', 'done'];

export const PRIORITY_TONE: Record<TicketPriority, BadgeTone> = { urgent: 'danger', high: 'warning', normal: 'neutral', low: 'neutral' };

export const TYPE_TONE: Record<TicketType, BadgeTone> = {
  task: 'neutral',
  bug: 'danger',
  feature: 'success',
  question: 'warning',
  request: 'neutral',
  incident: 'danger',
  approval: 'warning',
  chore: 'neutral',
};

export const SESSION_STATE_LABEL: Record<TicketSessionState, string> = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  waiting: 'Needs input',
  interrupted: 'Interrupted',
  ended: 'Ended',
};

/** A Portal MCP token, by the label its owner gave it: never anonymous when the label is known. */
export const mcpClientName = (label: string | null | undefined): string =>
  label?.trim() ? `MCP client “${label.trim()}”` : 'An MCP client';

/** How an actor string reads on a timeline: who, not an id. */
export function actorName(actor: string, label: string): string {
  if (actor === 'ui') return 'Admin';
  if (actor === 'system') return 'Portal';
  if (actor.startsWith('portal-mcp:')) return mcpClientName(label);
  if (actor.startsWith('session:')) return label || 'A session';
  if (actor.startsWith('ticket:')) return label || 'A ticket';
  return label || actor;
}

/** The time a ticket has been waiting, as short as a row wants it. */
export function ageShort(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 60 ? `${d}d` : `${Math.floor(d / 30)}mo`;
}

/** T-270: an orphan (its session is dead) on the ticket and its row. */
export const ORPHAN_TITLE: Record<TicketOrphanWhy, string> = {
  ended: 'Its session ended',
  archived: 'Its session was archived',
  missing: 'Its session is gone',
};
export const ORPHAN_BADGE: Record<TicketOrphanWhy, string> = {
  ended: 'Session ended',
  archived: 'Session archived',
  missing: 'Session gone',
};

/** The timeline sentence of a move the orphan sweep made (an `assigned` entry with `fallback: true`); its comment says why. */
export function fallbackSentence(who: string, d: { to?: unknown; reason?: unknown }): string {
  if (!d.to) return `${who} put it back in the queue`;
  return d.reason === 'title' ? `${who} moved it to the live session of its track` : `${who} moved it to the session that continues it`;
}

/** The list's filter from the page's choices (the address): one place, so the chips cannot drift from the request. */
export function pageFilter(p: {
  view: 'list' | 'board';
  scope: string;
  needs: boolean;
  queue: boolean;
  orphans: boolean;
  priority: string | null;
  type: string | null;
  tag: string | null;
  q: string;
}): TicketFilter {
  const f: TicketFilter = { limit: 100 };
  if (p.view === 'board') f.includeClosed = true;
  else if (p.scope === 'closed') f.status = ['done', 'wont_do'];
  else if (p.scope !== 'active') f.status = [p.scope as TicketStatus];
  if (p.needs) f.assignee = 'user';
  if (p.queue) f.assignee = 'unassigned';
  if (p.orphans) f.orphan = true;
  if (p.priority && (TICKET_PRIORITIES as readonly string[]).includes(p.priority)) f.priority = [p.priority as TicketPriority];
  if (p.type && (TICKET_TYPES as readonly string[]).includes(p.type)) f.type = [p.type as TicketType];
  if (p.tag) f.tag = p.tag;
  if (p.q) f.query = p.q;
  return f;
}
