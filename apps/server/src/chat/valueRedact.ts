// Chat sessions: redaction of the secret VALUES the portal delivered into a workspace (Secrets & env PRD A9, QA-006).
// `redact.ts` finds credentials by shape; a secret with no recognisable shape (a password, an internal token) is only
// found by what it is. The values arrive as plain strings from the Secrets module, only in memory, and stay inside
// the objects here: nothing logs, stores or returns one. Each value is matched in the forms a tool prints it: as
// it is, JSON-escaped, URL-encoded, and base64 (and base64url) wherever it starts inside a longer string.

import { REDACTED, StreamRedactor } from './redact.js';

/** A value shorter than this is never matched: a short "secret" would blank ordinary text. */
export const MIN_VALUE = 6;
/** A value longer than this is left to its lines (a key file) and the shape redactor. */
const MAX_VALUE = 16_384;
/** The most values one redactor holds. */
const MAX_VALUES = 800;
/** A live stream holds back at most this many characters while a tail could still be the start of a value. */
export const MAX_VALUE_HOLD = 512;

/** Every form of `value` a tool may print, longest first. Each is at least {@link MIN_VALUE} characters. */
export function variantsOf(value: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    if (s.length >= MIN_VALUE) out.add(s);
  };
  add(value);
  add(JSON.stringify(value).slice(1, -1));
  const url = encodeURIComponent(value);
  add(url);
  add(url.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  add(url.replace(/%20/g, '+'));
  // base64: the same bytes encode differently by where they start in the string (three alignments), and the
  // characters a neighbour's bits share are left out, so the value is found inside a longer encoded string.
  const bytes = Buffer.from(value, 'utf8');
  for (let k = 0; k < 3; k++) {
    const b64 = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64');
    const skip = [0, 2, 3][k]!;
    const strip = [0, 3, 2][(k + bytes.length) % 3]!;
    for (const form of [b64.slice(skip), b64.slice(skip, b64.length - strip)]) {
      add(form);
      add(form.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Many literal needles found in a text quickly: bucketed by their first two characters. */
class Needles {
  readonly #pairs = new Map<number, string[]>();
  readonly #firsts = new Map<number, string[]>();
  /** The longest needle: nothing longer can be partly seen at the end of a text. */
  readonly longest: number;

  constructor(needles: string[]) {
    let longest = 0;
    for (const n of needles) {
      if (n.length > longest) longest = n.length;
      const pair = n.charCodeAt(0) * 65_536 + n.charCodeAt(1);
      (this.#pairs.get(pair) ?? this.#pairs.set(pair, []).get(pair)!).push(n);
      (this.#firsts.get(n.charCodeAt(0)) ?? this.#firsts.set(n.charCodeAt(0), []).get(n.charCodeAt(0))!).push(n);
    }
    for (const list of this.#pairs.values()) list.sort((a, b) => b.length - a.length);
    this.longest = longest;
  }

  get size(): number {
    let n = 0;
    for (const list of this.#firsts.values()) n += list.length;
    return n;
  }

  /** Where a needle sits in `text`: sorted, non-overlapping ranges, the longest needle winning at each place. */
  find(text: string): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < text.length; i++) {
      const list = this.#pairs.get(text.charCodeAt(i) * 65_536 + text.charCodeAt(i + 1));
      if (!list) continue;
      for (const n of list) {
        if (text.startsWith(n, i)) {
          out.push([i, i + n.length]);
          i += n.length - 1;
          break;
        }
      }
    }
    return out;
  }

  /** Whether `text` from `at` to its end is the start of a longer needle (so a stream must wait for more). */
  startsOne(text: string, at: number): boolean {
    const list = this.#firsts.get(text.charCodeAt(at));
    if (!list) return false;
    const have = text.length - at;
    next: for (const n of list) {
      if (n.length <= have) continue;
      for (let j = 1; j < have; j++) if (text.charCodeAt(at + j) !== n.charCodeAt(j)) continue next;
      return true;
    }
    return false;
  }
}

/** `text` with the ranges replaced by {@link REDACTED}. */
function blank(text: string, ranges: [number, number][], to = text.length): string {
  let out = '';
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s >= to) break;
    out += text.slice(pos, s) + REDACTED;
    pos = e;
  }
  return out + text.slice(pos, to);
}

/** The secret values of one workspace, ready to take out of text. Holds them in memory only. */
export class ValueRedactor {
  readonly #needles: Needles | null;

  constructor(values: readonly string[]) {
    const all = new Set<string>();
    let count = 0;
    for (const raw of values) {
      if (typeof raw !== 'string' || raw.length < MIN_VALUE || raw.length > MAX_VALUE || count >= MAX_VALUES) continue;
      count++;
      for (const v of variantsOf(raw)) all.add(v);
    }
    this.#needles = all.size ? new Needles([...all]) : null;
  }

  /** Whether there is anything to look for. */
  get active(): boolean {
    return this.#needles !== null;
  }

  /** `text` with every secret value (in any form) replaced by {@link REDACTED}. */
  redact(text: string): string {
    if (!text || !this.#needles) return text;
    const ranges = this.#needles.find(text);
    return ranges.length ? blank(text, ranges) : text;
  }

  /** A stream that redacts as text arrives, holding back a tail that could still become a value. */
  stream(): ValueStream {
    return new ValueStream(this.#needles);
  }
}

/** No values: text passes through. */
export const NO_VALUES = new ValueRedactor([]);

/** Redacts one open text block as it streams: what could still be the start of a value waits for the next delta. */
export class ValueStream {
  #held = '';

  constructor(private readonly needles: Needles | null) {}

  get holding(): number {
    return this.#held.length;
  }

  push(text: string): string {
    const needles = this.needles;
    if (!needles) return text;
    const all = this.#held + text;
    this.#held = '';
    const ranges = needles.find(all);
    // The tail that is the start of a longer value waits (never past a complete one, and never more than MAX_VALUE_HOLD).
    const after = ranges.length ? ranges[ranges.length - 1]![1] : 0;
    let hold = all.length;
    for (let i = Math.max(after, all.length - Math.min(needles.longest - 1, MAX_VALUE_HOLD)); i < all.length; i++) {
      if (needles.startsOne(all, i)) {
        hold = i;
        break;
      }
    }
    this.#held = all.slice(hold);
    return blank(all, ranges, hold);
  }

  /** The block ended: what was held goes out (it never became a value). */
  flush(): string {
    const out = this.#held;
    this.#held = '';
    return out;
  }
}

/** A session's live text stream: secret values out first, then credential shapes. */
export class SessionStream {
  readonly #values: ValueStream;
  readonly #shapes = new StreamRedactor();

  constructor(values: ValueRedactor) {
    this.#values = values.stream();
  }

  get holding(): number {
    return this.#values.holding + this.#shapes.holding;
  }

  push(text: string): string {
    return this.#shapes.push(this.#values.push(text));
  }

  flush(): string {
    return this.#shapes.push(this.#values.flush()) + this.#shapes.flush();
  }
}
