// Chat sessions: pattern-based redaction of credential-shaped text (chat-sessions PRD §13). Shapes
// only — nothing here looks up a stored secret. `redact` cleans whole text before it's stored;
// `StreamRedactor` cleans live deltas, holding back a short tail while it could still turn into a
// credential, so a key split across deltas never reaches a browser.

export const REDACTED = '[redacted]';

/** The most a stream ever holds back (every shape below is decided within this many characters). */
export const MAX_HOLD = 64;

/** Emitted text a stream keeps as left context: names before `=`, `Bearer`, word boundaries. */
const CONTEXT = 160;
/** Tail matchers look at most this far back from the end. */
const TAIL_WINDOW = 256;

/* ---------- Shapes ---------- */

type Kind = 'anthropic' | 'github' | 'aws' | 'slack' | 'portal' | 'webhook' | 'pem' | 'bearer' | 'assign' | 'kv' | 'userinfo';

interface Shape {
  kind: Kind;
  /** Complete matches: global, with indices. */
  re: RegExp;
  /** The capture group that is replaced; the whole match when absent. */
  group?: number;
  /** Characters that continue a credential already replaced; `pem` runs to the END line. */
  swallow?: string;
}

const PEM_HEADER = '-----BEGIN [A-Z0-9 ]{0,24}PRIVATE KEY[A-Z ]{0,8}-----';
const PEM_FOOTER = '-----END [A-Z0-9 ]{0,24}PRIVATE KEY[A-Z ]{0,8}-----';
const VALUE = '[A-Za-z0-9+/=_.~-]';
const NAME = '[A-Za-z0-9_.-]{0,40}(?:key|token|secret|password|passwd|pwd)[A-Za-z0-9_.-]{0,40}';

// T-1065: a name that ENDS in password, passwd, pwd, secret or token, then `=` or `:` (not `==`, `=>`): its value goes at any length.
// `max_tokens: 1024` and `secretName: x` do not end in the word, so they stay.
const KV_NAME = '(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,40}(?:password|passwd|pwd|secret|token)["\']?[ \\t]{0,4}[:=](?![=>])[ \\t]{0,4}';
// An unquoted value runs to a space, a quote or a delimiter (`&` ends a query value). Type names, `null`-like words and
// environment references are code, not a value: `password: string`, `password: process.env.DB_PASSWORD` stay.
const KV_UNQUOTED = '[^\\s"\'`&;,<>(){}\\[\\]]';
const KV_CODE =
  '(?!(?:string|number|boolean|null|undefined|true|false|any|unknown|never|none|nil)(?![A-Za-z0-9_$])|process\\.env\\.|import\\.meta\\.env\\.|os\\.environ|os\\.getenv\\()';
// A quoted value runs to its closing quote (an escaped quote stays inside), or to the end of the line when it has none yet.
const kvQuoted = (q: string) => `[^${q}\\\\\\n]|\\\\.?`;
// `scheme://user:pass@host`: only the password goes (it may hold an `@`; the last one before the host ends it).
const USERINFO_HEAD = '[a-z][a-z0-9+.-]{0,30}:\\/\\/[^\\s:@\\/?#]{0,128}:';

const SHAPES: Shape[] = [
  // Anthropic: sk-ant-api03-…, sk-ant-oat01-…, sk-ant-admin01-…
  { kind: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{8,}/dg, swallow: '[A-Za-z0-9_-]' },
  // GitHub: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained (github_pat_).
  { kind: 'github', re: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/dg, swallow: '[A-Za-z0-9_]' },
  // AWS access key ids: exactly 20 characters, so they're never "open" in a stream.
  { kind: 'aws', re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/dg },
  { kind: 'slack', re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/dg, swallow: '[A-Za-z0-9-]' },
  // The portal's own tokens: admin access (cpat_), OAuth access and refresh (cpoa_, cpor_), an enrollment token (cpen_, Connect) and a session's agent token
  // (cpst_), which sits in the environment of that session's Claude Code process and so can be printed by a tool.
  // Notifications and triggers (platform track): an answer token (cpna_), a trigger's webhook secret (cpwh_), a channel's signing secret
  // (cpws_) and a notification secret (cpns_).
  { kind: 'portal', re: /(?<![A-Za-z0-9])cp(?:at|oa|or|st|en|na|wh|ws|ns)_[A-Za-z0-9_-]{20,}/dg, swallow: '[A-Za-z0-9_-]' },
  // Discord and Slack incoming-webhook URLs carry their secret in the path: the secret part goes.
  { kind: 'webhook', re: /(https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d{1,2}\/)?webhooks\/)(\d{5,30}\/[A-Za-z0-9_-]{20,})/dgi, group: 2, swallow: '[A-Za-z0-9_-]' },
  { kind: 'webhook', re: /(https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)([A-Za-z0-9_\/-]{20,})/dgi, group: 2, swallow: '[A-Za-z0-9_/-]' },
  // A private key block; one without its END line runs to the end of the text.
  { kind: 'pem', re: new RegExp(`${PEM_HEADER}[\\s\\S]*?(?:${PEM_FOOTER}|$)`, 'dg'), swallow: 'pem' },
  // `Bearer <token>` with a long token: only the token goes.
  { kind: 'bearer', re: /(?<![A-Za-z0-9])(Bearer[ \t]+)([A-Za-z0-9\-._~+/]{20,}=*)/dgi, group: 2, swallow: '[A-Za-z0-9\\-._~+/=]' },
  // `api_key=…`, `"token": "…"`, `password: …`, `X-Api-Key: …` with a long value: only the value goes. A
  // value needs a digit and a letter in its first 32 characters, which keeps identifiers in code out.
  {
    kind: 'assign',
    re: new RegExp(`(?<![A-Za-z0-9_.-])(${NAME}["']?[ \\t]{0,4}[:=][ \\t]{0,4}["']?)((?=${VALUE}{0,31}[0-9])(?=${VALUE}{0,31}[A-Za-z])${VALUE}{16,})`, 'dgi'),
    group: 2,
    swallow: VALUE,
  },
  // T-1065: `password=hunter2`, `pwd: x`, `"token":"v"`, `secret='a b'`: the value goes, at any length.
  { kind: 'kv', re: new RegExp(`${KV_NAME})${KV_CODE}(${KV_UNQUOTED}+)`, 'dgi'), group: 2, swallow: KV_UNQUOTED },
  { kind: 'kv', re: new RegExp(`${KV_NAME}")((?:${kvQuoted('"')})+)`, 'dgi'), group: 2, swallow: kvQuoted('"') },
  { kind: 'kv', re: new RegExp(`${KV_NAME}')((?:${kvQuoted("'")})+)`, 'dgi'), group: 2, swallow: kvQuoted("'") },
  // T-1065: the password of URL userinfo; the scheme, the user and the host stay. Never open at the end (it needs its `@`).
  { kind: 'userinfo', re: new RegExp(`(${USERINFO_HEAD})([^\\s\\/?#]+)@`, 'dgi'), group: 2 },
];

/** Cheap pre-check: text with none of these can't hold a complete match. */
const TRIGGER = /sk-ant-|gh[pousr]_|github_pat_|AKIA|ASIA|xox[abprs]-|cp(?:at|oa|or|st|en|na|wh|ws|ns)_|webhooks\/|hooks\.slack|PRIVATE KEY|bearer|key|token|secret|passw|pwd|:\/\//i;

interface RawSpan {
  start: number;
  end: number;
  shape: Shape;
}

function rawSpans(text: string): RawSpan[] {
  if (!TRIGGER.test(text)) return [];
  const out: RawSpan[] = [];
  for (const shape of SHAPES) {
    for (const m of text.matchAll(shape.re)) {
      const at: readonly [number, number] | undefined = shape.group ? m.indices?.[shape.group] : [m.index, m.index + m[0].length];
      if (at && at[1] > at[0]) out.push({ start: at[0], end: at[1], shape });
    }
  }
  return out;
}

/** Sorted, merged replacement ranges (touching ranges become one). */
function merge(spans: { start: number; end: number }[]): [number, number][] {
  const sorted = spans.map((s): [number, number] => [s.start, s.end]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push(s);
  }
  return out;
}

/** `text.slice(from, to)` with every range inside it replaced by {@link REDACTED}. */
function apply(text: string, ranges: [number, number][], from = 0, to = text.length): string {
  let out = '';
  let pos = from;
  for (const [s, e] of ranges) {
    if (e <= pos || s >= to) continue;
    out += text.slice(pos, Math.max(s, pos)) + REDACTED;
    pos = Math.min(e, to);
  }
  return out + text.slice(pos, to);
}

/** Replaces every credential-shaped part of `text` with {@link REDACTED}. Idempotent. */
export function redact(text: string): string {
  if (!text) return text;
  const spans = rawSpans(text);
  return spans.length ? apply(text, merge(spans)) : text;
}

/** {@link redact} for optional values. */
export function redactMaybe<T extends string | null | undefined>(text: T): T {
  return (typeof text === 'string' ? redact(text) : text) as T;
}

/* ---------- Streams ---------- */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every proper, non-empty prefix of the literals, as regex alternatives. */
function prefixes(literals: string[]): string {
  const set = new Set<string>();
  for (const lit of literals) for (let i = 1; i < lit.length; i++) set.add(lit.slice(0, i));
  return [...set].map(esc).join('|');
}

/** A credential that starts with a fixed literal; a tail is "maybe" until the body reaches `min`. */
interface LiteralTail {
  re: RegExp;
  literals: string[];
  min: number;
}

function literalTail(literals: string[], body: string, min: number, boundary: boolean): LiteralTail {
  const lb = boundary ? '(?<![A-Za-z0-9])' : '';
  return { re: new RegExp(`${lb}(?:${prefixes(literals)}|(?:${literals.map(esc).join('|')})${body}*)$`, 'd'), literals, min };
}

const LITERAL_TAILS: LiteralTail[] = [
  literalTail(['sk-ant-'], '[A-Za-z0-9_-]', 8, false),
  literalTail(['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'], '[A-Za-z0-9]', 20, true),
  literalTail(['github_pat_'], '[A-Za-z0-9_]', 20, true),
  literalTail(['xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-'], '[A-Za-z0-9-]', 10, true),
  literalTail(['cpat_', 'cpoa_', 'cpor_', 'cpst_', 'cpen_', 'cpna_', 'cpwh_', 'cpws_', 'cpns_'], '[A-Za-z0-9_-]', 20, true),
  literalTail(['AKIA', 'ASIA'], '[A-Z0-9]', 16, true),
];

/** Any prefix of a PEM header (`-`, `-----BEG`, `-----BEGIN RSA PRIV`, …) at the end of the text. */
const PEM_HEAD_PARTS = ['-', '-', '-', '-', '-', 'B', 'E', 'G', 'I', 'N', ' ', '[A-Z0-9 ]{0,24}', 'P', 'R', 'I', 'V', 'A', 'T', 'E', ' ', 'K', 'E', 'Y', '[A-Z ]{0,8}', '-', '-', '-', '-'];
const PEM_HEAD_TAIL = new RegExp(`${PEM_HEAD_PARTS.reduceRight((rest, part, i) => (i === 0 ? part + rest : `(?:${part}${rest})?`), '')}$`, 'd');
const PEM_END = new RegExp(PEM_FOOTER);
/** Longest END line: a stream in a key block keeps this much to spot one split across deltas. */
const PEM_END_MAX = 57;

const BEARER_TAIL = /(?<![A-Za-z0-9])Bearer[ \t]+([A-Za-z0-9\-._~+/]*)$/di;
const ASSIGN_TAIL = new RegExp(`(?<![A-Za-z0-9_.-])${NAME}(["']?[ \\t]{0,4}(?:[:=][ \\t]{0,4}["']?(${VALUE}*))?)$`, 'di');
const ASSIGN_HINT = /key|token|secret|passw|pwd/i;
/** `scheme://user:pa` at the end: the password may still be growing, and only its `@` will tell (T-1065). */
const USERINFO_TAIL = new RegExp(`${USERINFO_HEAD}([^\\s\\/?#]*)$`, 'di');

/**
 * Where a credential might be starting at the end of `text` without being one yet: the index to hold
 * back from, or -1. Complete credentials are found by the full patterns instead.
 */
function maybeStart(text: string): number {
  const offset = Math.max(0, text.length - TAIL_WINDOW);
  const win = text.slice(offset);
  let at = -1;
  const take = (i: number) => {
    if (at < 0 || offset + i < at) at = offset + i;
  };
  for (const t of LITERAL_TAILS) {
    const m = t.re.exec(win);
    if (!m) continue;
    const lit = t.literals.find((l) => m[0].startsWith(l));
    if (!lit || m[0].length - lit.length < t.min) take(m.index); // a literal's prefix, or too short a body yet
  }
  const pem = PEM_HEAD_TAIL.exec(win);
  if (pem) take(pem.index);
  const userinfo = win.includes('://') ? USERINFO_TAIL.exec(win) : null;
  if (userinfo) take(userinfo.indices![1]![0]);
  const bearer = BEARER_TAIL.exec(win);
  if (bearer?.[1] && bearer[1].length < 20) take(bearer.indices![1]![0]);
  if (ASSIGN_HINT.test(win.slice(-120))) {
    const m = ASSIGN_TAIL.exec(win);
    const sep = m?.indices?.[1];
    if (m && sep && sep[1] > sep[0]) {
      const value = m[2];
      const head = value?.slice(0, 32) ?? '';
      const complete = value !== undefined && value.length >= 16 && /[0-9]/.test(head) && /[A-Za-z]/.test(head);
      if (value === undefined || (!complete && value.length < 32)) take(sep[0]);
    }
  }
  return at;
}

/**
 * Redacts one open text block as it streams. `push` takes each delta and returns what can be shown
 * now: everything except a short tail (at most {@link MAX_HOLD} characters) that could still become a
 * credential. Once a credential is certain it's shown as {@link REDACTED} at once and the rest of it is
 * dropped as it arrives. `flush` ends the block and returns the held tail, redacted.
 */
export class StreamRedactor {
  /** Received but not shown yet (inside a key block: only kept to spot its END line). */
  #held = '';
  /** The end of what was shown, for names and word boundaries before new text. */
  #ctx = '';
  /** Inside a credential already replaced: the characters that continue it, or a key block. */
  #swallow: RegExp | 'pem' | null = null;

  /** How many characters are held back right now. */
  get holding(): number {
    return this.#swallow === 'pem' ? 0 : this.#held.length;
  }

  push(text: string): string {
    let s = this.#held + text;
    this.#held = '';
    let out = '';
    while (s) {
      if (this.#swallow === 'pem') {
        const end = PEM_END.exec(s);
        if (!end) {
          this.#held = s.slice(-PEM_END_MAX);
          break;
        }
        s = s.slice(end.index + end[0].length);
        this.#swallow = null;
        continue;
      }
      if (this.#swallow) {
        const n = this.#swallow.exec(s)?.[0].length ?? 0;
        this.#swallow.lastIndex = 0;
        if (n === s.length) break; // still inside it
        s = s.slice(n);
        this.#swallow = null;
        continue;
      }
      out += this.#step(s);
      s = '';
      if (this.#swallow === 'pem') {
        // #step left the key block's body (after its header) in #held: look for the END line in it.
        s = this.#held;
        this.#held = '';
      }
    }
    this.#ctx = (this.#ctx + out).slice(-CONTEXT);
    return out;
  }

  /** Ends the block: returns what's still held, redacted, and starts fresh. */
  flush(): string {
    let out = '';
    if (!this.#swallow && this.#held) {
      const t = this.#ctx + this.#held;
      out = apply(t, merge(rawSpans(t)), this.#ctx.length);
    }
    this.#held = '';
    this.#ctx = '';
    this.#swallow = null;
    return out;
  }

  /** One pass over new text `s` (nothing swallowing): returns what to show; sets #held / #swallow. */
  #step(s: string): string {
    const ctx = this.#ctx;
    const t = ctx + s;
    const base = ctx.length;
    const spans = rawSpans(t);
    // A complete match reaching the end may go on (a longer token, the rest of a key block); an AWS id
    // reaching the end isn't certain until the next character.
    const atEnd = spans.filter((x) => x.end === t.length);
    const closed = spans.filter((x) => x.end < t.length);
    let hold = t.length;
    for (const x of atEnd) hold = Math.min(hold, x.start);
    const maybe = maybeStart(t);
    if (maybe >= 0 && !closed.some((x) => x.start < maybe && maybe < x.end)) hold = Math.min(hold, maybe);
    hold = Math.max(hold, base);

    const shown = apply(t, merge(closed.filter((x) => x.start < hold)), base, hold);
    const open = atEnd.filter((x) => x.start <= hold && x.shape.kind !== 'aws');
    if (open.length && hold < t.length && hold !== maybe) {
      if (open.some((x) => x.shape.swallow === 'pem')) {
        this.#swallow = 'pem';
        // Keep the block's body after its header, to look for the END line.
        const header = new RegExp(PEM_HEADER).exec(t.slice(hold));
        this.#held = header ? t.slice(hold + header.index + header[0].length) : '';
      } else {
        const classes = [...new Set(open.map((x) => x.shape.swallow!))];
        this.#swallow = new RegExp(`(?:${classes.join('|')})*`, 'y');
      }
      return shown + REDACTED;
    }
    if (open.length && hold === maybe) {
      // A certain credential and a possible one start at the same place: certain wins.
      const certain = open.filter((x) => x.start === hold);
      if (certain.length) {
        if (certain.some((x) => x.shape.swallow === 'pem')) {
          this.#swallow = 'pem';
          const header = new RegExp(PEM_HEADER).exec(t.slice(hold));
          this.#held = header ? t.slice(hold + header.index + header[0].length) : '';
        } else {
          this.#swallow = new RegExp(`(?:${[...new Set(certain.map((x) => x.shape.swallow!))].join('|')})*`, 'y');
        }
        return shown + REDACTED;
      }
    }
    let held = t.slice(hold);
    let extra = '';
    if (held.length > MAX_HOLD) {
      // Never expected (every shape is decided within MAX_HOLD); release the front, redacted.
      const cut = t.length - MAX_HOLD;
      extra = apply(t, merge(spans.filter((x) => x.start < cut)), hold, cut);
      held = t.slice(cut);
    }
    this.#held = held;
    return shown + extra;
  }
}
