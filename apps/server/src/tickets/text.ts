import { AppError } from '@isnanme/core';
import { TICKET_LIMITS, TICKET_TAG } from '@portal/contracts';
import { looksLikeSecret, stripUnsafe } from '../portalmcp/sanitize.js';

// Ticket text is untrusted input (tickets PRD §11). On the way in, hidden characters are stripped and anything
// shaped like a credential is refused, so neither is ever stored; nothing is silently cut, a text over its cap is
// an error that says so.

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });

/** A single-line field (the summary, a label): hidden characters stripped, whitespace collapsed, within `max`. */
export function cleanLine(raw: unknown, field: string, max: number, opts: { required?: boolean } = {}): string {
  if (raw === undefined || raw === null) {
    if (opts.required === false) return '';
    throw invalid(field, 'Required.');
  }
  if (typeof raw !== 'string') throw invalid(field, 'Use text.');
  const text = stripUnsafe(raw).replace(/\s+/g, ' ').trim();
  if (!text && opts.required !== false) throw invalid(field, 'Required.');
  if (text.length > max) throw invalid(field, `At most ${max} characters.`);
  if (looksLikeSecret(text)) throw invalid(field, 'This looks like a secret. Tickets are not the place for credentials: describe it and say where it lives.');
  return text;
}

/** A Markdown field (a description, a comment): hidden characters stripped, within `max`, no credentials. */
export function cleanMarkdown(raw: unknown, field: string, max: number, opts: { required?: boolean } = {}): string {
  if (raw === undefined || raw === null) {
    if (opts.required) throw invalid(field, 'Required.');
    return '';
  }
  if (typeof raw !== 'string') throw invalid(field, 'Use text.');
  const text = stripUnsafe(raw).replace(/[ \t]+$/gm, '').trim();
  if (!text && opts.required) throw invalid(field, 'Required.');
  if (text.length > max) throw invalid(field, `At most ${max} characters.`);
  if (looksLikeSecret(text)) throw invalid(field, 'This looks like a secret. Tickets are not the place for credentials: describe it and say where it lives.');
  return text;
}

/** Tags: lowercase letters and digits with `.`, `_` and `-` inside, at most 10 of them, each at most 30 characters. */
export function cleanTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('tags', 'Use a list of tags.');
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') throw invalid('tags', 'Tags are text.');
    const tag = t.trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > TICKET_LIMITS.tag) throw invalid('tags', `“${tag.slice(0, 12)}…” is longer than ${TICKET_LIMITS.tag} characters.`);
    if (!TICKET_TAG.test(tag)) throw invalid('tags', `“${tag}” isn’t a tag: use lowercase letters, digits, dots, dashes and underscores.`);
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > TICKET_LIMITS.tags) throw invalid('tags', `At most ${TICKET_LIMITS.tags} tags.`);
  return out;
}
