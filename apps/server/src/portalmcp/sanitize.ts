import { redact, REDACTED } from '../chat/redact.js';

// Portal MCP (portal-mcp PRD §14.3, §14.4): everything a tool returns passes through here, and the
// arguments a caller sends are checked here first. Text from workspaces, agents and other third parties
// is untrusted: it can carry prompt injection to a model that holds portal tools, and it can carry
// credentials. Nothing here looks up a stored secret: shapes only, like chat/redact.ts.

export { REDACTED };

/** The most one untrusted text field carries (§14.4). */
export const UNTRUSTED_MAX = 2_000;
/** A hard stop for any one string in a result, for text a handler forgot to cap. */
export const STRING_MAX = 20_000;

/* eslint-disable no-control-regex */
// ANSI: CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC \`), and any other two-character escape.
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const ANSI_OTHER = /\x1b[@-Z\\-_]?/g;
// C0 controls except tab and newline, DEL, and the C1 range (which holds the 8-bit CSI and OSC).
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */
// Bidirectional overrides and isolates: they reorder text so what's shown differs from what's read.
const BIDI = /[\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;
// Zero-width and invisible formatting characters, soft hyphen, BOM.
const INVISIBLE = /[\u{ad}\u{180e}\u{200b}-\u{200d}\u{2060}-\u{2064}\u{feff}]/gu;
// Unicode tag characters (an invisible alphabet that smuggles instructions) and the supplementary
// variation selectors (the same trick). The basic selectors (emoji presentation) stay.
const TAGS = /[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const LINE_SEPARATORS = /[\u{2028}\u{2029}]/gu;

/** Strips what must never reach a model or a terminal: escape sequences, controls, bidi, invisible and tag characters. */
export function stripUnsafe(text: string): string {
  return text
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_OTHER, '')
    .replace(/\r\n?/g, '\n')
    .replace(LINE_SEPARATORS, '\n')
    .replace(CONTROLS, '')
    .replace(BIDI, '')
    .replace(INVISIBLE, '')
    .replace(TAGS, '');
}

/* ---------- Secrets ---------- */

// Shapes the chat redactor doesn't know (it covers Anthropic, GitHub, AWS, Slack, PEM, `Bearer …`, and
// `name: value` assignments). The portal's own tokens come first: they must never be echoed.
const EXTRA_SHAPES: RegExp[] = [
  /(?<![A-Za-z0-9])cp(?:at|oa|or|st|en)_[A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z0-9])sk-(?:proj-|live-|svcacct-)?[A-Za-z0-9_-]{24,}/g,
  /(?<![A-Za-z0-9])(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/g,
];

/** Replaces every credential-shaped part of `text` with `[redacted]`. Idempotent. */
export function redactSecrets(text: string): string {
  let out = redact(text);
  for (const re of EXTRA_SHAPES) out = out.replace(re, REDACTED);
  return out;
}

/** Whether text holds a credential-shaped part. */
export const looksLikeSecret = (text: string): boolean => redactSecrets(text) !== text;

/**
 * The path of the first string in `value` that looks like a secret, or null (§14.3). A caller that
 * pastes a key into an argument has already put it in a chat history: the call is refused and the
 * audit row stores `[redacted]`.
 */
export function findSecret(value: unknown, path = '', depth = 0): string | null {
  if (depth > 12) return null;
  if (typeof value === 'string') return looksLikeSecret(value) ? path || '(value)' : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecret(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const hit = findSecret(v, path ? `${path}.${k}` : k, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/* ---------- Text and results ---------- */

/** Escapes stripped, secrets redacted, capped at `max` characters (an ellipsis marks the cut). */
export function cleanText(text: string, max = STRING_MAX): string {
  const clean = redactSecrets(stripUnsafe(text));
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Text that came from an agent, a workspace, a runtime or another third party, labelled for the model. */
export interface UntrustedText {
  untrusted_text: string;
  /** Where it came from: `agent`, `runtime`, `delivery`, `ticket`, `imported`, `client`. */
  source: string;
}

/** Wraps untrusted text (§14.4): cleaned, capped at 2,000 characters, labelled with its source. Null stays null. */
export function untrusted(text: string | null | undefined, source: string, max = UNTRUSTED_MAX): UntrustedText | null {
  if (text === null || text === undefined) return null;
  return { untrusted_text: cleanText(String(text), max), source };
}

/**
 * Cleans every string in a result (keys too), as a backstop behind the handlers: a secret or an escape
 * sequence a handler forgot to treat never leaves the portal. Not a replacement for wrapping untrusted
 * text with {@link untrusted}, which says where it came from.
 */
export function deepClean<T>(value: T, depth = 0): T {
  if (depth > 16) return value;
  if (typeof value === 'string') return cleanText(value) as T;
  if (Array.isArray(value)) return value.map((v) => deepClean(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[cleanText(k, 200)] = deepClean(v, depth + 1);
    return out as T;
  }
  return value;
}

/** A short, safe rendering of arguments for the audit trail: redacted, capped (§9: at most 2 KB). */
export function auditArgs(args: unknown, max = 2_048): string | null {
  if (args === undefined || args === null) return null;
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    return null;
  }
  if (!json || json === '{}') return null;
  const clean = cleanText(json, max + 1);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
