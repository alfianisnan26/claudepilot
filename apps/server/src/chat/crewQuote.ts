import { redactSecrets, stripUnsafe } from '../portalmcp/sanitize.js';

// T-294: what a quoted text could close the report's quotes or open a frame of its own with: quotes become ', brackets ( and ).
const CREW_QUOTES = /["“”„‟«»＂‘’‚‛]/g; // not ‹ ›: they close no “ ” quote, and a menu path (Settings › Sessions) stays readable
const CREW_OPENS = /[[<［＜【〔〈《]/g;
const CREW_CLOSES = /[\]>］＞】〕〉》]/g;

/**
 * T-294: a worker's text as a crew report quotes it (its reply, what it waits on, why it stopped or ended, its title, its Claude): escapes
 * and invisible characters out and secrets redacted (`stripUnsafe`, `redactSecrets`, as session_family's untrusted text), one line, with no
 * character that could close the report's quotes or open a frame of its own, at most `max` characters.
 * T-548: lives here (re-exported by controller.ts) so handoff.ts can use it without importing the controller.
 */
export function crewQuote(raw: string | null | undefined, max: number): string {
  const text = redactSecrets(stripUnsafe(raw ?? ''))
    .replace(CREW_QUOTES, "'")
    .replace(CREW_OPENS, '(')
    .replace(CREW_CLOSES, ')')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
