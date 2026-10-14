// Efficiency lab (T-287, docs/prd/claude-usage.md §28): slice-level economy metrics from the session stream, and experiments with arms.
// Slice 1 is the data layer: the chat controller hands every accepted stream line to `line` (read only, after the integrity checks), the
// ingest keeps counts and ids, and `slices` and `report` answer the coordinator's measurement as a query. Slice 2 adds the derived views
// (outcomes, the summary, the experiments' primary), retention (start), the routes (routes.ts), the Portal MCP tools (portalTools.ts) and
// their declarations with the authz seam (authz.ts). Slice 3 adds result tokens, effort and idle gaps per slice, and stratum keys for
// randomized experiments (ESTIMATE size, role, model, effort). T-292 slice 3 adds draws: the arms of a slice drawn before its brief (E2).

import type { LabExperiment, LabExperimentReport, LabExperimentView, LabPeriod, LabSliceMetrics, LabSliceView, LabSummary } from '@portal/contracts';
import type { Store } from '../store/store.js';
import { armMembers, assignSlice, bindDraw, createExperiment, decideExperiment, drawArms, excludeSlice, experimentReport, listExperiments, drawStats, newDrawKey, normTicket, stopExperiment, type DrawStat, type NewExperiment } from './experiments.js';
import { LabIngest } from './ingest.js';
import { sliceMetrics, type SliceFilter } from './metrics.js';
import { DAY_MS, dbTicketReader, outcomeOf, type TicketFacts, type TicketReader } from './outcomes.js';
import { pruneLab, type PruneResult } from './retention.js';
import { bootstrapMedian, loadedCosts, median, summarize, SUMMARY_BASIS } from './summary.js';

export interface ViewFilter extends SliceFilter {
  experiment?: string;
  arm?: string;
}

export class Lab {
  readonly #ingest: LabIngest;
  #timers: NodeJS.Timeout[] = [];

  constructor(private readonly opts: { store: Store; now?: () => number; log?: (msg: string) => void; tickets?: TicketReader }) {
    const now = opts.now ?? Date.now;
    this.#ingest = new LabIngest(() => (opts.store.writable ? opts.store.db : null), now, (s) => {
      const db = this.#db();
      if (!db) return;
      // The ticket's ESTIMATE size as it stands when the slice starts (a stratum key, slice 3); read only when a ticket is named.
      const size = s.ticket ? ((opts.tickets ?? dbTicketReader(db))(normTicket(s.ticket)!)?.estimateSize ?? null) : null;
      // A brief that names a draw (T-292 slice 3) keeps the arms drawn before it was written; experiments the draw did not cover assign now.
      // A draw that does not bind (another session, used already, expired, drawn for another ticket, role, model, effort or ESTIMATE size)
      // leaves the draw unbound and counted, and keeps this slice out of every running experiment: its brief was written for an arm the lab
      // did not give it.
      if (s.draw && bindDraw(db, { sessionId: s.sessionId, draw: s.draw, sliceId: s.sliceId, for: { ticket: s.ticket, role: s.role, model: s.model, effort: s.effort }, size, atMs: s.atMs }) !== 'bound') {
        for (const e of listExperiments(db)) if (e.status === 'running' && e.design === 'randomized' && e.startMs <= s.atMs) excludeSlice(db, e.id, s.sessionId, s.sliceId, 'draw not bound', s.atMs);
      }
      assignSlice(db, { sessionId: s.sessionId, sliceId: s.sliceId, attrs: { size, role: s.role, model: s.model, effort: s.effort }, atMs: s.atMs });
    });
  }

  #db() {
    return this.opts.store.writable ? this.opts.store.db : null;
  }

  /** One accepted stream line of a chat session. Never throws: the chat must not notice the lab. */
  line(sessionId: string, raw: string): void {
    try {
      this.#ingest.line(sessionId, raw);
    } catch (e) {
      this.opts.log?.(`lab: a stream line was not measured (${e instanceof Error ? e.name : 'error'})`);
    }
  }

  slices(filter: SliceFilter = {}): LabSliceMetrics[] {
    const db = this.opts.store.db;
    return db ? sliceMetrics(db, filter) : [];
  }

  createExperiment(e: NewExperiment): LabExperiment {
    const db = this.#db();
    if (!db) throw new Error('the store is not writable');
    return createExperiment(db, e, (this.opts.now ?? Date.now)());
  }

  experiments(): LabExperiment[] {
    const db = this.opts.store.db;
    return db ? listExperiments(db) : [];
  }

  /**
   * Draws the arms of a slice before its brief is written (T-292 slice 3, §28.13), in the caller's session: the size from the ticket's
   * ESTIMATE as at a slice start. Returns the draw key the brief carries (`Lab-Draw: <key>`) and the arm per running experiment.
   */
  drawArms(info: { sessionId: string; ticket: string; role: string | null; model: string | null; effort: string | null }): { draw: string; arms: { experiment: string; name: string; arm: string }[] } {
    const db = this.#db();
    if (!db) throw new Error('the store is not writable');
    const ticket = normTicket(info.ticket)!;
    const size = (this.opts.tickets ?? dbTicketReader(db))(ticket)?.estimateSize ?? null;
    const draw = newDrawKey();
    const got = drawArms(db, { sessionId: info.sessionId, draw, for: { ticket, role: info.role, model: info.model, effort: info.effort }, size, atMs: this.#now() });
    const names = new Map(listExperiments(db).map((e) => [e.id, e.name]));
    return { draw, arms: [...got].map(([id, arm]) => ({ experiment: id, name: names.get(id) ?? id, arm })) };
  }

  /** Per session, an experiment's draws: all, bound, unbound, redraws. */
  drawStats(experimentId: string): DrawStat[] {
    const db = this.opts.store.db;
    return db ? drawStats(db, experimentId) : [];
  }

  stop(id: string): void {
    const db = this.#db();
    if (db) stopExperiment(db, id, (this.opts.now ?? Date.now)());
  }

  decide(id: string, decision: 'adopt' | 'reject' | 'iterate', verdict: string): void {
    const db = this.#db();
    if (db) decideExperiment(db, id, decision, verdict, (this.opts.now ?? Date.now)());
  }

  exclude(experimentId: string, sessionId: string, sliceId: string, reason: string): void {
    const db = this.#db();
    if (db) excludeSlice(db, experimentId, sessionId, sliceId, reason, (this.opts.now ?? Date.now)());
  }

  report(id: string): LabExperimentReport | null {
    const db = this.opts.store.db;
    return db ? experimentReport(db, id) : null;
  }

  #now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Every experiment's arm per slice key (randomized: the assignment; before and after: the side of the switch). Excluded slices: none. */
  #armsByKey(): Map<string, Record<string, string>> {
    const db = this.opts.store.db;
    const out = new Map<string, Record<string, string>>();
    if (!db) return out;
    for (const e of listExperiments(db)) {
      for (const [arm, list] of armMembers(db, e).byArm) {
        for (const m of list) {
          const k = `${m.sessionId}\u0000${m.sliceId}`;
          out.set(k, { ...(out.get(k) ?? {}), [e.id]: arm });
        }
      }
    }
    return out;
  }

  /** Slices with their outcome, ESTIMATE size and arms, newest first. */
  views(filter: ViewFilter = {}): LabSliceView[] {
    const db = this.opts.store.db;
    if (!db) return [];
    const read = this.opts.tickets ?? dbTicketReader(db);
    const facts = new Map<string, TicketFacts | null>();
    const factsOf = (t: string) => (facts.has(t) ? facts.get(t)! : (facts.set(t, read(t)), facts.get(t)!));
    const arms = this.#armsByKey();
    const out: LabSliceView[] = [];
    for (const m of this.slices(filter)) {
      const a = arms.get(`${m.sessionId}\u0000${m.sliceId}`) ?? {};
      if (filter.experiment && !(filter.experiment in a)) continue;
      if (filter.arm && !(filter.experiment ? a[filter.experiment] === filter.arm : Object.values(a).includes(filter.arm))) continue;
      const f = m.ticket ? factsOf(m.ticket) : null;
      out.push({ ...m, outcome: m.ticket ? outcomeOf(m.endMs, f) : 'unknown', estimateSize: f?.estimateSize ?? null, arms: a });
    }
    return out.sort((x, y) => (y.startMs ?? 0) - (x.startMs ?? 0) || x.sliceId.localeCompare(y.sliceId));
  }

  /** The summary per period and per role and model since `sinceMs` (default: the last 14 days). */
  summary(opts: { period?: LabPeriod; sinceMs?: number; sessionId?: string } = {}): LabSummary {
    const nowMs = this.#now();
    const period = opts.period ?? 'day';
    const sinceMs = opts.sinceMs ?? nowMs - 14 * DAY_MS;
    const slices = this.views({ fromMs: sinceMs, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) });
    return { period, sinceMs, rows: summarize(slices, period), basis: SUMMARY_BASIS, nowMs };
  }

  /** Each experiment with its arms' n, accepted count and the primary (median loaded cost per accepted slice) with its interval. */
  experimentViews(): LabExperimentView[] {
    const db = this.opts.store.db;
    if (!db) return [];
    const views = this.views({ kind: 'agent' });
    const loaded = loadedCosts(views);
    const viewOf = new Map(views.map((v) => [`${v.sessionId}\u0000${v.sliceId}`, v]));
    return listExperiments(db).map((e) => {
      const { byArm, excluded } = armMembers(db, e);
      return {
        experiment: e,
        excluded,
        arms: e.arms.map((arm) => {
          const list = (byArm.get(arm) ?? []).map((m) => viewOf.get(`${m.sessionId}\u0000${m.sliceId}`)).filter((v): v is LabSliceView => !!v);
          const costs = list.map((v) => loaded.get(`${v.sessionId}\u0000${v.sliceId}`)).filter((c): c is number => c !== undefined);
          return { arm, n: list.length, accepted: list.filter((v) => v.outcome === 'accepted').length, costPerAccepted: median(costs), costPerAcceptedInterval: bootstrapMedian(costs, `${e.id}|${arm}`) };
        }),
      };
    });
  }

  /** Retention now (§28.9): freezes slices older than 14 days and drops their request and tool rows. */
  prune(): PruneResult | null {
    const db = this.#db();
    if (!db) return null;
    const r = pruneLab(db, this.#now());
    if (r.frozen || r.requests || r.tools || r.draws) this.opts.log?.(`lab: retention froze ${r.frozen} slices, dropped ${r.requests} request and ${r.tools} tool rows and expired ${r.draws} unbound draws`);
    return r;
  }

  /** Retention once a minute after start, then once a day (the timers do not hold the process open). */
  start(): void {
    const run = () => {
      try {
        this.prune();
      } catch (e) {
        this.opts.log?.(`lab: retention failed (${e instanceof Error ? e.name : 'error'})`);
      }
    };
    const first = setTimeout(run, 60_000);
    const daily = setInterval(run, DAY_MS);
    for (const t of [first, daily]) t.unref();
    this.#timers = [first, daily];
  }

  /** Ends the retention timers (shutdown, tests). */
  close(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
  }
}
