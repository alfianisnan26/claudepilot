// The orphan sweep's loop (T-270 layer 2): once a minute, jittered, one pass at a time (`Tickets.sweepOrphans` is synchronous, so a pass
// never overlaps the next), restart safe (the last pass is in `portal_meta`: a restart waits for the rest of that minute, the delay per
// dead session survives too). The rules themselves are in the service.

import './settings.js';
import type { Tickets } from './service.js';

export const ORPHAN_SWEEP_MS = 60_000;
const JITTER_MS = 10_000;

type Timer = { unref?: () => void };

export interface OrphanSweepOptions {
  intervalMs?: number;
  jitterMs?: number;
  now?: () => Date;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

export class OrphanSweep {
  #timer: Timer | null = null;
  #stopped = true;
  readonly #o: Required<OrphanSweepOptions>;

  constructor(
    private readonly tickets: Pick<Tickets, 'sweepOrphans' | 'orphanLastRun'>,
    opts: OrphanSweepOptions = {},
  ) {
    this.#o = {
      intervalMs: opts.intervalMs ?? ORPHAN_SWEEP_MS,
      jitterMs: opts.jitterMs ?? JITTER_MS,
      now: opts.now ?? (() => new Date()),
      random: opts.random ?? Math.random,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)),
    };
  }

  /** The first pass: the rest of the minute since the last one (none or long ago: now), plus jitter. */
  firstDelay(): number {
    const last = this.tickets.orphanLastRun();
    const since = last ? this.#o.now().getTime() - Date.parse(last) : Infinity;
    const rest = Number.isFinite(since) ? Math.min(Math.max(this.#o.intervalMs - since, 0), this.#o.intervalMs) : 0;
    return rest + Math.floor(this.#o.random() * this.#o.jitterMs);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(this.firstDelay());
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) this.#o.clearTimer(this.#timer);
    this.#timer = null;
  }

  #schedule(ms: number) {
    this.#timer = this.#o.setTimer(() => this.#tick(), ms);
    this.#timer.unref?.();
  }

  #tick() {
    this.#timer = null;
    if (this.#stopped) return;
    try {
      this.tickets.sweepOrphans();
    } catch (e) {
      console.error(`[tickets] the orphan sweep failed: ${(e as Error).message}`);
    } finally {
      if (!this.#stopped) this.#schedule(this.#o.intervalMs + Math.floor(this.#o.random() * this.#o.jitterMs));
    }
  }
}
