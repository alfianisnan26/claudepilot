// Pilot metrics over the Portal MCP (T-2360 section D, docs/prd/claude-usage.md §28.15): the same numbers as GET /api/lab/metrics/*,
// read through `Lab.metrics` (metricsService.ts), never a copy of its logic. Read only, declared in authz.ts.
//
// Who may call (the policy, authz.ts): these are whole-portal numbers (every program's tickets, every crew, every Claude's pace), which the
// REST routes give only to a reader of the platform area `usage`. The ticket's readers are the leads (agents) and the operator, and the seam
// boxes every agent out of a platform area, so the tools are `scope: 'agent'` with the reach checked here:
// - an agent's per-session token: only when its session is a lead (a top-level chat: no parent session) AND the session's recorded owner
//   (chat_sessions.owner_id: a manager chat's owner; every other chat records the founding user today, its starter is not stored) may view
//   `usage` (the routes' reader), and then only its own crew: the tickets its lineage held (the crew scorecard's own program), no
//   paces, no score a window ago and no trend (both whole-program snapshots). A worker gets NOT_FOUND, the dispatch's own "Not found." (its
//   sub-agents share the lead's token, so a lead's helpers read them too);
// - an admin's (cpat_) or the manager's (cpmt_) token: only with `view` on `usage` through can(), as the routes ask.
// Results are short by default (T-282) and kept under the result limit (FULL_BUDGET_CHARS); durations are hours with two decimals; ticket
// ids and program ids only (no ticket text, no session titles); a figure the portal does not have is `unavailable:<reason>`, never 0.

import {
  METRICS_GROUP_BY,
  METRICS_STAGES,
  METRICS_TREND_KEYS,
  METRICS_TREND_WINDOWS,
  METRICS_WINDOWS,
  platformRef,
  type Actor,
  type CrewFigure,
  type MetricsFlowGroup,
  type MetricsFlowWindow,
  type MetricsScore,
  type MetricsStage,
  type MetricsTicketRow,
  type MetricsUnavailable,
} from '@portal/contracts';
import { actorOfPrincipal, can } from '../authz/seam.js';
import { fullInput } from '../portalmcp/compact.js';
import { PAGE_DEFAULT, PAGE_MAX, pageInput, pageWindow } from '../portalmcp/paging.js';
import { PortalToolError, portalTools, z, type PortalToolContext, type ToolRegistry } from '../portalmcp/registry.js';
import { ticketKeyField, ticketVisibleTo } from '../tickets/keys.js';
import type { Lab } from './index.js';
import type { MetricsScope } from './metricsService.js';
import { FULL_BUDGET_CHARS, withoutSources } from './portalTools.js';

const ID = /^[A-Za-z0-9_.:=-]{1,120}$/;
const programArg = z
  .string()
  .regex(ID)
  .optional()
  .describe('A program id (metrics programs: all, a setting entry, a program-* tag, a flow program). Default: all.');
const windowArg = z.enum(METRICS_WINDOWS).optional().describe('24h or 7d, compared with the window before it. Default 24h.');

/** Short rows of the drill-down by default, at most this many with `limit`. */
export const TICKETS_DEFAULT = PAGE_DEFAULT;
export const TICKETS_MAX = PAGE_MAX;
/** Room kept under the size budget for the page's `next_cursor`. */
const CURSOR_ROOM = 500;
/** Groups in a short flow_times result; `full` fits as many as the size budget holds. */
export const GROUPS_SHORT = 30;

/** ms to hours, two decimals; null stays null. */
export const hours = (ms: number | null | undefined): number | null =>
  ms === null || ms === undefined ? null : Math.round(ms / 36_000) / 100;
const iso = (ms: number) => new Date(ms).toISOString();
/** A figure in a short row: its value, or `unavailable:<reason>`. */
const fig = (f: CrewFigure) => (f.basis === 'unavailable' ? `unavailable:${f.reason ?? 'no_source'}` : f.value);
/** Figures the closed-ticket read could not give (the service's null `total` or `flow`, with its `unavailable`): never 0, never "null". */
const gone = (u: MetricsUnavailable | undefined) => `unavailable:${u?.reason ?? 'no_source'}`;
const UNREAD = 'unavailable (the closed tickets could not be read)';

/**
 * The reach (see the header): an agent's token only for a lead session whose recorded owner may view `usage`, and then only its own crew's tickets;
 * an admin's or manager's only with `view` on `usage`. A refusal is the dispatch's own NOT_FOUND ("Not found."), so it reads like any
 * refused tool.
 */
export function metricsReach(ctx: PortalToolContext, lab: Lab): { reach: 'crew' | 'portal'; scope: MetricsScope } {
  const no = () => new PortalToolError('NOT_FOUND', 'Not found.');
  if (ctx.isAgent) {
    const scope = ctx.sessionId ? lab.metrics.leadScope(ctx.sessionId) : null;
    if (!scope) throw no();
    return { reach: 'crew', scope };
  }
  if (!can(actorOfPrincipal(ctx.principal), 'view', platformRef('usage')).allow) throw no();
  return { reach: 'portal', scope: null };
}

const noProgram = () => new PortalToolError('NOT_FOUND', 'No such program.');
const found = <T>(v: T | null): T => {
  if (v === null) throw noProgram();
  return v;
};

/** A score: its value, the one a window ago, the change, and each part as a value or `unavailable:<reason>`. */
export function scoreShort(s: MetricsScore) {
  return {
    value: s.value,
    previous: s.previous,
    delta: s.value !== null && s.previous !== null ? Math.round((s.value - s.previous) * 10) / 10 : null,
    parts: Object.fromEntries(s.components.map((c) => [c.id, c.value === null ? `unavailable:${c.reason ?? 'no_source'}` : c.value])),
  };
}

const stageRow = (w: MetricsFlowWindow, stage: MetricsStage) => w.stages.find((s) => s.stage === stage)!;

/** One flow group: done and won't-do now and before, each stage's n, left out, p50 and p90 (hours) and the p50 before, the test rounds. */
export function flowShort(g: MetricsFlowGroup) {
  return {
    done: g.current.done,
    wont_do: g.current.wontDo,
    before: { done: g.previous.done, wont_do: g.previous.wontDo },
    stages: Object.fromEntries(
      METRICS_STAGES.map((st) => {
        const c = stageRow(g.current, st);
        return [
          st,
          {
            n: c.n,
            left_out: c.excluded,
            p50_h: hours(c.medianMs),
            p90_h: hours(c.p90Ms),
            before_p50_h: hours(stageRow(g.previous, st).medianMs),
          },
        ];
      }),
    ),
    rounds: {
      n: g.current.rounds.n,
      median: g.current.rounds.medianRounds,
      reworked: g.current.rounds.reworked,
      fails: g.current.rounds.fails,
    },
  };
}

/** One group in the short flow_times: done now and before, the stage medians (hours), resolve p90. */
const groupShort = (g: MetricsFlowGroup) => ({
  key: g.key,
  done: g.current.done,
  wont_do: g.current.wontDo,
  before_done: g.previous.done,
  p50_h: Object.fromEntries(METRICS_STAGES.map((st) => [st, hours(stageRow(g.current, st).medianMs)])),
  resolve_p90_h: hours(stageRow(g.current, 'resolve').p90Ms),
});

/**
 * T-3070: the row of a ticket the caller may not see (another person's bucket): every field null, its id too, so it says nothing of that ticket
 * (its id in a list filtered by stage, type, priority or lead would tell those). It keeps its place, so `total` and the cursor stay true; the
 * counts are the same aggregate the flow figures already give.
 */
export const HIDDEN_TICKET_ROW = Object.freeze({
  ticket: null,
  type: null,
  priority: null,
  status: null,
  closed: null,
  lead: null,
  h: null,
  rounds: null,
  fails: null,
});

/** A drill-down row: ids, type, priority, status, close time, lead, the stage hours (null: left out), rounds and fails. */
const ticketShort = (actor: Actor) => (r: MetricsTicketRow) => {
  if (!ticketVisibleTo(r.ticket, actor)) return { ...HIDDEN_TICKET_ROW };
  return {
    ticket: r.ticket,
    ...ticketKeyField(r.ticket, actor),
    type: r.type,
    priority: r.priority,
    status: r.status,
    closed: iso(r.closedAtMs),
    lead: r.lead,
    h: Object.fromEntries(METRICS_STAGES.map((st) => [st, hours(r.stages[st])])),
    rounds: r.rounds,
    fails: r.fails,
  };
};

/** Removes every `title` (a session's title is an agent's text) from a copy. */
function withoutTitles<T>(x: T): T {
  if (Array.isArray(x)) return x.map(withoutTitles) as T;
  if (!x || typeof x !== 'object') return x;
  return Object.fromEntries(
    Object.entries(x as Record<string, unknown>)
      .filter(([k]) => k !== 'title')
      .map(([k, v]) => [k, withoutTitles(v)]),
  ) as T;
}

/** Keeps `rows` in order while the whole result's JSON is at or under `max`; the count left out goes into `omitted` with how to see them. */
export function fitRows<T>(
  head: Record<string, unknown>,
  key: string,
  rows: readonly T[],
  max: number,
  more: string,
): Record<string, unknown> {
  let lo = 0,
    hi = rows.length;
  const make = (n: number) => ({ ...head, [key]: rows.slice(0, n), ...(n < rows.length ? { omitted: rows.length - n, more } : {}) });
  if (JSON.stringify(make(hi)).length <= max) return make(hi);
  // The largest n that fits (binary search: the size grows with n).
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(make(mid)).length <= max) lo = mid;
    else hi = mid - 1;
  }
  return make(lo);
}

export function registerMetricsTools(lab: Lab, registry: ToolRegistry = portalTools): void {
  const reachNote =
    'An agent’s token: a lead session (its recorded owner may view usage), its own crew’s tickets only (a worker gets not found); an admin’s: with view on usage.';

  registry.register({
    name: 'metrics_overview',
    title: 'Pilot metrics',
    description: `One program over the last 24h or 7d (default all, 24h): the efficiency and effectiveness scores 0-100 with the one a window ago and each part; tickets done and won't-do now and before; per stage (start, report, implement, test, deliver, resolve, work) n, left out, median and p90 in hours and the median before; test rounds; open work (open, in progress, blocked, in review, oldest review, stalled); the crews' pace, resolved, dollars per resolved and per done (estimates), created per closed. Short by default; full true for every figure with its basis. ${reachNote}`,
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ program: programArg, window: windowArg, ...fullInput }),
    async handler(ctx, args) {
      const { reach, scope: crew } = metricsReach(ctx, lab);
      const ov = found(await lab.metrics.overview(args.program, args.window ?? '24h', crew));
      const p = ov.program;
      const summary = `${p.label} (${p.id}) over the last ${ov.window}: efficiency ${ov.efficiency.value ?? 'unavailable'}, effectiveness ${ov.effectiveness.value ?? 'unavailable'}, ${ov.flow ? `${ov.flow.current.done} done, ${ov.flow.current.wontDo} won't-do` : `done and won't-do ${UNREAD}`}. Dollars are estimates.`;
      if (args.full) {
        const flow = ov.flow ?? gone(ov.flowUnavailable);
        const full = { summary, reach, ...withoutTitles(withoutSources(ov)), flow, basis: ov.basis };
        return JSON.stringify(full).length <= FULL_BUDGET_CHARS
          ? full
          : {
              summary,
              reach,
              ...withoutTitles(withoutSources({ ...ov, crew: null })),
              flow,
              basis: ov.basis,
              cut: ['crew: over the size limit; the short form has its headline.'],
            };
      }
      const h = ov.crew?.headline;
      return {
        summary,
        reach,
        program: {
          id: p.id,
          label: p.label,
          kind: p.kind,
          source: p.source,
          targets: p.targets,
          ...(p.unavailable ? { unavailable: `unavailable:${p.unavailable.reason}` } : {}),
        },
        window: ov.window,
        now: iso(ov.nowMs),
        efficiency: scoreShort(ov.efficiency),
        effectiveness: scoreShort(ov.effectiveness),
        flow: ov.flow ? flowShort(ov.flow) : gone(ov.flowUnavailable),
        open: ov.open
          ? {
              open: ov.open.open,
              in_progress: ov.open.inProgress,
              blocked: ov.open.blocked,
              in_review: ov.open.inReview,
              oldest_review_h: hours(ov.open.oldestReviewMs),
              stalled: ov.open.stalled,
            }
          : p.kind === 'commits'
            ? 'unavailable:no_source'
            : 'unavailable:store_unreadable',
        crew: ov.crew
          ? {
              crews: ov.crew.programs.length,
              pace_ratio: h ? fig(h.pace.ratio) : 'unavailable:no_source',
              resolved: h ? fig(h.current.resolved) : 'unavailable:no_source',
              per_resolved_usd: h ? fig(h.current.perResolvedUsd) : 'unavailable:no_source',
              created_per_closed: h ? fig(h.current.createdPerClosed) : 'unavailable:no_source',
              cost_usd: fig(ov.crew.cost.total),
              lead_share_pct: fig(ov.crew.cost.leadShare),
              per_done_usd: fig(ov.crew.cost.perDone),
            }
          : 'unavailable:store_unreadable',
        more: 'full: true for every part with its basis and raw figure, the crews and the headline; basis names the sources.',
      };
    },
  });

  registry.register({
    name: 'metrics_flow_times',
    title: 'Ticket flow times',
    description: `Per stage of the tickets closed done in the last 24h or 7d (start: created to in progress; report: to the first agent comment; implement: in progress to the first verdict or merge; test: first to last passing verdict; deliver: merge to done; resolve: created to done; work: in progress to done): n, left out (a timestamp not recorded, never 0), median and p90 in hours, the median before, test rounds; with group_by (program, lead, type, priority) the same per group, biggest first. Short by default (${GROUPS_SHORT} groups, medians only); full true for every stage of every group that fits. ${reachNote}`,
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      program: programArg,
      window: windowArg,
      group_by: z.enum(METRICS_GROUP_BY).optional().describe('program, lead (area-* tag or lead:<session>), type or priority.'),
      ...fullInput,
    }),
    handler(ctx, args) {
      const { reach, scope: crew } = metricsReach(ctx, lab);
      const f = found(lab.metrics.flow(args.program, args.window ?? '24h', args.group_by ?? null, crew));
      if (f.total === null)
        return {
          summary: `${f.program} over the last ${f.window}: flow times ${UNREAD}.`,
          reach,
          program: f.program,
          window: f.window,
          group_by: f.groupBy,
          total: gone(f.unavailable),
          groups: [],
        };
      const summary = `${f.program} over the last ${f.window}: ${f.total.current.done} done${f.groupBy ? `, ${f.groups.length} ${f.groupBy} group${f.groups.length === 1 ? '' : 's'}` : ''}. Hours.`;
      const head = { summary, reach, program: f.program, window: f.window, group_by: f.groupBy, total: flowShort(f.total) };
      if (args.full)
        return fitRows(
          { ...head, basis: f.basis },
          'groups',
          f.groups.map((g) => ({ key: g.key, ...flowShort(g) })),
          FULL_BUDGET_CHARS,
          'Over the size limit: ask metrics_tickets with group_by and group for one group.',
        );
      return fitRows(head, 'groups', f.groups.slice(0, GROUPS_SHORT).map(groupShort), FULL_BUDGET_CHARS, 'Over the size limit.');
    },
  });

  registry.register({
    name: 'metrics_trend',
    title: 'Metric trend',
    description:
      'One metric of one program over the last 24h, 7d or 30d (default 7d) from the snapshots (written every 10 minutes, kept 30 days), oldest first, at most about 200 points [ms since the epoch, value]; null where the snapshot had no value. metric: efficiency, effectiveness, done24h, wontDo24h, openWork, blocked, inReview, or <stage>P50 (the 24 h median, ms). With first, last, min and max. ' +
      reachNote,
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      metric: z.enum(METRICS_TREND_KEYS),
      program: programArg,
      window: z.enum(METRICS_TREND_WINDOWS).optional().describe('24h, 7d or 30d. Default 7d.'),
    }),
    handler(ctx, args) {
      const { reach, scope: crew } = metricsReach(ctx, lab);
      // The snapshots hold whole-program numbers: an agent's crew read has no trend (never another crew's figures).
      if (crew) {
        const p = found(lab.metrics.program(args.program));
        return {
          summary: `${args.metric} of ${p.id}: unavailable for an agent's token (the trend is kept for whole programs only).`,
          reach,
          program: p.id,
          metric: args.metric,
          window: args.window ?? '7d',
          points: [],
          unavailable: 'unavailable:no_source',
        };
      }
      const t = found(lab.metrics.trend(args.program, args.metric, args.window ?? '7d'));
      const vals = t.points.map((p) => p.value).filter((v): v is number => v !== null);
      const summary = vals.length
        ? `${t.metric} of ${t.program} over the last ${t.window}: ${t.points.length} points, first ${vals[0]}, last ${vals.at(-1)}.`
        : `${t.metric} of ${t.program} over the last ${t.window}: unavailable (no snapshot with a value in the window).`;
      return {
        summary,
        reach,
        program: t.program,
        metric: t.metric,
        window: t.window,
        unit: t.metric.endsWith('P50') ? 'ms' : t.metric === 'efficiency' || t.metric === 'effectiveness' ? 'score 0-100' : 'count',
        first: vals[0] ?? null,
        last: vals.at(-1) ?? null,
        min: vals.length ? Math.min(...vals) : null,
        max: vals.length ? Math.max(...vals) : null,
        points: t.points.map((p) => [p.atMs, p.value]),
        source: t.source,
      };
    },
  });

  registry.register({
    name: 'metrics_insights',
    title: 'Metric findings',
    description: `Plain-language findings for one program over the last 24h or 7d: the slowest stage, the biggest regression against the window before, idle capacity, the blocked share, the review wait and outliers, each with its severity (act, warn, info) and the ticket ids behind it. ${reachNote}`,
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ program: programArg, window: windowArg }),
    async handler(ctx, args) {
      const { reach, scope: crew } = metricsReach(ctx, lab);
      const ins = found(await lab.metrics.insights(args.program, args.window ?? '24h', crew));
      const act = ins.items.filter((i) => i.severity === 'act').length;
      const summary = `${ins.items.length} finding${ins.items.length === 1 ? '' : 's'} for ${ins.program} over the last ${ins.window}${act ? `, ${act} to act on` : ''}.`;
      return {
        summary,
        reach,
        program: ins.program,
        window: ins.window,
        items: ins.items.map((i) => ({ kind: i.kind, severity: i.severity, text: i.text, tickets: i.tickets })),
      };
    },
  });

  registry.register({
    name: 'metrics_tickets',
    title: 'Tickets behind a metric',
    description: `The tickets behind a flow number: those closed done or won't-do in the last 24h or 7d, newest close first, optionally only those with a stage recorded and in one group (group_by and group, as in metrics_flow_times). Each: ticket and ticket_key, type, priority, status, closed, lead, hours per stage (null: left out), rounds, fails; a ticket you may not view: every field null. Paged: ${TICKETS_DEFAULT} rows a page by default, limit up to ${TICKETS_MAX}, the next page with cursor (next_cursor; null on the last). ${reachNote}`,
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      program: programArg,
      window: windowArg,
      stage: z.enum(METRICS_STAGES).optional().describe('Only tickets with this stage recorded.'),
      group_by: z.enum(METRICS_GROUP_BY).optional(),
      group: z.string().regex(ID).optional().describe('A group key from metrics_flow_times (needs group_by).'),
      ...pageInput,
    }),
    handler(ctx, args) {
      const { reach, scope: crew } = metricsReach(ctx, lab);
      if (args.group && !args.group_by)
        throw new PortalToolError('VALIDATION_FAILED', 'group: needs group_by.', { group: 'needs group_by' });
      // The cursor is bound to the query (program, window, stage, group): another query's cursor is INVALID_CURSOR.
      const page = pageWindow(args, {
        p: args.program ?? 'all',
        w: args.window ?? '24h',
        s: args.stage ?? null,
        b: args.group_by ?? null,
        g: args.group ?? null,
      });
      const t = found(
        lab.metrics.tickets(
          args.program,
          args.window ?? '24h',
          {
            ...(args.stage ? { stage: args.stage } : {}),
            ...(args.group_by ? { groupBy: args.group_by } : {}),
            ...(args.group ? { group: args.group } : {}),
            offset: page.offset,
          },
          crew,
        ),
      );
      const scope = `${t.window} for ${t.program}${t.stage ? ` with ${t.stage} recorded` : ''}${t.group ? ` in ${t.groupBy} ${t.group}` : ''}`;
      if (t.total === null)
        return {
          summary: `Tickets closed in the last ${scope}: ${UNREAD}.`,
          reach,
          program: t.program,
          window: t.window,
          stage: t.stage,
          group_by: t.groupBy,
          group: t.group,
          total: gone(t.unavailable),
          rows: [],
          next_cursor: null,
        };
      const rows = t.rows.slice(0, page.limit).map(ticketShort(actorOfPrincipal(ctx.principal)));
      const summary = `${t.total} ticket${t.total === 1 ? '' : 's'} closed in the last ${scope}${page.offset ? `, from row ${page.offset + 1}` : ''}. Hours.`;
      const head = {
        summary,
        reach,
        program: t.program,
        window: t.window,
        stage: t.stage,
        group_by: t.groupBy,
        group: t.group,
        total: t.total,
      };
      const out = fitRows(
        head,
        'rows',
        rows,
        FULL_BUDGET_CHARS - CURSOR_ROOM,
        'Over the size limit: the rest is on the next page (next_cursor).',
      );
      return { ...out, next_cursor: page.next((out.rows as unknown[]).length, t.total) };
    },
  });
}
