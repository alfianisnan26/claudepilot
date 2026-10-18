// The portal's own background loops, in one list (owner, 2026-10-18: "list of scheduler as well"; T-965). Each loop says its name, how often it
// runs and what it does when it starts; every run records when it ran, how long it took and whether it threw. The Schedules page reads this
// next to the cron triggers. Nothing here changes when or how a loop runs: `wrap` only measures the function it is given.

export interface LoopInfo {
  /** A stable id, `area.name`. */
  id: string;
  /** What it does, one short line. */
  what: string;
  everyMs: number;
  /** When it was registered (the portal's start, for most). */
  since: string;
  lastRunAt: string | null;
  lastMs: number | null;
  lastOk: boolean | null;
  /** The last failure's message, cut (never a secret: messages are the module's own). */
  lastError: string | null;
  runs: number;
  failures: number;
}

const loops = new Map<string, LoopInfo>();

/** Registers a loop and returns its runner: `setInterval(loop('x', MS, '…').wrap(fn), MS)`. Registering again replaces it (a test, a restart). */
export function loop(id: string, everyMs: number, what: string) {
  const info: LoopInfo = { id, what, everyMs, since: new Date().toISOString(), lastRunAt: null, lastMs: null, lastOk: null, lastError: null, runs: 0, failures: 0 };
  loops.set(id, info);
  const done = (t0: number, error: unknown) => {
    info.lastMs = Date.now() - t0;
    info.runs++;
    info.lastOk = error === undefined;
    if (error !== undefined) {
      info.failures++;
      info.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
  };
  return {
    info,
    /** The same function, measured: a promise counts when it settles. */
    wrap<A extends unknown[]>(fn: (...a: A) => unknown): (...a: A) => unknown {
      return (...a: A) => {
        const t0 = Date.now();
        info.lastRunAt = new Date(t0).toISOString();
        try {
          const r = fn(...a);
          if (r && typeof (r as Promise<unknown>).then === 'function') {
            return (r as Promise<unknown>).then(
              (v) => (done(t0, undefined), v),
              (e: unknown) => {
                done(t0, e ?? new Error('failed'));
                throw e;
              },
            );
          }
          done(t0, undefined);
          return r;
        } catch (e) {
          done(t0, e ?? new Error('failed'));
          throw e;
        }
      };
    },
  };
}

/** Every registered loop, by id. */
export function listLoops(): LoopInfo[] {
  return [...loops.values()].map((l) => ({ ...l })).sort((a, b) => a.id.localeCompare(b.id));
}
