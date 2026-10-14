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
  /** Migration 854: the block order's secret seed (never shown); migration 855 gave every older experiment one. */
  seed: string | null;
  /** Migration 855: 1 when only a bound draw gives an arm (a slice without one is excluded). */
  draws_only: number;
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
  drawsOnly: r.draws_only === 1,
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
  /** randomized: only a bound draw gives an arm; a slice that starts without one is excluded (`no draw`), never block-assigned (E2). */
  drawsOnly?: boolean;
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
  if (e.drawsOnly && e.design !== 'randomized') throw new Error('draws only is for a randomized experiment');
  if (strata && (!strata.length || strata.some((k) => !(LAB_STRATUM_KEYS as readonly string[]).includes(k)))) throw new Error(`stratum keys: one or more of ${LAB_STRATUM_KEYS.join(', ')}`);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO lab_experiments (id, name, hypothesis, design, arms, primary_metric, guardrails, thresholds, min_n, status, start_ms, switch_ms, created_ms, strata, seed, draws_only)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
  ).run(id, e.name, e.hypothesis ?? '', e.design, JSON.stringify(arms), e.primaryMetric, JSON.stringify(e.guardrails ?? []), JSON.stringify(e.thresholds ?? {}), e.minN ?? 0, e.startMs, e.switchMs ?? null, nowMs, strata ? JSON.stringify(strata) : null, randomBytes(16).toString('hex'), e.drawsOnly ? 1 : 0);
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

/** A seeded order of the arms for one block (Fisher-Yates over a sha256 stream). The seed: the experiment's secret seed (its id only if it has none). */
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
    if (r.draws_only) {
      // A draws-only experiment (E2) gives no block arm: a slice without a bound draw is out (and counted per session in drawStats).
      db.prepare("INSERT INTO lab_assignments (experiment_id, session_id, slice_id, arm, stratum, assigned_ms, excluded) VALUES (?, ?, ?, NULL, '', ?, 'no draw')").run(r.id, info.sessionId, info.sliceId, info.atMs);
      continue;
    }
    const arms = JSON.parse(r.arms) as string[];
    const stratum = r.strata ? stratumOf(JSON.parse(r.strata) as LabStratumKey[], attrs) : (info.stratum ?? defaultStratum(attrs));
    // Drawn arms (`draw` set, T-292 slice 3) are not block places: the blocks are the slices that got their arm at the start.
    const k = (db.prepare('SELECT COUNT(*) AS n FROM lab_assignments WHERE experiment_id = ? AND stratum = ? AND arm IS NOT NULL AND draw IS NULL').get(r.id, stratum) as { n: number }).n;
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

/** `T-12`, `T-012` and `T-0012` are ticket 12 (outcomes.ts reads the number): one spelling, so the spelling cannot steer an arm. */
export function normTicket(t: string | null): string | null {
  const m = t === null ? null : /^T-(\d{1,9})$/.exec(t);
  return m ? `T-${Number(m[1])}` : t;
}

/**
 * A drawn arm: fixed per experiment and ticket (normalised), from the experiment's secret seed (never shown). So drawing again (a redraw,
 * after a throwaway call bound the first draw, with another role, model or effort) gives the same arm. A draw does reveal that ticket's
 * own arm, also when it is drawn only to look (a peek). The caller can still leave the ticket undispatched; a slice of it without a bound
 * draw gets no arm (draws only) and, for a drawing role, is counted as `opted_out` (drawStats), but a ticket never dispatched leaves only an unbound draw.
 * Simple randomization per ticket, not blocked. Not a block place, so a draw nobody uses moves no other slice's arm.
 */
export function drawnArm(seed: string, ticket: string, arms: readonly string[]): string {
  const h = createHash('sha256').update(`${seed}\u0000draw\u0000${normTicket(ticket)}`).digest();
  return arms[h.readUInt32BE(0) % arms.length]!;
}

/**
 * Draws the arms for a slice that has not started yet (an arm the brief depends on, E2): per running DRAWS-ONLY experiment with a secret
 * seed (no other experiment: a peek must not show a block arm) the drawn arm of its ticket (`drawnArm`), held under `draw:<key>` in the caller's session (`lab_assignments.draw` names the draw),
 * with what it was drawn for (`lab_draws`, the ticket normalised). The orchestrator writes `Lab-Draw: <key>` in the brief's first line;
 * `bindDraw` moves the rows to the slice when that Agent call starts. Every draw is kept and counted (`drawStats`), used or not. A draw
 * needs a ticket.
 */
export function drawArms(db: DatabaseSync, info: { sessionId: string; draw: string; for: DrawFor; size: string | null; atMs: number }): Map<string, string> {
  const f = { ...info.for, ticket: normTicket(info.for.ticket) };
  if (!f.ticket) throw new Error('a draw is for a ticket');
  const running = (db.prepare("SELECT * FROM lab_experiments WHERE status = 'running' AND design = 'randomized' AND draws_only = 1 AND seed IS NOT NULL AND start_ms <= ?").all(info.atMs) as unknown as ExperimentRow[]);
  const out = new Map<string, string>();
  if (!running.length) return out; // nothing to draw for: nothing recorded
  db.prepare('INSERT INTO lab_draws (draw, session_id, ticket, role, model, effort, size, drawn_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(info.draw, info.sessionId, f.ticket, f.role, f.model, f.effort, info.size, info.atMs);
  const attrs: SliceAttrs = { size: info.size, role: f.role, model: f.model, effort: f.effort };
  for (const r of running) {
    const arm = drawnArm(r.seed!, f.ticket, JSON.parse(r.arms) as string[]);
    const stratum = r.strata ? stratumOf(JSON.parse(r.strata) as LabStratumKey[], attrs) : defaultStratum(attrs);
    db.prepare('INSERT INTO lab_assignments (experiment_id, session_id, slice_id, arm, stratum, assigned_ms, draw) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.id, info.sessionId, DRAW_SLICE + info.draw, arm, stratum, info.atMs, info.draw);
    out.set(r.id, arm);
  }
  return out;
}

export type BindResult = 'bound' | 'refused' | 'none';

/**
 * Binds a draw to the Agent call that names it: only in the session that drew it, only once, only while it is not expired (retention), and
 * only when the call's ticket, role, model and effort, and the ticket's ESTIMATE size now, are the ones it was drawn for. `refused` (a
 * mismatch, or expired) leaves the draw unbound and counted; `none`: no such draw in this session. The same slice again answers `bound`.
 */
export function bindDraw(db: DatabaseSync, info: { sessionId: string; draw: string; sliceId: string; for: DrawFor; size: string | null; atMs: number }): BindResult {
  const d = db.prepare('SELECT ticket, role, model, effort, size, status, slice_id FROM lab_draws WHERE draw = ? AND session_id = ?').get(info.draw, info.sessionId) as
    | (DrawFor & { size: string | null; status: string; slice_id: string | null })
    | undefined;
  if (!d) return 'none';
  if (d.status === 'bound') return d.slice_id === info.sliceId ? 'bound' : 'none';
  if (d.status === 'expired') return 'refused';
  const f = { ...info.for, ticket: normTicket(info.for.ticket) };
  if (d.ticket !== f.ticket || d.role !== f.role || d.model !== f.model || d.effort !== f.effort || d.size !== info.size) {
    db.prepare("UPDATE lab_draws SET status = 'refused', status_ms = ? WHERE draw = ?").run(info.atMs, info.draw);
    return 'refused';
  }
  db.prepare('UPDATE OR IGNORE lab_assignments SET slice_id = ? WHERE session_id = ? AND slice_id = ?').run(info.sliceId, info.sessionId, DRAW_SLICE + info.draw);
  db.prepare("UPDATE lab_draws SET status = 'bound', slice_id = ?, status_ms = ? WHERE draw = ?").run(info.sliceId, info.atMs, info.draw);
  return 'bound';
}

export interface DrawStat {
  session: string;
  /** Every draw of the session that holds an arm in the experiment, bound or not; retention never drops one. */
  draws: number;
  bound: number;
  /** Abandoned: open, refused or expired. */
  unbound: number;
  /** Draws for a ticket this session had drawn for before, whatever the role (a redraw, or a later slice of the ticket): the same arm. */
  redraw: number;
  /** Slices of the session kept out of this experiment that started after a draw of THIS experiment: a slice that carried a draw line
   * which did not bind (`draw not bound`, any role), or a slice of a drawing role (`DRAW_ROLES`, or a role this experiment drew for)
   * that started without one (`no draw`). It counts when its ticket was drawn for before it started (any session, bound or not), or,
   * when it names no ticket (or a ticket the portal does not have), when its own session had drawn before it started: work on a drawn
   * ticket done without its draw (a peek elsewhere, a throwaway bound first, a follow-up slice). */
  opted_out: number;
}

/** The roles whose slices draw (docs/dev-sessions/orchestrator.md: every implementer slice while E2 runs). */
export const DRAW_ROLES: readonly string[] = ['implementer'];

/** Whether ticket `T-<n>` exists in the portal's tickets table; false without the table (a bare store). */
export function ticketExistsIn(db: DatabaseSync, ticket: string): boolean {
  const m = /^T-(\d{1,9})$/.exec(ticket);
  if (!m) return false;
  try {
    return db.prepare('SELECT 1 FROM tickets WHERE number = ?').get(Number(m[1])) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Per session, an experiment's draws: all of them, bound, unbound, the redraws, and the slices that went without their ticket's draw.
 * `ticketExists` (normalised `T-<n>`): the portal's tickets table unless a reader is given (tests).
 */
export function drawStats(db: DatabaseSync, experimentId: string, ticketExists: (ticket: string) => boolean = (t) => ticketExistsIn(db, t)): DrawStat[] {
  const draws = db
    .prepare(
      `SELECT d.session_id AS session, d.ticket AS ticket, d.role AS role, d.drawn_ms AS at, d.status AS status,
         EXISTS (SELECT 1 FROM lab_draws e WHERE e.session_id = d.session_id AND e.rowid < d.rowid AND e.ticket IS d.ticket) AS redraw
       FROM lab_assignments a JOIN lab_draws d ON d.draw = a.draw WHERE a.experiment_id = ?`,
    )
    .all(experimentId) as { session: string; ticket: string | null; role: string | null; at: number; status: string; redraw: number }[];
  const out = new Map<string, DrawStat>();
  const of = (session: string) => {
    let st = out.get(session);
    if (!st) out.set(session, (st = { session, draws: 0, bound: 0, unbound: 0, redraw: 0, opted_out: 0 }));
    return st;
  };
  // Only this experiment's draws (lab_assignments.experiment_id), each kept as the first moment per ticket and per session.
  const firstByTicket = new Map<string, number>();
  const firstBySession = new Map<string, number>();
  const roles = new Set(DRAW_ROLES);
  const earliest = (m: Map<string, number>, k: string, at: number) => m.set(k, Math.min(m.get(k) ?? at, at));
  for (const d of draws) {
    const st = of(d.session);
    st.draws++;
    if (d.status === 'bound') st.bound++;
    else st.unbound++;
    if (d.redraw) st.redraw++;
    if (d.ticket) earliest(firstByTicket, d.ticket, d.at);
    earliest(firstBySession, d.session, d.at);
    if (d.role) roles.add(d.role);
  }
  const kept = db
    .prepare(
      `SELECT a.session_id AS session, a.excluded AS excluded, a.assigned_ms AS at, s.ticket AS ticket, s.role AS role
       FROM lab_assignments a JOIN lab_slices s ON s.session_id = a.session_id AND s.slice_id = a.slice_id
       WHERE a.experiment_id = ? AND a.excluded IN ('no draw', 'draw not bound')`,
    )
    .all(experimentId) as { session: string; excluded: string; at: number; ticket: string | null; role: string | null }[];
  for (const k of kept) {
    if (k.excluded === 'no draw' && !(k.role && roles.has(k.role))) continue; // a reviewer, QA, explorer or helper slice draws nothing
    let t = normTicket(k.ticket);
    if (t && !ticketExists(t)) t = null; // a made-up ticket names no ticket
    const first = t ? firstByTicket.get(t) : firstBySession.get(k.session);
    if (first !== undefined && first <= k.at) of(k.session).opted_out++;
  }
  return [...out.values()].sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
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
