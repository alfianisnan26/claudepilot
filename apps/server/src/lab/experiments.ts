// Efficiency lab (T-287): experiments. A randomized experiment gives each sub-agent slice an arm when the slice starts, in blocks per
// stratum (role and model by default; slice 3: the experiment's own stratum keys, any of ESTIMATE size, role, model and effort): within every block of as many slices as arms each arm comes once, in an order drawn from a hash of the
// experiment, the stratum and the block, so the arms stay balanced within one slice per stratum and the draw can be recomputed. A
// before-and-after experiment (a global change such as the 1 hour cache) splits its window at the moment of the change. An excluded slice
// (an outage) is in no arm. The report is a query over the slices: n and medians per arm, the shares that are sums over sums.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LAB_STRATUM_KEYS, type LabArmSummary, type LabDecision, type LabExperiment, type LabExperimentDesign, type LabExperimentReport, type LabSliceMetrics, type LabStratumKey } from '@portal/contracts';
import { sliceMetrics } from './metrics.js';

interface ExperimentRow {
  id: string;
  name: string;
  hypothesis: string;
  design: LabExperimentDesign;
  arms: string;
  primary_metric: string;
  guardrails: string;
  thresholds: string;
  min_n: number;
  status: LabExperiment['status'];
  start_ms: number;
  stop_ms: number | null;
  switch_ms: number | null;
  decision: LabDecision | null;
  verdict: string | null;
  created_ms: number;
  strata: string | null;
  /** Migration 854: the block order's secret seed (never shown); NULL for older experiments, which keep their id as the seed. */
  seed: string | null;
}

const toExperiment = (r: ExperimentRow): LabExperiment => ({
  id: r.id,
  name: r.name,
  hypothesis: r.hypothesis,
  design: r.design,
  arms: JSON.parse(r.arms) as string[],
  primaryMetric: r.primary_metric,
  guardrails: JSON.parse(r.guardrails) as unknown[],
  thresholds: JSON.parse(r.thresholds) as Record<string, unknown>,
  minN: r.min_n,
  status: r.status,
  startMs: r.start_ms,
  stopMs: r.stop_ms,
  switchMs: r.switch_ms,
  decision: r.decision,
  verdict: r.verdict,
  createdMs: r.created_ms,
  strata: r.strata ? (JSON.parse(r.strata) as LabStratumKey[]) : null,
});

export interface NewExperiment {
  name: string;
  hypothesis?: string;
  design: LabExperimentDesign;
  /** randomized: two or more arm names; before_after: ignored (always before and after). */
  arms?: string[];
  primaryMetric: string;
  guardrails?: unknown[];
  thresholds?: Record<string, unknown>;
  minN?: number;
  startMs: number;
  /** before_after: the moment of the change. */
  switchMs?: number;
  /** randomized: the stratum keys (slice 3); absent keeps role and requested model. */
  strata?: LabStratumKey[];
}

/** What a starting slice is stratified by; null is a missing value. */
export interface SliceAttrs {
  size: string | null;
  role: string | null;
  model: string | null;
  effort: string | null;
}

/** Slice 1's stratum, kept for experiments without stratum keys: the role and the requested model. */
export const defaultStratum = (a: Pick<SliceAttrs, 'role' | 'model'>): string => `${a.role ?? '-'}|${a.model ?? 'inherit'}`;

/** The stratum of a slice for the given keys, in their order (`size=M|role=implementer`); a missing value is `-`. */
export function stratumOf(keys: readonly LabStratumKey[], a: SliceAttrs): string {
  return keys.map((k) => `${k}=${a[k] ?? '-'}`).join('|');
}

const ARM = /^[A-Za-z0-9_.:=-]{1,40}$/;

export function createExperiment(db: DatabaseSync, e: NewExperiment, nowMs: number): LabExperiment {
  const arms = e.design === 'before_after' ? ['before', 'after'] : [...new Set(e.arms ?? [])];
  if (e.design === 'randomized' && arms.length < 2) throw new Error('a randomized experiment needs two or more arms');
  if (arms.some((a) => !ARM.test(a))) throw new Error('an arm name is a short plain name');
  if (e.design === 'before_after' && (e.switchMs === undefined || e.switchMs < e.startMs)) throw new Error('a before-and-after experiment needs the moment of the change, after its start');
  const strata = e.strata === undefined ? null : [...new Set(e.strata)];
  if (strata && e.design !== 'randomized') throw new Error('stratum keys are for a randomized experiment');
  if (strata && (!strata.length || strata.some((k) => !(LAB_STRATUM_KEYS as readonly string[]).includes(k)))) throw new Error(`stratum keys: one or more of ${LAB_STRATUM_KEYS.join(', ')}`);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO lab_experiments (id, name, hypothesis, design, arms, primary_metric, guardrails, thresholds, min_n, status, start_ms, switch_ms, created_ms, strata, seed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
  ).run(id, e.name, e.hypothesis ?? '', e.design, JSON.stringify(arms), e.primaryMetric, JSON.stringify(e.guardrails ?? []), JSON.stringify(e.thresholds ?? {}), e.minN ?? 0, e.startMs, e.switchMs ?? null, nowMs, strata ? JSON.stringify(strata) : null, randomBytes(16).toString('hex'));
  return getExperiment(db, id)!;
}

export function getExperiment(db: DatabaseSync, id: string): LabExperiment | null {
  const r = db.prepare('SELECT * FROM lab_experiments WHERE id = ?').get(id) as unknown as ExperimentRow | undefined;
  return r ? toExperiment(r) : null;
}

export function listExperiments(db: DatabaseSync): LabExperiment[] {
  return (db.prepare('SELECT * FROM lab_experiments ORDER BY start_ms DESC').all() as unknown as ExperimentRow[]).map(toExperiment);
}

export function stopExperiment(db: DatabaseSync, id: string, atMs: number): void {
  db.prepare("UPDATE lab_experiments SET status = 'stopped', stop_ms = COALESCE(stop_ms, ?) WHERE id = ? AND status = 'running'").run(atMs, id);
}

export function decideExperiment(db: DatabaseSync, id: string, decision: LabDecision, verdict: string, atMs: number): void {
  stopExperiment(db, id, atMs);
  db.prepare("UPDATE lab_experiments SET status = 'decided', decision = ?, verdict = ? WHERE id = ?").run(decision, verdict, id);
}

/** A seeded order of the arms for one block (Fisher-Yates over a sha256 stream). The seed: the experiment's secret seed, else its id. */
export function blockOrder(seed: string, stratum: string, block: number, arms: readonly string[]): string[] {
  const out = [...arms];
  const h = createHash('sha256').update(`${seed}\u0000${stratum}\u0000${block}`).digest();
  for (let i = out.length - 1; i > 0; i--) {
    const j = h.readUInt32BE((i * 4) % 28) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Gives a starting slice its arm in every running randomized experiment whose window holds `atMs`; returns them (experiment id to arm).
 * Asking again for the same slice returns the arm it already has. The stratum per experiment: its stratum keys over `attrs`, else `stratum`
 * (a caller's own key, slice 1), else role and requested model from `attrs`. The draw depends only on the experiment id, the stratum and how
 * many slices of that stratum came before, so the same slices in the same order get the same arms.
 */
export function assignSlice(db: DatabaseSync, info: { sessionId: string; sliceId: string; stratum?: string; attrs?: SliceAttrs; atMs: number }): Map<string, string> {
  const attrs: SliceAttrs = info.attrs ?? { size: null, role: null, model: null, effort: null };
  const out = new Map<string, string>();
  const running = db.prepare("SELECT * FROM lab_experiments WHERE status = 'running' AND design = 'randomized' AND start_ms <= ?").all(info.atMs) as unknown as ExperimentRow[];
  for (const r of running) {
    const had = db.prepare('SELECT arm FROM lab_assignments WHERE experiment_id = ? AND session_id = ? AND slice_id = ?').get(r.id, info.sessionId, info.sliceId) as { arm: string | null } | undefined;
    if (had) {
      if (had.arm) out.set(r.id, had.arm);
      continue;
    }
    const arms = JSON.parse(r.arms) as string[];
    const stratum = r.strata ? stratumOf(JSON.parse(r.strata) as LabStratumKey[], attrs) : (info.stratum ?? defaultStratum(attrs));
    const k = (db.prepare('SELECT COUNT(*) AS n FROM lab_assignments WHERE experiment_id = ? AND stratum = ? AND arm IS NOT NULL').get(r.id, stratum) as { n: number }).n;
    const arm = blockOrder(r.seed ?? r.id, stratum, Math.floor(k / arms.length), arms)[k % arms.length]!;
    db.prepare('INSERT INTO lab_assignments (experiment_id, session_id, slice_id, arm, stratum, assigned_ms) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, info.sessionId, info.sliceId, arm, stratum, info.atMs);
    out.set(r.id, arm);
  }
  return out;
}

/** The slice id a draw holds until a slice binds it (T-292 slice 3). No Agent tool_use id starts this way. */
export const DRAW_SLICE = 'draw:';
export const newDrawKey = (): string => `d-${randomBytes(6).toString('hex')}`;

/** What a draw is for, and what the Agent call that binds it must say: the ticket, the role, the requested model, the effort. */
export interface DrawFor {
  ticket: string | null;
  role: string | null;
  model: string | null;
  effort: string | null;
}

/**
 * Draws the arms for a slice that has not started yet (an arm the brief depends on, E2): the same block draw as `assignSlice`, held under
 * `draw:<key>` in the caller's session, with what it was drawn for (`lab_draws`). The orchestrator writes `Lab-Draw: <key>` in the brief's
 * first line; `bindDraw` moves the rows to the slice when that Agent call starts. A draw nobody binds keeps its place in the block, is
 * counted per session, and as a redraw when a later draw of the same session was made for the same ticket, role, model and effort.
 */
export function drawArms(db: DatabaseSync, info: { sessionId: string; draw: string; for: DrawFor; size: string | null; atMs: number }): Map<string, string> {
  const f = info.for;
  db.prepare('INSERT INTO lab_draws (draw, session_id, ticket, role, model, effort, size, drawn_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(info.draw, info.sessionId, f.ticket, f.role, f.model, f.effort, info.size, info.atMs);
  return assignSlice(db, { sessionId: info.sessionId, sliceId: DRAW_SLICE + info.draw, attrs: { size: info.size, role: f.role, model: f.model, effort: f.effort }, atMs: info.atMs });
}

export type BindResult = 'bound' | 'refused' | 'none';

/**
 * Binds a draw to the Agent call that names it: only in the session that drew it, only once, and only when the call's ticket, role, model and
 * effort are the ones it was drawn for. `refused` (a mismatch) leaves the draw unbound and counted; `none`: no such open draw in this session.
 * The same slice again (a replayed line) answers `bound`.
 */
export function bindDraw(db: DatabaseSync, info: { sessionId: string; draw: string; sliceId: string; for: DrawFor; atMs: number }): BindResult {
  const d = db.prepare('SELECT ticket, role, model, effort, status, slice_id FROM lab_draws WHERE draw = ? AND session_id = ?').get(info.draw, info.sessionId) as
    | (DrawFor & { status: string; slice_id: string | null })
    | undefined;
  if (!d) return 'none';
  if (d.status === 'bound') return d.slice_id === info.sliceId ? 'bound' : 'none';
  const f = info.for;
  if (d.ticket !== f.ticket || d.role !== f.role || d.model !== f.model || d.effort !== f.effort) {
    db.prepare("UPDATE lab_draws SET status = 'refused', status_ms = ? WHERE draw = ?").run(info.atMs, info.draw);
    return 'refused';
  }
  db.prepare('UPDATE OR IGNORE lab_assignments SET slice_id = ? WHERE session_id = ? AND slice_id = ?').run(info.sliceId, info.sessionId, DRAW_SLICE + info.draw);
  db.prepare("UPDATE lab_draws SET status = 'bound', slice_id = ?, status_ms = ? WHERE draw = ?").run(info.sliceId, info.atMs, info.draw);
  return 'bound';
}

/** Per session, an experiment's draws no slice has bound, and how many of them a later draw for the same ticket, role, model and effort followed. */
export function drawStats(db: DatabaseSync, experimentId: string): { session: string; unbound: number; redraw: number }[] {
  return db
    .prepare(
      `SELECT a.session_id AS session, COUNT(*) AS unbound,
         SUM(EXISTS (SELECT 1 FROM lab_draws n WHERE n.session_id = d.session_id AND n.rowid > d.rowid AND n.ticket IS d.ticket AND n.role IS d.role
           AND n.model IS d.model AND n.effort IS d.effort)) AS redraw
       FROM lab_assignments a LEFT JOIN lab_draws d ON d.draw = substr(a.slice_id, 6)
       WHERE a.experiment_id = ? AND substr(a.slice_id, 1, 5) = ? GROUP BY a.session_id ORDER BY a.session_id`,
    )
    .all(experimentId, DRAW_SLICE)
    .map((r) => ({ session: String(r.session), unbound: Number(r.unbound), redraw: Number(r.redraw ?? 0) }));
}

/** Takes a slice out of an experiment's analysis, with the reason (`outage`). Its arm, if any, is kept for the record. */
export function excludeSlice(db: DatabaseSync, experimentId: string, sessionId: string, sliceId: string, reason: string, atMs: number): void {
  db.prepare(
    `INSERT INTO lab_assignments (experiment_id, session_id, slice_id, arm, stratum, assigned_ms, excluded) VALUES (?, ?, ?, NULL, '', ?, ?)
     ON CONFLICT DO UPDATE SET excluded = excluded.excluded`,
  ).run(experimentId, sessionId, sliceId, atMs, reason.slice(0, 80));
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};
const share = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function summarizeArm(arm: string, slices: readonly LabSliceMetrics[]): LabArmSummary {
  const sum = (f: (m: LabSliceMetrics) => number) => slices.reduce((s, m) => s + f(m), 0);
  const costs = slices.map((m) => m.costUsd).filter((c): c is number => c !== null);
  return {
    arm,
    n: slices.length,
    medians: {
      requests: median(slices.map((m) => m.requests)),
      ctxP50: median(slices.map((m) => m.ctxP50)),
      costUsd: costs.length === slices.length ? median(costs) : null,
      resultChars: median(slices.map((m) => m.resultChars)),
      resultTokens: median(slices.map((m) => m.resultTokens).filter((x): x is number => x !== null)),
      minutes: median(slices.map((m) => m.minutes)),
    },
    rewriteShare: share(sum((m) => m.rewriteTokens), sum((m) => m.cacheWrite5m + m.cacheWrite1h)),
    inspectShare: share(sum((m) => m.inspectCalls), sum((m) => m.bashCalls)),
    rtkShare: share(sum((m) => m.rtkCalls), sum((m) => m.bashCalls)),
  };
}

/** The experiment's sub-agent slices per arm (excluded ones out), and how many were excluded. Intention to treat: the assigned arm counts. */
export function armMembers(db: DatabaseSync, e: LabExperiment): { byArm: Map<string, LabSliceMetrics[]>; excluded: number } {
  const id = e.id;
  const rows = db.prepare('SELECT session_id, slice_id, arm, excluded FROM lab_assignments WHERE experiment_id = ?').all(id) as { session_id: string; slice_id: string; arm: string | null; excluded: string | null }[];
  const excluded = new Set(rows.filter((r) => r.excluded).map((r) => `${r.session_id}\u0000${r.slice_id}`));
  const key = (m: LabSliceMetrics) => `${m.sessionId}\u0000${m.sliceId}`;
  const byArm = new Map<string, LabSliceMetrics[]>(e.arms.map((a) => [a, []]));
  if (e.design === 'randomized') {
    const armOf = new Map(rows.filter((r) => r.arm && !r.excluded).map((r) => [`${r.session_id}\u0000${r.slice_id}`, r.arm!]));
    const keys = rows.filter((r) => r.arm && !r.excluded).map((r) => ({ sessionId: r.session_id, sliceId: r.slice_id }));
    for (const m of keys.length ? sliceMetrics(db, { kind: 'agent', keys }) : []) byArm.get(armOf.get(key(m))!)?.push(m);
  } else {
    for (const m of sliceMetrics(db, { kind: 'agent', fromMs: e.startMs, ...(e.stopMs !== null ? { toMs: e.stopMs } : {}) })) {
      if (excluded.has(key(m))) continue;
      byArm.get(m.startMs! < e.switchMs! ? 'before' : 'after')!.push(m);
    }
  }
  return { byArm, excluded: excluded.size };
}

/** The experiment's arms over the sub-agent slices that fall into it (excluded ones out). Intention to treat: the assigned arm counts. */
export function experimentReport(db: DatabaseSync, id: string): LabExperimentReport | null {
  const e = getExperiment(db, id);
  if (!e) return null;
  const { byArm, excluded } = armMembers(db, e);
  return { experiment: e, arms: e.arms.map((a) => summarizeArm(a, byArm.get(a) ?? [])), excluded };
}
