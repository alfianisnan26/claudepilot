// The registry of the portal's own background loops (T-965, general-manager PRD §9.2; T-968 S2b). Each loop defines itself once, at import,
// and calls its heartbeat: `started()` and `stopped()` with its timer, `ok()` or `fail(err)` at the end of every pass. The list says when
// each ran last, how that went, when it runs next, and marks a loop `stale` when it runs but has not beaten for two intervals (it hangs, or
// its timer died). In memory only: a restart starts every loop again, and what matters is whether it beats now.
//
// Nothing heavy is imported here: every loop's module imports this file.

import type { ScheduleRow } from '@portal/contracts';
import { redactSecrets } from '../portalmcp/sanitize.js';

export interface LoopDef {
  /** Unique, kebab-case: `orphan-sweep`, `triggers-cron`. */
  name: string;
  /** The module that owns the loop. */
  module: string;
  intervalMs: number;
  /** One line: what a pass does. */
  description: string;
}

/** What a loop calls. Every method takes the time for tests; the clock by default. */
export interface LoopHeartbeat {
  readonly name: string;
  started(at?: Date): void;
  stopped(): void;
  ok(at?: Date): void;
  fail(err: unknown, at?: Date): void;
}

interface LoopState {
  def: LoopDef;
  running: boolean;
  startedAt: number | null;
  lastRun: number | null;
  lastResult: 'ok' | 'failed' | null;
  lastError: string | null;
}

/** A loop is stale when its last beat (or its start, before the first) is older than this many intervals. */
export const STALE_INTERVALS = 2;
const ERROR_MAX = 200;

export const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** The trigger fields of a row that is not a trigger. */
export const NOT_A_TRIGGER = { source: null, owner: null, target: null, action: null, enabled: null } as const;

export class LoopRegistry {
  readonly #loops = new Map<string, { state: LoopState; beat: LoopHeartbeat }>();

  /** Defines a loop and returns its heartbeat. The same name again returns the same heartbeat (a module may load twice in tests). */
  define(def: LoopDef): LoopHeartbeat {
    const known = this.#loops.get(def.name);
    if (known) return known.beat;
    const s: LoopState = { def: { ...def }, running: false, startedAt: null, lastRun: null, lastResult: null, lastError: null };
    const beat: LoopHeartbeat = {
      name: def.name,
      started: (at = new Date()) => {
        s.running = true;
        s.startedAt = at.getTime();
      },
      stopped: () => {
        s.running = false;
      },
      ok: (at = new Date()) => {
        s.lastRun = at.getTime();
        s.lastResult = 'ok';
        s.lastError = null;
      },
      fail: (err, at = new Date()) => {
        s.lastRun = at.getTime();
        s.lastResult = 'failed';
        const message = err instanceof Error ? err.message : String(err);
        s.lastError = redactSecrets(message).slice(0, ERROR_MAX);
      },
    };
    this.#loops.set(def.name, { state: s, beat });
    return beat;
  }

  names(): string[] {
    return [...this.#loops.keys()].sort();
  }

  /** One row per loop, by name. */
  rows(now: Date = new Date()): ScheduleRow[] {
    return this.names().map((name) => rowOf(this.#loops.get(name)!.state, now.getTime()));
  }
}

function rowOf(s: LoopState, now: number): ScheduleRow {
  const since = s.lastRun ?? s.startedAt;
  const stale = s.running && since !== null && now - since > STALE_INTERVALS * s.def.intervalMs;
  const state = !s.running ? 'stopped' : stale ? 'stale' : s.lastResult === 'failed' ? 'failing' : 'ok';
  return {
    id: `loop:${s.def.name}`,
    kind: 'loop',
    name: s.def.name,
    module: s.def.module,
    description: s.def.description,
    interval_ms: s.def.intervalMs,
    cron: null,
    last_run: iso(s.lastRun),
    last_result: s.lastResult,
    last_error: s.lastError,
    next_run: s.running && since !== null ? iso(since + s.def.intervalMs) : null,
    state,
    ...NOT_A_TRIGGER,
  };
}

/** The portal's own loops. */
export const portalLoops = new LoopRegistry();

/** Defines one of the portal's loops (at import, in the loop's own module). */
export const defineLoop = (def: LoopDef): LoopHeartbeat => portalLoops.define(def);
