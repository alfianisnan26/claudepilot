// Efficiency lab (T-287, docs/prd/claude-usage.md §28): slice-level economy metrics from the session stream, and experiments with arms.
// Slice 1 is the data layer: the chat controller hands every accepted stream line to `line` (read only, after the integrity checks), the
// ingest keeps counts and ids, and `slices` and `report` answer the coordinator's measurement as a query. Slice 2 adds the derived views
// (outcomes, the summary, the experiments' primary), retention (start), the routes (routes.ts), the Portal MCP tools (portalTools.ts) and
// their declarations with the authz seam (authz.ts).

import type { LabExperiment, LabExperimentReport, LabExperimentView, LabPeriod, LabSliceMetrics, LabSliceView, LabSummary } from '@portal/contracts';
import type { Store } from '../store/store.js';
import { armMembers, assignSlice, createExperiment, decideExperiment, excludeSlice, experimentReport, listExperiments, stopExperiment, type NewExperiment } from './experiments.js';
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
      if (db) assignSlice(db, { sessionId: s.sessionId, sliceId: s.sliceId, stratum: `${s.role ?? '-'}|${s.model ?? 'inherit'}`, atMs: s.atMs });
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
    if (r.frozen || r.requests || r.tools) this.opts.log?.(`lab: retention froze ${r.frozen} slices, dropped ${r.requests} request and ${r.tools} tool rows`);
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
