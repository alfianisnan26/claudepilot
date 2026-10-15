// The transcript a tab holds, read in pages (T-376, chat-sessions PRD §10.5 "History pages"). Opening a chat loads the newest page only;
// scrolling up loads the page before the first event held; the live socket appends at the end (resuming after the newest seq held). A
// `tool_result` in a page may be a preview (`textLength`); the whole event replaces it when a person opens it. Pure, so it is tested alone.
import type { ChatEvent, ChatEventPage } from '@portal/contracts';

export interface History {
  /** Held events, oldest first, one per `seq`. */
  events: ChatEvent[];
  /** Older events exist than the first one held. */
  more: boolean;
  /** What to ask `?before=` with for the older page; null when there is none. */
  before: number | null;
  /** The newest page came in: until then the transcript waits, and so does the socket's subscribe (it would send the whole backlog). */
  seeded: boolean;
  /** The older page: being read, or the last read failed (a person retries). */
  older: 'idle' | 'loading' | 'failed';
}

export const EMPTY_HISTORY: History = { events: [], more: false, before: null, seeded: false, older: 'idle' };

/** A `tool_result` whose `text` is a preview of a longer whole (`textLength`). */
export const isCut = (e: ChatEvent): boolean => e.textLength !== undefined && (e.text?.length ?? 0) < e.textLength;

/** The newest seq held (0 for none): the socket resumes after it. */
export const lastSeq = (events: readonly ChatEvent[]): number => (events.length ? events[events.length - 1]!.seq : 0);

/** Of two copies of one event, the one to keep: the whole one over a preview, else the newer. */
const keep = (held: ChatEvent | undefined, incoming: ChatEvent): ChatEvent => (held && isCut(incoming) && !isCut(held) ? held : incoming);

/** A batch merged into the held events: one per `seq`, in order, a whole copy never replaced by a preview. */
export function mergeEvents(prev: ChatEvent[], incoming: readonly ChatEvent[]): ChatEvent[] {
  if (incoming.length === 0) return prev;
  const last = lastSeq(prev);
  // The usual live case: everything new is after the end.
  if (incoming.every((e, i) => e.seq > last && (i === 0 || e.seq > incoming[i - 1]!.seq))) return prev.concat(incoming);
  const bySeq = new Map(prev.map((e) => [e.seq, e]));
  for (const e of incoming) bySeq.set(e.seq, keep(bySeq.get(e.seq), e));
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** An answer of the events route as a page: a portal from before T-376 answers a plain list (the whole transcript). */
export function asPage(raw: ChatEvent[] | ChatEventPage): ChatEventPage {
  return Array.isArray(raw) ? { events: raw, more: false, before: null } : raw;
}

/** The newest page came in. */
export function seed(h: History, page: ChatEventPage): History {
  return { events: mergeEvents(h.events, page.events), more: page.more, before: page.more ? page.before : null, seeded: true, older: 'idle' };
}

/** The socket could not wait for a page (it failed): the subscribe asks for everything, as before T-376, so nothing is older. */
export function seedAll(h: History): History {
  return { ...h, more: false, before: null, seeded: true, older: 'idle' };
}

/** Asking for the older page: only when there is one and none is being read. Null when there is nothing to ask. */
export function olderStart(h: History): History | null {
  if (!h.seeded || !h.more || h.before === null || h.older === 'loading') return null;
  return { ...h, older: 'loading' };
}

/** The older page came in (asked with `before`): it goes before what is held. A page for a `before` no longer current only merges. */
export function olderDone(h: History, before: number, page: ChatEventPage): History {
  const events = mergeEvents(h.events, page.events);
  if (h.before !== before) return { ...h, events, older: 'idle' };
  return { ...h, events, more: page.more, before: page.more ? page.before : null, older: 'idle' };
}

export function olderFailed(h: History): History {
  return { ...h, older: 'failed' };
}

/** Live events from the socket, at the end. */
export function appendLive(h: History, items: readonly ChatEvent[]): History {
  const events = mergeEvents(h.events, items);
  return events === h.events ? h : { ...h, events };
}

/** One event whole (a preview opened): it takes its preview's place. An event not held is left out. */
export function expand(h: History, whole: ChatEvent): History {
  const i = h.events.findIndex((e) => e.seq === whole.seq);
  if (i < 0) return h;
  const events = h.events.slice();
  events[i] = whole;
  return { ...h, events };
}
