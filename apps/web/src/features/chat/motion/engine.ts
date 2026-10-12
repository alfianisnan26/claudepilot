import { advance, shown, type Arrival, type PaceConfig } from './pacing';
import { PACE } from './tokens';
import { holdEnd, scanWords } from './words';

/** A gap between frames longer than this means the page was not running; what it missed is not animated when it comes back. */
const STALL_MS = 1000;

/** What the page shows of the reply at one moment. */
export interface RevealView {
  /** Everything that has arrived (the Markdown is parsed whole, so structure resolves before its words show). */
  text: string;
  /** How far into `text` the reveal has reached: the end of the last word shown. */
  cut: number;
  /** Words that end at or before this offset have finished their animation. */
  staticCut: number;
}

/**
 * The reveal of one reply: what has arrived, which words are complete, and how many are shown. It holds no
 * timers: the caller feeds it text as it arrives and steps it on each frame with a clock reading, so it runs
 * the same under a fake clock in a test.
 *
 * The text only grows. Anything that is not a continuation of what it holds (the reply was replaced by
 * another) starts over.
 */
export class RevealEngine {
  #text = '';
  #ended = false;
  #endedAt: number | null = null;
  #ends: number[] = [];
  #scanned = 0;
  #arrivals: Arrival[] = [];
  #pos = 0;
  #from: number | null = null;
  /** (time, words shown) as the reveal went, to know which words have finished playing. */
  #log: { t: number; n: number }[] = [];
  #lastShown = 0;
  #revealedAt = -Infinity;
  readonly #cfg: PaceConfig & { freshMs: number };

  constructor(cfg: PaceConfig & { freshMs: number } = PACE) {
    this.#cfg = cfg;
  }

  get text(): string {
    return this.#text;
  }

  /** Words that are complete (the last one is held back until whitespace follows it, or the stream ends). */
  get words(): number {
    return this.#ends.length;
  }

  /** The reveal has shown every word, the stream has ended, and the last word has finished playing. */
  settledAt(now: number): boolean {
    return this.#ended && this.#lastShown >= this.#ends.length && now - this.#revealedAt >= this.#cfg.freshMs;
  }

  /** There is something to do on the next frame: words waiting to show, or shown words yet to go plain. */
  busy(now: number): boolean {
    return this.#lastShown < this.#ends.length || now - this.#revealedAt < this.#cfg.freshMs || (this.#ended && !this.settledAt(now));
  }

  reset(): void {
    this.#text = '';
    this.#ended = false;
    this.#endedAt = null;
    this.#ends = [];
    this.#scanned = 0;
    this.#arrivals = [];
    this.#pos = 0;
    this.#from = null;
    this.#log = [];
    this.#lastShown = 0;
    this.#revealedAt = -Infinity;
  }

  /** The reply as it stands (`text` grows; `ended` once the stream has finished). */
  feed(text: string, ended: boolean, now: number): void {
    if (text !== this.#text && !text.startsWith(this.#text)) this.reset();
    const before = this.#ends.length;
    // Nothing was waiting: the clock for this burst starts now, not at the last frame of the one before.
    if (this.#lastShown >= before) this.#from = now;
    this.#text = text;
    // Words are only complete up to where the Markdown cannot change under them (see holdEnd); once the stream has ended, all of it.
    const usable = ended ? text.length : holdEnd(text);
    if (usable > this.#scanned) this.#scanned = Math.max(this.#scanned, scanWords(usable === text.length ? text : text.slice(0, usable), this.#scanned, ended, this.#ends));
    if (ended && !this.#ended) {
      this.#ended = true;
      this.#endedAt = now;
    }
    const total = this.#ends.length;
    if (total > before) this.#arrivals.push({ t: now, total });
  }

  /** Moves the reveal to `now`. With `plain` (reduced motion) everything that has arrived shows at once, with no animation. */
  step(now: number, plain = false): RevealView {
    const total = this.#ends.length;
    const from = this.#from ?? now;
    this.#from = now;
    this.#pos = plain ? total : advance(this.#pos, from, now, this.#arrivals, this.#endedAt, this.#cfg);
    const n = shown(this.#pos, total);
    if (n !== this.#lastShown) {
      this.#lastShown = n;
      this.#revealedAt = now;
      // After a long stall (a hidden tab, a frozen page) what shows now was due long ago: it just appears, plain.
      if (now - from > STALL_MS) this.#log = [{ t: -Infinity, n }];
      else this.#log.push({ t: now, n });
    }
    // Arrivals that have fully shown no longer matter.
    let drop = 0;
    while (drop < this.#arrivals.length - 1 && this.#arrivals[drop]!.total <= this.#pos) drop++;
    if (drop) this.#arrivals.splice(0, drop);
    // Words shown more than `freshMs` ago have finished playing: the last log entry at or before then says how many.
    let playedN = 0;
    let keep = 0;
    for (let i = 0; i < this.#log.length; i++) {
      if (this.#log[i]!.t <= now - this.#cfg.freshMs) {
        playedN = this.#log[i]!.n;
        keep = i;
      } else break;
    }
    if (keep > 0) this.#log.splice(0, keep);
    if (plain) playedN = n;
    const cut = n > 0 ? (this.#ends[n - 1] ?? 0) : 0;
    const staticCut = playedN > 0 ? (this.#ends[playedN - 1] ?? 0) : 0;
    return { text: this.#text, cut, staticCut };
  }
}
