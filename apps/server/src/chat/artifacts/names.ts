// Chat content: file names (chat-sessions PRD FR31, §13). A name comes from the person's device or from
// a workspace, so it is untrusted: it is shown and offered for download only after being made safe (no
// path, no control or direction-changing characters, bounded), and what is staged in a workspace gets a
// plain ASCII name of the portal's own making.

import { posix } from 'node:path';

/** Most characters of a name that is shown or downloaded; the extension is kept when the stem is cut. */
export const NAME_MAX = 120;

/**
 * C0 and C1 controls, line and paragraph separators, the bidirectional overrides and isolates (a name
 * that reads "invoice" + U+202E + "fdp.exe" as "invoiceexe.pdf"), and zero-width characters.
 */
// eslint-disable-next-line no-control-regex
export const HIDDEN_CHARS = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{ad}\u{61c}\u{180e}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2069}\u{feff}\u{fff9}-\u{fffb}]/gu;

/** A display name from whatever was sent: never a path, never empty, at most {@link NAME_MAX} characters. */
export function displayName(raw: unknown, fallback = 'file'): string {
  let name = typeof raw === 'string' ? raw : '';
  // Some tools send a full path: only its last part is the name. A backslash is no separator on Linux and macOS, but
  // an unzip on Windows reads it as one, so it never stays in a name that ends up in an archive or a header.
  name = name.slice(name.lastIndexOf('/') + 1).replace(/\\/g, '_');
  name = name.normalize('NFC').replace(HIDDEN_CHARS, '').replace(/\s+/g, ' ').trim();
  // No leading or trailing dots: ".." and "." are not names, a leading one hides the file, and Windows drops a trailing one.
  name = name.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!name) return fallback;
  const chars = [...name];
  if (chars.length <= NAME_MAX) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return `${[...name.slice(0, ext ? dot : name.length)].slice(0, NAME_MAX - [...ext].length).join('')}${ext}`;
}

/** The extension, lower-case and without the dot ("Report.PDF" → "pdf"); '' when there is none or it isn't plain. */
export function extensionOf(name: string): string {
  const ext = posix.extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

/**
 * The name a file is staged under in the workspace (`~/.claudepilot/uploads/<session>/<name>`): ASCII
 * letters, digits, dot, dash and underscore only, so an `@path` mention and a shell never need quoting,
 * and the first 8 hex digits of the content's sha256 make two different files with one name (or the same
 * file attached twice) land on different (or the same) path without ever overwriting another file.
 */
export function stagedName(display: string, sha256: string): string {
  const ext = extensionOf(display);
  const stem = ext ? display.slice(0, display.length - ext.length - 1) : display;
  const slug =
    stem
      .normalize('NFKD')
      .replace(/[\u{300}-\u{36f}]/gu, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .slice(0, 60)
      .replace(/[-._]+$/, '') || 'file';
  return `${slug}-${sha256.slice(0, 8)}${ext ? `.${ext}` : ''}`;
}

/** Whether a name is one the host's `put` accepts (what {@link stagedName} makes): plain ASCII, no leading dot, bounded. */
export const STAGED_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/** Characters RFC 5987 lets stand in `filename*`; everything else is percent-encoded. */
const encode5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * A `Content-Disposition` value: the name made safe for a quoted header value (printable ASCII, no quote,
 * backslash or percent), with `filename*` carrying the real name in UTF-8 when that changed it.
 */
export function dispositionHeader(kind: 'attachment' | 'inline', name: string): string {
  const real = [...displayName(name, 'download')].slice(0, 200).join('');
  const safe = real.replace(/[^\x20-\x7e]|["\\%]/g, '_').trim() || 'download';
  return safe === real ? `${kind}; filename="${safe}"` : `${kind}; filename="${safe}"; filename*=UTF-8''${encode5987(real)}`;
}

/** A name for a zip entry: unique within the archive ("a.txt", "a (2).txt", …); `taken` records what is used. */
export function uniqueEntryName(name: string, taken: Set<string>): string {
  // The characters Windows refuses in a name (a colon there starts an alternate data stream) aren't kept either.
  const base = displayName(name, 'file').replace(/[<>:"|?*]/g, '_');
  let candidate = base;
  const dot = base.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}
