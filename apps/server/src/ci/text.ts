// Text that came out of a workspace (logs, commit subjects, diagnostics) before it is stored, shown or sent anywhere (PRD §16).
import { cleanText, redactSecrets, stripUnsafe } from '../portalmcp/sanitize.js';

/**
 * A log as plain text: carriage-return overwrites collapsed to what a terminal would leave (progress bars), escape
 * sequences, control and invisible characters removed. Redaction is a separate step, since it may need the workspace's values.
 */
export function cleanLog(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return stripUnsafe(lines.map((l) => (l.includes('\r') ? (l.split('\r').filter(Boolean).pop() ?? '') : l)).join('\n'));
}

/** One line of untrusted text for a list: cleaned, redacted, bounded. */
export function oneLine(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  const clean = redactSecrets(cleanText(text, max * 2)).replace(/\s+/g, ' ').trim();
  return clean ? (clean.length > max ? `${clean.slice(0, max - 1)}…` : clean) : null;
}

export { redactSecrets };
