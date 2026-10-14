// Efficiency lab over the Portal MCP (docs/prd/claude-usage.md §28.10), declared in authz.ts:
//
// - `lab_summary`: the coordinator's pass in one call. Short rows by default (T-282's compact rule: a result is read again on every later
//   request), `full: true` for every field, the experiments and the sources. An admin's token reads the portal; an agent's token reads only
//   its own session's slices (no experiments).
// - `lab_experiment_set`: admin tokens only, with the confirmation round trip: start a randomized or before-and-after experiment, or stop one.
//
// Counts and ids only; an experiment's name and hypothesis are a person's text and come back labelled untrusted.

import { LAB_STRATUM_KEYS, type LabExperimentView, type LabInterval, type LabStat, type LabSummaryRow } from '@portal/contracts';
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

const experimentRow = (v: LabExperimentView, ctx: PortalToolContext) => ({
  id: v.experiment.id,
  name: ctx.untrusted(v.experiment.name, 'lab', 80),
  status: v.experiment.status,
  design: v.experiment.design,
  strata: v.experiment.strata,
  excluded: v.excluded,
  arms: v.arms.map((a) => ({ arm: a.arm, n: a.n, accepted: a.accepted, cost_per_accepted: r2(a.costPerAccepted), ci90: ci(a.costPerAcceptedInterval) })),
});

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
      if (!args.full) return { summary, scope: own ? 'session' : 'portal', period: s.period, rows: s.rows.map(compactRow), more: 'full: true for p90s, outcomes, Bash classes, experiments and sources.' };
      return {
        summary,
        scope: own ? 'session' : 'portal',
        period: s.period,
        since_ms: s.sinceMs,
        rows: s.rows,
        ...(own ? {} : { experiments: lab.experimentViews().map((v) => experimentRow(v, ctx)) }),
        basis: s.basis,
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
      const preview = { start: args.name, design: args.design, arms: args.design === 'before_after' ? ['before', 'after'] : (args.arms ?? []), strata: args.strata ?? ['role', 'model'], primary_metric: args.primary_metric ?? 'median cost per accepted slice', min_n: args.min_n ?? 0, effect: args.design === 'randomized' ? 'Every new sub-agent slice gets an arm.' : 'Slices in the window are split at the moment of the change.' };
      const gate = ctx.confirm(args, preview, `new:${args.name}`);
      if (gate) return gate;
      try {
        const e = lab.createExperiment({
          name: args.name,
          ...(args.hypothesis ? { hypothesis: args.hypothesis } : {}),
          design: args.design,
          ...(args.arms ? { arms: args.arms } : {}),
          ...(args.strata ? { strata: args.strata } : {}),
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
