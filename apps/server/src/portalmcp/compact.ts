import { z } from 'zod';
import { STRING_MAX, untrusted, type UntrustedText } from './sanitize.js';

// Short results by default (T-282). A tool result is written into the model's context once and read again on every
// later request of that session, so a long one is paid for many times. List and detail tools answer with short rows
// and the head of long text; `full: true` (or a tool's own `section` / id argument) returns the rest. A cut is never
// silent: the result carries a `cut` line per field that says how much was shown and how to ask for the rest.

/** The input every compact tool takes. */
export const fullInput = {
  full: z.boolean().optional().describe('Every field and longer text (a larger result). Default: the short form.'),
};

/** The most text one page of a long field carries (the context's own cap for one untrusted field). */
export const PAGE_CHARS = 8_000;

/**
 * Untrusted text cut at `max` characters (at most {@link PAGE_CHARS}). When it is cut, a line goes into `cut` that names the field, the size shown
 * and the whole size, and how to get the rest (`ask`). The text is cleaned and labelled exactly as `ctx.untrusted` does.
 */
export function clip(text: string | null | undefined, source: string, max: number, cut: string[], field: string, ask: string): UntrustedText | null {
  const whole = untrusted(text, source, STRING_MAX);
  if (!whole || whole.untrusted_text.length <= max) return whole;
  cut.push(`${field} cut at ${max} of ${whole.untrusted_text.length} characters: ${ask}.`);
  return { ...whole, untrusted_text: `${whole.untrusted_text.slice(0, Math.min(max, PAGE_CHARS) - 1)}…` };
}

/**
 * One page of a long untrusted text: `PAGE_CHARS` characters from `from`, cleaned and labelled like `ctx.untrusted`,
 * with a cut line when more follows (`ask` gets the offset to continue from).
 */
export function page(text: string | null | undefined, source: string, from: number, cut: string[], field: string, ask: (next: number) => string): UntrustedText | null {
  const whole = untrusted(text, source, STRING_MAX);
  if (!whole) return null;
  const all = whole.untrusted_text;
  const end = Math.min(all.length, from + PAGE_CHARS);
  if (from > 0 || end < all.length) cut.push(`${field}: characters ${Math.min(from, all.length)} to ${end} of ${all.length}${end < all.length ? `: ${ask(end)}` : ''}.`);
  return { ...whole, untrusted_text: all.slice(from, end) };
}
