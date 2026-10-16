// Efficiency lab over the Portal MCP (docs/prd/claude-usage.md §28.10), declared in authz.ts:
//
// - `lab_summary`: the coordinator's pass in one call. Short rows by default (T-282's compact rule: a result is read again on every later
//   request), `full: true` for every field, the experiments and the sources. An admin's token reads the portal; an agent's token reads only
//   its own session's slices (no experiments).
// - `crew_scorecard` (T-450): per program and window, effectiveness, cost and the D-61/D-62/D-63 targets (lab/scorecard.ts). Read only;
//   an agent's token reads its own program (the top of its session's lineage), another program is not found; an admin's reads all.
// - `lab_arm_draw` (T-292 slice 3): the arms of a slice drawn BEFORE its brief is written, for an experiment whose treatment is the brief
//   itself (E2: pack on or off). The caller's own session only; the lab draws, the caller never picks; the brief carries the draw key.
// - `lab_experiment_set`: admin tokens only, with the confirmation round trip: start a randomized or before-and-after experiment, or stop one.
//
// Counts and ids only; an experiment's name and hypothesis are a person's text and come back labelled untrusted.

import { ATTRIBUTION_LEAD_BASIS, CREW_WINDOWS, LAB_STRATUM_KEYS, type CrewFigure, type CrewProgramScore, type CrewWindowScore, type LabTicketCost, type LabExperimentView, type LabInterval, type LabStat, type LabSummaryRow } from '@portal/contracts';
import { fullInput } from '../portalmcp/compact.js';
import { PortalToolError, portalTools, z, type PortalToolContext, type ToolRegistry } from '../portalmcp/registry.js';
import { declareLabPolicies } from './authz.js';
import type { Lab } from './index.js';
import { parseSince } from './routes.js';

declareLabPolicies();

const r2 = (x: number | null | undefined): number | null => (x === null || x === undefined ? null : Math.round(x * 100) / 100);
const r3 = (x: number | null | undefined): number | null => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);
const med = (s: LabStat | null) => (s ? s.median : null);
const ci = (i: LabInterval) => (i === 'n too small' ? i : [r2(i.low), r2(i.high)]);

/** The tickets' dollars (usage spend's per-ticket figures, T-449): ticket, type, status, own, via lead, total. Top `n` (default 10). */
const ticketsShort = (t: LabTicketCost[] | undefined, n = 10) =>
  (t ?? []).slice(0, n).map((x) => ({ ticket: x.ticket, type: x.type, status: x.status, done_at: x.doneAt, own_usd: x.ownUsd, via_lead_usd: x.viaLeadUsd, total_usd: x.totalUsd }));

/** A figure in a short row: its value, or `unavailable:<reason>`. */
const v = (f: CrewFigure) => (f.basis === 'unavailable' ? `unavailable:${f.reason ?? 'no_source'}` : f.value);
const windowShort = (w: CrewWindowScore | null) =>
  w && {
    done: v(w.effectiveness.done),
    done_per_hour: v(w.effectiveness.donePerHour),
    reopened: v(w.effectiveness.reopened),
    wont_do: v(w.effectiveness.wontDo),
    review_backlog: v(w.effectiveness.reviewBacklog),
    ci_runs: v(w.effectiveness.ciRuns),
    deploys: v(w.effectiveness.deploysCount),
    cost_usd: v(w.cost.total),
    lead_share_pct: v(w.cost.leadShare),
    per_done_usd: v(w.cost.perDoneAllIn),
    per_done_workers_usd: v(w.cost.perDoneWorkers),
    cache_read_pct: v(w.efficiency.costParts.cacheRead),
    requests: v(w.efficiency.requests),
    handovers: v(w.efficiency.handovers),
    spikes: v(w.efficiency.spikesCount),
    // T-490 (D-63): the opus share of QA and review workers, how many of them, and how many of the opus ones gave a why.
    qa_review_opus_pct: v(w.efficiency.qaReviewOpus.share),
    qa_review_sessions: w.efficiency.qaReviewOpus.sessions,
    qa_review_opus_with_why: w.efficiency.qaReviewOpus.opusWithWhy,
    refusals: v(w.health.refusals),
    bad_endings: v(w.health.badEndings),
  };

/** One program in a short result: the window's headline figures, the one before, and the targets not ok. */
export function scoreShort(p: CrewProgramScore) {
  return {
    program: p.program,
    workspace: p.workspaceId,
    leads: p.leads.length,
    workers: p.workers,
    now: windowShort(p.current),
    before: windowShort(p.previous),
    targets: Object.fromEntries(p.targets.map((t) => [t.id, t.state])),
    flags: p.targets.filter((t) => t.state !== 'ok').map((t) => ({ id: t.id, decision: t.decision, state: t.state, offenders: t.offenders.slice(0, 5) })),
  };
}

/** A copy with every figure's `source` left out (a figure: an object with `value`, `basis` and `source`). */
export function withoutSources<T>(x: T): T {
  if (Array.isArray(x)) return x.map(withoutSources) as T;
  if (!x || typeof x !== 'object') return x;
  const o = x as Record<string, unknown>;
  const figure = 'value' in o && 'basis' in o && 'source' in o;
  return Object.fromEntries(Object.entries(o).filter(([k]) => !(figure && k === 'source')).map(([k, v]) => [k, withoutSources(v)])) as T;
}

/**
 * A program in the full form: no figure sources and no target `rule` (the rules are fixed text: `basis.targets` and `basis.d65` name them once,
 * the route keeps them on each target; the MCP result limit is 20,000 characters and ten targets a program carry it over).
 */
export function fullProgram(p: CrewProgramScore) {
  const q = withoutSources(p);
  // A D-65 target is one short row (id, state, value or `unavailable:<reason>`, offenders when there are some); the older ones keep their figure.
  return { ...q, targets: q.targets.map(({ rule: _rule, ...t }) => (t.decision === 'D-65' ? { id: t.id, state: t.state, value: v(t.figure), ...(t.offenders.length ? { offenders: t.offenders } : {}) } : t)) };
}

/** The full form is paged by size: programs are added while the whole result stays at or under this (the MCP limit is 20,000; a margin for cleaning). */
export const FULL_BUDGET_CHARS = 19_000;

/**
 * Puts programs into `head` in order while the JSON of the whole result is at or under `max` characters; the rest are named in `omitted`
 * (ask for each with `program`). At least one program is always kept. At exactly `max` a program still fits; one character over, it does not.
 */
export function fitPrograms(head: Record<string, unknown>, rows: ReadonlyArray<{ program: string }>, max: number): Record<string, unknown> {
  const kept: unknown[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rest = rows.slice(i + 1).map((r) => r.program);
    const candidate = { ...head, programs: [...kept, rows[i]], ...(rest.length ? { omitted: rest, more: 'Over the size limit: ask for each omitted program with `program`.' } : {}) };
    if (kept.length > 0 && JSON.stringify(candidate).length > max) {
      const omitted = rows.slice(i).map((r) => r.program);
      return { ...head, programs: kept, omitted, more: 'Over the size limit: ask for each omitted program with `program`.' };
    }
    kept.push(rows[i]);
    if (i === rows.length - 1) return { ...head, programs: kept };
  }
  return { ...head, programs: kept };
}

/** One short row: the figures the coordinator compares every pass. */
export function compactRow(r: LabSummaryRow) {
  return {
    period: r.period,
    role: r.role,
    model: r.model,
    n: r.n,
    req_p50: med(r.requests),
    ctx_p50: med(r.ctxP50),
    result_tok_p50: med(r.resultTokens),
    min_p50: med(r.minutes),
    cost_p50: r2(med(r.costUsd)),
    inspect_share: r3(r.bashShare.inspect ?? (r.bashCalls ? 0 : null)),
    rewrite_share: r3(r.rewriteShare),
    fpy: r3(r.firstPassYield),
    cost_per_accepted: r2(r.costPerAccepted),
  };
}

const experimentRow = (v: LabExperimentView, ctx: PortalToolContext, lab: Lab) => {
  const draws = lab.drawStats(v.experiment.id);
  return {
    id: v.experiment.id,
    name: ctx.untrusted(v.experiment.name, 'lab', 80),
    status: v.experiment.status,
    design: v.experiment.design,
    strata: v.experiment.strata,
    draws_only: v.experiment.drawsOnly,
    excluded: v.excluded,
    draws,
    opted_out: draws.reduce((n, d) => n + d.opted_out, 0),
    arms: v.arms.map((a) => ({ arm: a.arm, n: a.n, accepted: a.accepted, cost_per_accepted: r2(a.costPerAccepted), ci90: ci(a.costPerAcceptedInterval) })),
  };
};

export function registerLabTools(lab: Lab, registry: ToolRegistry = portalTools): void {
  registry.register({
    name: 'lab_summary',
    title: 'Efficiency lab',
    description:
      'Slice economy per day or week and per role and model: n, median requests, context p50, result tokens (an estimate), minutes, cost per slice (estimated dollars), inspection share of Bash calls, cache re-write share, first-pass yield and median cost per accepted slice. Short rows by default; full true adds p90s, outcomes, Bash classes, the experiments with their primary and 90 percent interval, and the source of every figure. An admin’s token reads the portal; an agent’s token reads only its own session.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      period: z.enum(['day', 'week']).optional().describe('Default day.'),
      since: z.string().max(40).optional().describe('ms since the epoch or an ISO time; default the last 14 days.'),
      ...fullInput,
    }),
    handler(ctx, args) {
      let sinceMs: number | undefined;
      try {
        sinceMs = parseSince(args.since);
      } catch {
        throw new PortalToolError('VALIDATION_FAILED', 'since: ms since the epoch or an ISO time.', { since: 'ms or ISO time' });
      }
      const own = ctx.isAgent ? ctx.sessionId : null;
      if (ctx.isAgent && !own) throw new PortalToolError('FORBIDDEN', 'This token is not bound to a session.');
      const s = lab.summary({ ...(args.period ? { period: args.period } : {}), ...(sinceMs !== undefined ? { sinceMs } : {}), ...(own ? { sessionId: own } : {}) });
      const n = s.rows.reduce((t, r) => t + r.n, 0);
      const summary = `${n} slice${n === 1 ? '' : 's'} in ${s.rows.length} row${s.rows.length === 1 ? '' : 's'} since ${new Date(s.sinceMs).toISOString().slice(0, 10)}${own ? ' (this session only)' : ''}. Dollars are estimates.`;
      if (!args.full) return { summary, scope: own ? 'session' : 'portal', period: s.period, rows: s.rows.map(compactRow), tickets: ticketsShort(s.tickets), more: 'full: true for p90s, outcomes, Bash classes, experiments and sources.' };
      return {
        summary,
        scope: own ? 'session' : 'portal',
        period: s.period,
        since_ms: s.sinceMs,
        rows: s.rows,
        tickets: ticketsShort(s.tickets, 25),
        tickets_basis: ATTRIBUTION_LEAD_BASIS,
        ...(own ? {} : { experiments: lab.experimentViews().map((v) => experimentRow(v, ctx, lab)) }),
        basis: s.basis,
      };
    },
  });

  registry.register({
    name: 'crew_scorecard',
    title: 'Crew scorecard',
    description:
      'Per program (a lead chain, its continuations and workers; with its workspace) over the last 1h, 6h, day or week, and the window before: tickets done (by type, per hour, lead time p50/p90), reopened, wont_do, review backlog (age, waits for), CI, deploys; cost (estimated): total, lead vs workers, per done ticket, token-class shares; context p50/p90 per role and lead, requests, top sessions, model mix, sessions per role, live per Claude, hand-overs, spikes, the opus share of QA and review workers (D-63, with how many gave a why); refusals and bad endings; D-61, D-62, D-63 targets (ok, warn, breach, unavailable). Each figure: measured, estimate or unavailable, with its source. Short by default; full true for all. An agent’s token reads its own program; an admin’s all.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      program: z.string().regex(/^[A-Za-z0-9_.:=-]{1,120}$/).optional().describe('A program id (its first lead session). Default: every program you may read.'),
      window: z.enum(CREW_WINDOWS).optional().describe('Default day.'),
      compare: z.boolean().optional().describe('With the previous window too. Default true.'),
      ...fullInput,
    }),
    async handler(ctx, args) {
      const own = ctx.isAgent ? ctx.sessionId : null;
      if (ctx.isAgent && !own) throw new PortalToolError('FORBIDDEN', 'This token is not bound to a session.');
      const s = await lab.scorecardWithPace({ window: args.window ?? 'day', compare: args.compare ?? true, ...(args.program ? { program: args.program } : {}), ...(own ? { sessionId: own } : {}) });
      if (!s) throw new PortalToolError('NOT_FOUND', 'No such program.');
      const scope = own ? 'program' : 'portal';
      const summary = `${s.programs.length} program${s.programs.length === 1 ? '' : 's'} over the last ${s.window}${own ? ' (your own program only)' : ''}. Dollars are estimates.`;
      // Full: every figure without its own `source` (the `basis` map names each source once), so a portal of a few programs and two windows
      // stays under the result limit (MAX_RESULT_CHARS); the route keeps the sources on each figure.
      // Paged by size: a portal of five programs is more than one result holds; the rest are named in `omitted`.
      if (args.full) {
        const { programs, ...rest } = s;
        return fitPrograms({ summary, scope, ...rest, ...(s.headline ? { headline: withoutSources(s.headline) } : {}) }, programs.map(fullProgram), FULL_BUDGET_CHARS);
      }
      return { summary, scope, window: s.window, ...(s.headline ? { headline: s.headline } : {}), programs: s.programs.map(scoreShort), more: 'full: true for every figure with its basis, types, CI, deploys, efficiency, health and the review list; basis names the sources.' };
    },
  });

  registry.register({
    name: 'lab_arm_draw',
    title: 'Draw a slice\'s arm',
    description:
      'Draws the arm of a sub-agent slice before you write its brief, in every running draws-only experiment (the arm is fixed per ticket, so drawing again gives the same arm; the ticket must exist; the stratum from the ticket\'s ESTIMATE size and the role, model and effort you will dispatch with). Put `Lab-Draw: <draw>` in the brief\'s first line: when that Agent call starts in this session, with the same ticket, role, model and effort (and the ticket\'s ESTIMATE size unchanged), the slice keeps these arms. One draw per slice; every draw is counted, used or not, and a slice of a drawn ticket dispatched without its draw is out and counted. No draws-only experiment running: no draw, nothing recorded. Your own session only.',
    scope: 'agent',
    hints: { idempotent: false },
    rate: { perHour: 120 },
    input: z.object({
      ticket: z.string().regex(/^T-\d{1,6}$/).describe('The slice\'s ticket (its ESTIMATE size is the size stratum).'),
      role: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/).optional().describe('The Agent call\'s subagent_type.'),
      model: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/).optional().describe('The Agent call\'s model; absent: inherit.'),
      effort: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/).optional().describe('The Agent call\'s effort.'),
    }),
    handler(ctx, args) {
      if (!ctx.sessionId) throw new PortalToolError('FORBIDDEN', 'A draw belongs to a chat session: call it with the token of the session that dispatches the slice.');
      let d: ReturnType<Lab['drawArms']>;
      try {
        d = lab.drawArms({ sessionId: ctx.sessionId, ticket: args.ticket, role: args.role ?? null, model: args.model ?? null, effort: args.effort ?? null });
      } catch (e) {
        if (e instanceof Error && e.message === 'no such ticket') throw new PortalToolError('NOT_FOUND', 'No such ticket: a draw is for a ticket that exists.');
        throw e;
      }
      const arms = d.arms.map((a) => ({ experiment: a.experiment, name: ctx.untrusted(a.name, 'lab', 80), arm: a.arm }));
      if (d.draw) ctx.affected(`lab_draw:${d.draw}`);
      return {
        summary: d.draw ? `Drew ${arms.map((a) => a.arm).join(', ')} for this slice. First line of the brief: Lab-Draw: ${d.draw}` : 'No draws-only experiment is running: no draw, nothing recorded, the ordinary brief.',
        draw: d.draw,
        arms,
      };
    },
  });

  registry.register({
    name: 'lab_experiment_set',
    title: 'Start or stop an experiment',
    description:
      'Starts an experiment (action start: a randomized one with two or more arms, assigned per slice in balanced blocks per stratum: role and requested model, or the stratum keys given (ESTIMATE size, role, model, effort); or before_after with the moment of the change) or stops one (action stop, by id). Rules (primary metric, minimum n, thresholds) are written before the start. Asks for the confirmation round trip first. Admin tokens only.',
    scope: 'admin',
    hints: { idempotent: false },
    rate: { perHour: 30 },
    input: z.object({
      action: z.enum(['start', 'stop']),
      id: z.string().max(60).optional().describe('stop: the experiment.'),
      name: z.string().min(1).max(60).optional(),
      hypothesis: z.string().max(500).optional(),
      design: z.enum(['randomized', 'before_after']).optional(),
      arms: z.array(z.string().max(40)).max(6).optional(),
      strata: z.array(z.enum(LAB_STRATUM_KEYS)).min(1).max(4).optional().describe('randomized: the stratum keys; default role and requested model.'),
      draws_only: z.boolean().optional().describe('randomized: only a bound draw (lab_arm_draw) gives an arm; a slice without one is excluded (E2).'),
      primary_metric: z.string().max(80).optional().describe('Default: median cost per accepted slice.'),
      min_n: z.number().int().min(0).max(100000).optional(),
      thresholds: z.record(z.string().max(40), z.union([z.number(), z.string().max(80)])).optional(),
      start: z.string().max(40).optional().describe('ms or ISO time; default now.'),
      switch_at: z.string().max(40).optional().describe('before_after: the moment of the change.'),
      confirm_token: z.string().optional(),
    }),
    handler(ctx, args) {
      if (args.action === 'stop') {
        const e = lab.experiments().find((x) => x.id === args.id);
        if (!e) throw new PortalToolError('NOT_FOUND', 'No such experiment.');
        if (e.status !== 'running') return { summary: `Already ${e.status}.`, id: e.id, did: 'nothing' };
        const gate = ctx.confirm(args, { stop: e.name, arms: e.arms, effect: 'New slices get no arm from now on; the slices so far stay in the report.' }, `${e.id}@${e.status}`);
        if (gate) return gate;
        lab.stop(e.id);
        ctx.affected(`lab_experiment:${e.id}`);
        return { summary: 'Stopped the experiment.', id: e.id, did: 'stopped' };
      }
      if (!args.name || !args.design) throw new PortalToolError('VALIDATION_FAILED', 'start needs name and design.', { name: 'required', design: 'required' });
      let startMs: number | undefined, switchMs: number | undefined;
      try {
        startMs = parseSince(args.start);
        switchMs = parseSince(args.switch_at);
      } catch {
        throw new PortalToolError('VALIDATION_FAILED', 'start and switch_at: ms since the epoch or an ISO time.', { start: 'ms or ISO time' });
      }
      const preview = { start: args.name, design: args.design, arms: args.design === 'before_after' ? ['before', 'after'] : (args.arms ?? []), strata: args.strata ?? ['role', 'model'], draws_only: args.draws_only ?? false, primary_metric: args.primary_metric ?? 'median cost per accepted slice', min_n: args.min_n ?? 0, effect: args.design === 'randomized' ? (args.draws_only ? 'Only a slice whose brief names a bound draw gets an arm; every other slice is excluded.' : 'Every new sub-agent slice gets an arm.') : 'Slices in the window are split at the moment of the change.' };
      const gate = ctx.confirm(args, preview, `new:${args.name}`);
      if (gate) return gate;
      try {
        const e = lab.createExperiment({
          name: args.name,
          ...(args.hypothesis ? { hypothesis: args.hypothesis } : {}),
          design: args.design,
          ...(args.arms ? { arms: args.arms } : {}),
          ...(args.strata ? { strata: args.strata } : {}),
          ...(args.draws_only ? { drawsOnly: true } : {}),
          primaryMetric: args.primary_metric ?? 'median cost per accepted slice',
          ...(args.thresholds ? { thresholds: args.thresholds } : {}),
          ...(args.min_n !== undefined ? { minN: args.min_n } : {}),
          startMs: startMs ?? Date.now(),
          ...(switchMs !== undefined ? { switchMs } : {}),
        });
        ctx.affected(`lab_experiment:${e.id}`);
        return { summary: `Started the experiment with arms ${e.arms.join(', ')}.`, id: e.id, did: 'started', arms: e.arms };
      } catch (e) {
        const msg = e instanceof Error && /UNIQUE/.test(e.message) ? 'An experiment with this name exists.' : e instanceof Error ? e.message : 'Not valid.';
        throw new PortalToolError('VALIDATION_FAILED', msg.slice(0, 200));
      }
    },
  });
}
