// The cron tick (docs/prd/triggers.md FR2, FR11, §10 "Missed times"): every 30 seconds, every enabled cron trigger whose `next_run_at` has
// passed fires once, and its next time is computed from NOW (a late tick never makes a burst). A time more than a tick and a half in the
// past was missed (the portal was off or asleep): `catchUp: skip` records a `missed` skip, `once` runs it once. While the master switch is
// off the tick fires nothing and only moves the times on; while the database is Locked or Frozen it does nothing at all (R15). The same
// timer drives the runner's minute watch and the daily retention sweep.

import type { TriggerEventFacts } from '@portal/contracts';
import { defineLoop } from '../schedules/registry.js';
import { nextRunIso } from './cron.js';
import type { TriggerRunner } from './runner.js';
import type { TriggerRecord, TriggerStore } from './store.js';

export const TICK_MS = 30_000;

/** Its heartbeat in the schedules registry (T-968 S2b). A tick that finds the database locked still beats: the loop is alive. */
export const CRON_LOOP = defineLoop({ name: 'triggers-cron', module: 'triggers', intervalMs: TICK_MS, description: 'Fires the cron triggers that are due; the runner\'s minute watch; daily retention.' });
/** A due time older than this was missed rather than reached late by one tick. */
export const MISSED_AFTER_MS = 90_000;

export interface SchedulerDeps {
  store: TriggerStore;
  runner: TriggerRunner;
  masterOn(): boolean;
  now?: () => Date;
}

export function scheduleFacts(at: string): TriggerEventFacts {
  return { source: 'cron', provider: null, event: 'schedule', action: null, repo: null, branch: null, sha: null, number: null, sender: null, url: null, fork: null, at, untrusted: {} };
}

export class TriggerScheduler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticks = 0;
  #busy = false;
  readonly #now: () => Date;

  constructor(private readonly d: SchedulerDeps) {
    this.#now = d.now ?? (() => new Date());
  }

  start(): void {
    if (this.#timer) return;
    CRON_LOOP.started(this.#now());
    this.#timer = setInterval(() => void this.tick(), TICK_MS);
    this.#timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.#timer) CRON_LOOP.stopped();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One tick. Returns the triggers it fired (tests). */
  async tick(): Promise<string[]> {
    if (this.#busy) return [];
    if (this.d.runner.locked()) {
      CRON_LOOP.ok(this.#now());
      return [];
    }
    this.#busy = true;
    const fired: string[] = [];
    let failed: unknown = null;
    try {
      this.#ticks++;
      // Every other tick (a minute): the minutes limit and expired approvals; once a day (2,880 ticks): retention.
      if (this.#ticks % 2 === 1) this.d.runner.tick();
      if (this.#ticks % 2880 === 1) this.d.store.sweep();
      const now = this.#now();
      for (const t of this.d.store.bySource('cron')) {
        if (!t.cron) continue;
        if (!t.enabled) continue;
        if (!t.nextRunAt) {
          this.d.store.setNextRun(t.id, nextRunIso(t.cron.expr, t.cron.tz, now));
          continue;
        }
        const due = Date.parse(t.nextRunAt);
        if (due > now.getTime()) continue;
        // The next time first: whatever happens to this fire, the trigger never fires twice for one time.
        this.d.store.setNextRun(t.id, nextRunIso(t.cron.expr, t.cron.tz, now));
        if (!this.d.masterOn()) continue;
        await this.#fire(t, due, now.getTime() - due > MISSED_AFTER_MS);
        fired.push(t.id);
      }
    } catch (e) {
      failed = e;
      console.error(`[triggers] the cron tick failed: ${(e as Error).message}`);
    } finally {
      this.#busy = false;
    }
    if (failed) CRON_LOOP.fail(failed, this.#now());
    else CRON_LOOP.ok(this.#now());
    return fired;
  }

  async #fire(t: TriggerRecord, dueMs: number, missed: boolean): Promise<void> {
    const facts = scheduleFacts(new Date(missed ? this.#now().getTime() : dueMs).toISOString());
    const input = { facts, actor: 'portal:cron', unfiltered: true, deliveryId: `cron:${new Date(dueMs).toISOString()}` };
    if (missed && t.cron!.catchUp === 'skip') {
      this.d.runner.recordSkip(t, { ...input, facts: scheduleFacts(new Date(dueMs).toISOString()) }, 'missed');
      return;
    }
    await this.d.runner.fire(t, input);
  }
}
