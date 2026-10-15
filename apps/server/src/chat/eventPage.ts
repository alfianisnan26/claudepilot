// Transcript pages (T-376, chat-sessions PRD §9 "History pages"): the pure rules of a page of `GET /api/chat/sessions/:id/events?before=&limit=`.
// The store reads the newest events before a seq (keyset, never an offset: D-58); this cuts large tool_result bodies to a preview that keeps
// the whole length, and stops the page at the limit or the byte cap, whichever comes first. No I/O.

import { AppError } from '@isnanme/core';
import { EVENT_PAGE_BYTES, EVENT_PAGE_LIMIT, EVENT_PAGE_LIMIT_MAX, EVENT_PREVIEW_CHARS, type ChatEvent, type ChatEventPage } from '@portal/contracts';

/** What a call to the events route asks for: the events after a seq (as before T-376), or a page counted back from a seq. */
export type EventsQuery = { kind: 'after'; after: number } | { kind: 'page'; before: number | null; limit: number };

const positiveInt = (raw: string, name: string): number => {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < 1) throw new AppError('VALIDATION_FAILED', `${name} is a whole number from 1.`, { details: { [name]: 'Expected a whole number from 1.' } });
  return n;
};

/**
 * Reads `?after=`, `?before=` and `?limit=`. Neither `before` nor `limit`: the `after` form, read exactly as before T-376 (anything that is
 * not a number is 0, so no parameter at all is the whole transcript). Either of them: a page; `limit` defaults to `EVENT_PAGE_LIMIT` and is
 * capped at `EVENT_PAGE_LIMIT_MAX`; `before` absent (or empty) is the newest. `after` with them is refused.
 */
export function eventsQuery(q: { after?: string; before?: string; limit?: string }): EventsQuery {
  const paged = q.before !== undefined || q.limit !== undefined;
  if (!paged) return { kind: 'after', after: Number(q.after ?? 0) || 0 };
  if (q.after !== undefined) throw new AppError('VALIDATION_FAILED', 'Ask with after, or with before and limit, not both.', { details: { after: 'Not with before or limit.' } });
  const before = q.before === undefined || q.before === '' ? null : positiveInt(q.before, 'before');
  const limit = q.limit === undefined || q.limit === '' ? EVENT_PAGE_LIMIT : Math.min(positiveInt(q.limit, 'limit'), EVENT_PAGE_LIMIT_MAX);
  return { kind: 'page', before, limit };
}

/**
 * A `tool_result` whose text is longer than `max` characters, with the text cut to its first `max` (never half a surrogate pair) and
 * `textLength` set to the whole length; any other event as it is (the same object).
 */
export function previewEvent(ev: ChatEvent, max = EVENT_PREVIEW_CHARS): ChatEvent {
  if (ev.kind !== 'tool_result' || typeof ev.text !== 'string' || ev.text.length <= max) return ev;
  let end = max;
  const code = ev.text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // a high surrogate whose pair would be cut off
  return { ...ev, text: ev.text.slice(0, end), textLength: ev.text.length };
}

/**
 * The page from events read newest first (at most one more than `limit`, so `more` is known without a count): each cut by
 * {@link previewEvent}, taken until `limit` or until the next would pass `maxBytes` of JSON (at least one is always taken), then oldest first.
 */
export function eventPage(newestFirst: readonly ChatEvent[], limit: number, opts: { maxBytes?: number; previewChars?: number } = {}): ChatEventPage {
  const maxBytes = opts.maxBytes ?? EVENT_PAGE_BYTES;
  const taken: ChatEvent[] = [];
  let bytes = 0;
  for (const ev of newestFirst) {
    if (taken.length >= limit) break;
    const cut = previewEvent(ev, opts.previewChars);
    const size = Buffer.byteLength(JSON.stringify(cut));
    if (taken.length > 0 && bytes + size > maxBytes) break;
    taken.push(cut);
    bytes += size;
  }
  const more = taken.length < newestFirst.length;
  taken.reverse();
  return { events: taken, more, before: more && taken.length ? taken[0]!.seq : null };
}
