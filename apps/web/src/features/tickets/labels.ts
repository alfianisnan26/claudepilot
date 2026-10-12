import type { BadgeTone } from '@isnanme/ui';
import type { TicketPriority, TicketSessionState, TicketStatus, TicketType } from '@portal/contracts';

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

/** How an actor string reads on a timeline: who, not an id. */
export function actorName(actor: string, label: string): string {
  if (actor === 'ui') return 'Admin';
  if (actor === 'system') return 'Portal';
  if (actor.startsWith('portal-mcp:')) return label || 'An agent';
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
