// Efficiency lab (T-287, docs/prd/claude-usage.md §28): slice-level economy metrics from the session stream, and experiments with arms.
// Slice 1 is the data layer: the chat controller hands every accepted stream line to `line` (read only, after the integrity checks), the
// ingest keeps counts and ids, and `slices` and `report` answer the coordinator's measurement as a query. Routes, the Portal MCP read tools
// and the pages come in a later slice and go through an authz seam of their own then.

import type { LabExperiment, LabExperimentReport, LabSliceMetrics } from '@portal/contracts';
import type { Store } from '../store/store.js';
import { assignSlice, createExperiment, decideExperiment, excludeSlice, experimentReport, listExperiments, stopExperiment, type NewExperiment } from './experiments.js';
import { LabIngest } from './ingest.js';
import { sliceMetrics, type SliceFilter } from './metrics.js';

export class Lab {
  readonly #ingest: LabIngest;

  constructor(private readonly opts: { store: Store; now?: () => number; log?: (msg: string) => void }) {
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
}
