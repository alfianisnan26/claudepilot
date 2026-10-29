// T-294 "Crew", slice 3: the crew channel (`crew_post` and `crew_read`, chat-sessions PRD FR51) as one thread on the lead's page. The channel is
// stored in the portal, one per lead, and holds what the whole crew should be able to look up (a decision, an interface, a finding). This
// module is the pure part: a message names its author by session id, so the thread turns ids into names and roles from the lead and its
// workers, joins one author's consecutive messages, splits the days, and keeps the newest ones in sight. Pure, so the rules are tested
// (crewThread.test.ts); the view is CrewThread.tsx.
import type { ChatSession } from '@portal/contracts';
import { bySpawn } from './crew';
import { roleOf } from './crewLimits';

/** One stored message (what `crew_read` returns for it): its id grows with time, `from` is the author's session id. */
export interface CrewMessage {
  id: number;
  from: string;
  text: string;
  at: string;
}

/** One read of the channel: oldest first from the place asked, `more` when there are messages past these. */
export interface CrewChannelPage {
  items: CrewMessage[];
  cursor: number;
  more: boolean;
}

/** The messages shown at first, and how many each "Earlier" adds. */
export const THREAD_PAGE = 30;

/** Messages by id, each once: `incoming` wins over `known` for an id both have (a re-read of the same page changes nothing). */
export function mergeMessages(known: readonly CrewMessage[], incoming: readonly CrewMessage[]): CrewMessage[] {
  const byId = new Map<number, CrewMessage>();
  for (const m of known) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Where the next read goes on from: the id of the newest message known, 0 for none. */
export const lastId = (messages: readonly CrewMessage[]): number => messages.reduce((n, m) => Math.max(n, m.id), 0);

export interface Author {
  /** The session id the message came from. */
  id: string;
  /** Its title ("Untitled" without one, "Lead" for a lead without one), "Worker" for a session the portal no longer lists (deleted, or one of a sibling crew). */
  name: string;
  /** The role it runs as (`claude --agent`), null for Claude Code's default. */
  role: string | null;
  isLead: boolean;
  /** The portal still lists it: the name can link to its page. */
  known: boolean;
}

/** Who wrote what: the lead and its workers by id. A lead names itself by its title, never a bare "Lead" beside a worker's title. */
export function authorsOf(lead: Pick<ChatSession, 'id' | 'title' | 'agent'> | null, workers: readonly ChatSession[]): ReadonlyMap<string, Author> {
  const out = new Map<string, Author>();
  const sorted = [...workers].sort(bySpawn);
  for (const w of sorted) out.set(w.id, { id: w.id, name: w.title?.trim() || 'Untitled', role: roleOf(w), isLead: false, known: true });
  if (lead) out.set(lead.id, { id: lead.id, name: lead.title?.trim() || 'Lead', role: roleOf(lead), isLead: true, known: true });
  return out;
}

export const authorOf = (authors: ReadonlyMap<string, Author>, id: string): Author =>
  authors.get(id) ?? { id, name: 'Worker', role: null, isLead: false, known: false };

export type ThreadEntry =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; id: number; author: Author; text: string; at: string; /** The first of its author's run: the name shows on it only. */ first: boolean };

/** The local calendar day of a time ("2026-10-29"), the day a thread splits on. */
export function dayKey(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Today", "Yesterday" or the date, by `now`'s calendar day (a fixed clock in the tests, never the real one). */
export function dayLabel(key: string, now: Date): string {
  if (key === dayKey(now)) return 'Today';
  const before = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === dayKey(before)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'short', ...(y === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/**
 * The thread, oldest first: a day heading when the day changes, and for each message whether it opens its author's run (consecutive messages
 * of one author on one day join under one name). A message with no readable time joins the day before it.
 */
export function threadOf(messages: readonly CrewMessage[], authors: ReadonlyMap<string, Author>, now: Date): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  let day = '';
  let prev: string | null = null;
  for (const m of messages) {
    const key = dayKey(m.at);
    if (key && key !== day) {
      day = key;
      prev = null;
      out.push({ kind: 'day', key, label: dayLabel(key, now) });
    }
    out.push({ kind: 'message', id: m.id, author: authorOf(authors, m.from), text: m.text, at: m.at, first: prev !== m.from });
    prev = m.from;
  }
  return out;
}

/** The newest `shown` messages, and how many older ones stay behind (the "Earlier" row says it). */
export function tail<T>(messages: readonly T[], shown: number): { items: T[]; older: number } {
  const n = Math.max(0, Math.floor(shown));
  const older = Math.max(0, messages.length - n);
  return { items: messages.slice(older), older };
}

/** The words for the pill and a screen reader: "3 crew messages". */
export const threadCount = (n: number): string => `${n} crew ${n === 1 ? 'message' : 'messages'}`;
