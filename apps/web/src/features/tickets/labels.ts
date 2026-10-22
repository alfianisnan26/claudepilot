import type { BadgeTone } from '@isnanme/ui';
import {
  TICKET_PRIORITIES,
  TICKET_TYPES,
  type TicketFilter,
  type TicketMergeState,
  type TicketMergeStatus,
  type TicketOrphanWhy,
  type TicketPriority,
  type TicketSessionState,
  type TicketStatus,
  type TicketType,
  type TicketVerdictBatch,
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
  if (actor.startsWith('session:')) return label || 'An agent';
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
  ended: 'Its agent ended',
  archived: 'Its agent was archived',
  missing: 'Its agent is gone',
};
export const ORPHAN_BADGE: Record<TicketOrphanWhy, string> = {
  ended: 'Agent ended',
  archived: 'Agent archived',
  missing: 'Agent gone',
};

/** The timeline sentence of a move the orphan sweep made (an `assigned` entry with `fallback: true`); its comment says why. */
export function fallbackSentence(who: string, d: { to?: unknown; reason?: unknown }): string {
  if (!d.to) return `${who} put it back in the queue`;
  return d.reason === 'title' ? `${who} moved it to the live agent of its track` : `${who} moved it to the agent that continues it`;
}

/** The list's filter from the page's choices (the address): one place, so the chips cannot drift from the request. */
/** T-1098: what a ticket is called on screen, its bucket key (`KONF-12`); an older server sends only the stable id. */
export const ticketLabel = (t: { id: string; key?: string }): string => t.key ?? t.id;

/** Whether an address's ticket (`T-12` or `KONF-3`, any case) is this one. */
export const isTicket = (t: { id: string; key?: string }, ref: string | null | undefined): boolean =>
  !!ref && (t.id.toUpperCase() === ref.toUpperCase() || (!!t.key && t.key.toUpperCase() === ref.toUpperCase()));

export function pageFilter(p: {
  view: 'list' | 'board' | 'timeline';
  scope: string;
  needs: boolean;
  queue: boolean;
  orphans: boolean;
  priority: string | null;
  type: string | null;
  tag: string | null;
  q: string;
  bucket?: string | null;
}): TicketFilter {
  const f: TicketFilter = { limit: 100 };
  if (p.bucket) f.bucket = p.bucket;
  // The board and the timeline (T-119) show closed tickets too: the timeline's first chip is All, not Active.
  if (p.view === 'board' || (p.view === 'timeline' && p.scope === 'active')) f.includeClosed = true;
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

/** What the merge confirm says: how many tickets move, that the old keys keep working, that the bucket goes. */
export function mergeText(from: string, into: string, tickets: number | undefined): string {
  const what = tickets === undefined ? 'Its tickets move' : `${tickets} ${tickets === 1 ? 'ticket moves' : 'tickets move'}`;
  return `${what} to ${into}, ${from} keys keep working, ${from} is deleted.`;
}

/** A bucket in a picker: the key alone where room is short (a phone), with its name where it fits (UI check of T-1967). */
export const bucketOption = (b: { key: string; name: string }, wide: boolean): string => (wide ? `${b.key} · ${b.name}` : b.key);

/**
 * FR36d (T-1987): the QA batch a verdict entry was recorded in (its `data.batch`), or null: a verdict recorded alone, any other entry, or
 * a shape this page does not know. Only strings are kept; nothing else is shown.
 */
export function verdictBatchOf(data: Record<string, unknown> | null | undefined): TicketVerdictBatch | null {
  if (!data || data.verdictId === undefined) return null;
  const b = data.batch as Record<string, unknown> | undefined;
  if (!b || typeof b !== 'object') return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { jobId: str(b.jobId), branch: str(b.branch), note: str(b.note) };
}

/** T-2014: a merge state in a word or two, for the PR chip. */
export const MERGE_STATE_LABEL: Record<TicketMergeState, string> = {
  ready: 'ready',
  merged: 'merged',
  conflict: 'conflict',
  waiting: 'waiting',
  no_pr: 'no PR',
  failed: 'failed',
};

/** T-2014: the PR chip's text, "api#12 · ready": the repo's last part (the whole name is in the chip's title), no number without a PR. */
export function mergeChipText(m: Pick<TicketMergeStatus, 'repo' | 'pr' | 'state'>): string {
  const name = m.repo.split('/').pop() || m.repo;
  return `${name}${m.pr ? `#${m.pr}` : ''} · ${MERGE_STATE_LABEL[m.state]}`;
}
