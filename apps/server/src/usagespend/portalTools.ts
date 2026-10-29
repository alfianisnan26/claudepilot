// Usage spend over the Portal MCP (docs/prd/claude-usage.md §26): four read tools and two that change budgets.
//
// - `usage_summary`, `usage_attribution`, `usage_budgets`, `usage_spikes`: an admin's token reads the whole portal; an agent's per-session token
//   (interface I8) reads only its own session and the sessions below it, and the budgets that count it, so it can tell it is near a limit.
// - `usage_budget_set`, `usage_budget_delete`: admin scope only (never an agent), audited like every call, and each says what it did. Making a budget
//   that PAUSES messages, and deleting one, ask for the confirmation round trip first. An agent can never change a budget or a limit.
//
// Dollars are always estimates (API-equivalent for a plan, not a bill): every result says so once under `basis`, and each derived figure carries
// its own `basis`. Text that came from a session or a persona (a title, a name) is labelled untrusted; no tool returns a login, an email or an id of
// an account.

import { AppError } from '@isnanme/core';
import {
  ATTRIBUTION_BY,
  CHAT_USAGE_RANGES,
  type AttributionRow,
  type BudgetState,
  type ChatUsageTotals,
  type SpendFigure,
  type SpikeEvent,
} from '@portal/contracts';
import { fullInput } from '../portalmcp/compact.js';
import { portalTools, PortalToolError, z, type PortalToolContext, type ToolRegistry } from '../portalmcp/registry.js';
import { OWNER_ACTOR, type Who } from './actor.js';
import type { UsageSpend } from './service.js';
import { ticketKeyField, ticketKeyOf } from '../tickets/keys.js';
import { actorOfPrincipal } from '../authz/seam.js';

/** T-1993: a ticket's bucket key as the caller may see it (none for a bucket it may not view). */
const keyOf = (ctx: PortalToolContext, id: string): { key?: string } => {
  const k = ticketKeyOf(id, actorOfPrincipal(ctx.principal));
  return k ? { key: k } : {};
};
/** T-1993: a session's `ticket_key`, asked again with the caller's actor (the stored one was read for the portal, not for this caller). */
const sessionKey = (ctx: PortalToolContext, ticketId: string | null | undefined) => ticketKeyField(ticketId, actorOfPrincipal(ctx.principal));

const BASIS = { cost_usd: 'estimate', tokens: 'measured', requests: 'measured', note: 'Dollars are Claude Code’s own price estimate: for a plan, what the same use would cost on the API, not a bill.' } as const;

/** camelCase keys to snake_case, all the way down (evidence carries nested figures). */
export function snake(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snake);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snake(x)]));
  return v;
}

const totals = (t: ChatUsageTotals) => ({
  cost_usd: t.costUsd,
  input_tokens: t.input,
  output_tokens: t.output,
  cache_read_tokens: t.cacheRead,
  cache_write_tokens: t.cacheWrite,
  requests: t.requests,
  agents: t.agents,
});

const figure = (f: SpendFigure) => (f.basis === 'unavailable' ? { value: null, basis: f.basis, reason: f.reason } : { value: f.value, basis: f.basis });

function rowView(ctx: PortalToolContext, r: AttributionRow) {
  const s = r.session;
  return {
    key: r.key,
    // A session's title and a persona's name come from people and agents: labelled, never instructions.
    label: r.by === 'session' || r.by === 'persona' ? ctx.untrusted(r.label, 'usage', 120) : r.label,
    state: r.state,
    ...(r.reason ? { reason: r.reason } : {}),
    own: totals(r.own),
    total: totals(r.total),
    share_pct: figure(r.share),
    sessions: r.sessions,
    first_at: r.firstAt,
    last_at: r.lastAt,
    ...ticketView(ctx, r),
    ...(s
      ? {
          session: {
            session_id: s.sessionId,
            workspace_id: s.workspaceId,
            claude_id: s.claudeId,
            claude: s.claudeName,
            ticket_id: s.ticketId,
            ...sessionKey(ctx, s.ticketId),
            parent_id: s.parentId,
            depth: s.depth,
            children: s.children,
            exists: s.exists,
            state: s.state,
          },
        }
      : {}),
  };
}

/** An attribution row in short (T-282): dollars and requests, the tree's shape; full true adds the tokens and the times. */
function rowShort(ctx: PortalToolContext, r: AttributionRow) {
  const s = r.session;
  const money = (t: ChatUsageTotals) => ({ cost_usd: t.costUsd, requests: t.requests });
  return {
    key: r.key,
    label: r.by === 'session' || r.by === 'persona' ? ctx.untrusted(r.label, 'usage', 80) : r.label,
    state: r.state,
    ...(r.reason ? { reason: r.reason } : {}),
    own: money(r.own),
    total: money(r.total),
    share_pct: figure(r.share),
    ...(s ? { session: { session_id: s.sessionId, ticket_id: s.ticketId, ...sessionKey(ctx, s.ticketId), parent_id: s.parentId, depth: s.depth, state: s.state } } : {}),
    ...ticketView(ctx, r),
  };
}

/** By ticket (T-449): type, status, done time and the dollars apportioned from leads (the row's `total` holds them; `own` does not). */
function ticketView(ctx: PortalToolContext, r: AttributionRow) {
  const t = r.ticket;
  // T-1098: a by-ticket row's key is the stable id; its bucket key goes beside it (T-1993: when the caller may view its bucket).
  return t ? { ticket: { ...(r.by === 'ticket' ? { id: r.key, ...keyOf(ctx, r.key) } : {}), type: t.type, status: t.status, done_at: t.doneAt, via_lead_usd: t.viaLeadUsd, via_lead_workers: t.viaLeadWorkers } } : {};
}

function budgetView(s: BudgetState) {
  const b = s.budget;
  return {
    id: b.id,
    name: b.name,
    scope: b.scope.kind,
    scope_id: b.scope.id,
    scope_label: s.scopeLabel,
    period: b.period,
    limit_usd: b.limitUsd,
    limit_tokens: b.limitTokens,
    mode: b.mode,
    enabled: b.enabled,
    used_usd: figure(s.usedUsd),
    used_tokens: figure(s.usedTokens),
    used_pct: figure(s.usedPct),
    limiting: s.limiting,
    level: s.level,
    paused: s.paused,
    period_start: s.periodStart,
    period_end: s.periodEnd,
    timezone: s.timezone,
    snoozed_until: s.snoozedUntil,
  };
}

function spikeView(ctx: PortalToolContext, e: SpikeEvent) {
  return {
    id: e.id,
    kind: e.kind,
    at: e.at,
    heuristic: true,
    summary: e.summary,
    session_id: e.sessionId,
    session_title: ctx.untrusted(e.sessionTitle, 'usage', 120),
    claude_id: e.claudeId,
    claude: e.claudeName,
    workspace_id: e.workspaceId,
    evidence: snake(e.evidence),
    alerted: e.alerted,
    snoozed_until: e.snoozedUntil,
  };
}

const money = (v: number) => `$${v.toFixed(2)}`;

/** "the daily budget for api: $10 estimated, 1,000,000 tokens, alerts only" */
function describe(s: BudgetState): string {
  const b = s.budget;
  const limits = [b.limitUsd !== null ? `${money(b.limitUsd)} estimated` : null, b.limitTokens !== null ? `${b.limitTokens.toLocaleString('en-US')} tokens` : null].filter(Boolean).join(', ');
  return `the ${b.period === 'day' ? 'daily' : 'monthly'} budget for ${s.scopeLabel ?? 'a removed scope'}: ${limits}, ${b.mode === 'pause' ? 'pauses new messages when used up' : 'alerts only'}`;
}

export function registerUsageSpendTools(spend: UsageSpend, registry: ToolRegistry = portalTools): void {
  /** Who a change is for: the owner, through this token (`via`), until tokens belong to users (docs/prd/claude-usage.md §26.4). */
  const whoOf = (ctx: PortalToolContext): Who => ({ actorId: OWNER_ACTOR, via: ctx.actor });

  /** The session an agent speaks for, and the root of what it may read; an admin's token reads everything (or a tree, with `session_id`). */
  const rootOf = (ctx: PortalToolContext, asked: string | undefined): string | undefined => {
    if (!ctx.isAgent) return asked;
    const own = ctx.sessionId;
    if (!own) throw new AppError('FORBIDDEN', 'This token is not bound to a session.');
    if (asked && asked !== own && !spend.descendants(own).has(asked)) throw new AppError('FORBIDDEN', 'An agent can read only its own session and the sessions it started.');
    return asked ?? own;
  };

  registry.register({
    name: 'usage_summary',
    title: 'Spend summary',
    description:
      'What was spent: today and this month (an admin’s token, for the whole portal) or the last day for the calling session and the sessions it started (an agent’s token), with the budgets in force and recent spike alerts. Dollars are estimates (a plan’s “cost” is API-equivalent, not a bill); tokens and requests are counts. Budgets and alerts are read-only here.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({}),
    handler(ctx) {
      const own = rootOf(ctx, undefined);
      if (!own) {
        const s = spend.summary();
        return {
          summary: `Today ${money(s.today.costUsd)} (estimated) in ${s.today.requests} requests; this month ${money(s.month.costUsd)}. ${s.budgets.total} budget${s.budgets.total === 1 ? '' : 's'} (${s.budgets.exhausted} used up, ${s.budgets.paused} pausing), ${s.spikes24h} spike${s.spikes24h === 1 ? '' : 's'} in the last day.`,
          scope: 'portal',
          timezone: s.timezone,
          today: totals(s.today),
          month: totals(s.month),
          budgets: s.budgets,
          spikes_24h: s.spikes24h,
          alerts: s.alerts.map((a) => ({ kind: a.kind, id: a.id, at: a.at, summary: a.summary, ...(a.kind === 'budget' ? { level: a.level, budget_id: a.budgetId, paused: a.paused } : { spike_kind: a.spikeKind, heuristic: true }) })),
          basis: BASIS,
          now: s.now,
        };
      }
      const tree = spend.attribution({ by: 'session', range: '1d', sessionId: own, limit: 1 });
      const root = tree.rows.find((r) => r.key === own);
      const link = spend.sessionScope(own);
      const budgets = link ? spend.budgetsFor(link.workspaceId, link.claudeId) : [];
      const hot = budgets.filter((b) => b.level !== 'ok');
      return {
        summary: `This session and the ones it started: ${money(tree.totals.costUsd)} (estimated) in ${tree.totals.requests} requests over the last day.${hot.length ? ` ${hot.length} budget${hot.length === 1 ? '' : 's'} near or at the limit.` : ''}`,
        scope: 'session',
        session_id: own,
        window: '1d',
        own: root ? totals(root.own) : totals(tree.totals),
        with_children: totals(tree.totals),
        budgets: budgets.map(budgetView),
        basis: BASIS,
        now: tree.now,
      };
    },
  });

  registry.register({
    name: 'usage_attribution',
    title: 'Spend by',
    description:
      'The window’s requests grouped by session (a tree: a session’s total includes the sessions it started), workspace, ticket, persona or Claude, with each row’s own and total dollars (estimates) and requests and its share; full true adds the tokens and the times. A persona is recorded when a session’s process starts, so older requests read as unknown (not_recorded), never guessed; a child session with no ticket counts under its parent’s. By ticket, a lead’s own dollars (a session with no ticket that started workers on tickets) are split over those tickets by its workers per ticket and shown as via_lead_usd (part of the row’s total, not of own), with the type and status of each ticket; done true keeps only tickets closed as done in the window. An agent’s token reads its own session and the ones it started only; an admin’s token reads everything, or a tree with session_id. Tickets show as id and key.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      by: z.enum(ATTRIBUTION_BY).optional().describe('Default session.'),
      range: z.enum(CHAT_USAGE_RANGES).optional().describe('A window ending now. Default 7d.'),
      session_id: z.string().max(100).optional().describe('Only this session and the ones below it.'),
      claude_id: z.string().max(100).optional(),
      workspace_id: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).optional().describe('Rows shown (root sessions for by session); the rest sum into others. Default 25.'),
      done: z.boolean().optional().describe('By ticket only: only tickets closed as done inside the window (cost per done ticket by type is in done_by_type).'),
      ...fullInput,
    }),
    handler(ctx, args) {
      if (args.workspace_id) ctx.assertWorkspace(args.workspace_id);
      const root = rootOf(ctx, args.session_id);
      if (ctx.isAgent && args.claude_id) {
        const link = spend.sessionScope(ctx.sessionId!);
        if (link && link.claudeId !== args.claude_id) throw new AppError('FORBIDDEN', 'An agent can read only its own Claude’s requests.');
      }
      // T-2945: by ticket, a ticket the caller may not see (another person's bucket) reads like one that does not exist: no type, status or done time.
      const actor = actorOfPrincipal(ctx.principal);
      const r = spend.attribution(
        { by: args.by, range: args.range, claudeId: args.claude_id, workspaceId: args.workspace_id, limit: args.limit, ...(args.done ? { done: true } : {}), ...(root ? { sessionId: root } : {}) },
        undefined,
        { ticketVisible: (id) => ticketKeyOf(id, actor) !== null },
      );
      return {
        summary: `${r.rows.length} rows by ${r.by} over ${r.range}: ${money(r.totals.costUsd)} (estimated) in ${r.totals.requests} requests${r.coverage.basis === 'unavailable' ? '' : `, ${r.coverage.value}% of the dollars attributed`}.`,
        by: r.by,
        range: r.range,
        from: r.from,
        to: r.to,
        totals: totals(r.totals),
        rows: r.rows.map((x) => (args.full ? rowView(ctx, x) : rowShort(ctx, x))),
        coverage_pct: figure(r.coverage),
        more: r.more,
        ...(r.leadBasis ? { via_lead_basis: r.leadBasis } : {}),
        ...(r.doneByType ? { done_by_type: r.doneByType.map((t) => ({ type: t.type, tickets: t.tickets, cost_usd: t.costUsd, per_ticket_usd: t.perTicketUsd })) } : {}),
        basis: BASIS,
        now: r.now,
      };
    },
  });

  registry.register({
    name: 'usage_budgets',
    title: 'Spend budgets',
    description:
      'The daily and monthly budgets (for everything, one Claude or one workspace) with what each has used, its level (ok, near from 80 %, high from 95 %, exhausted) and whether it pauses new messages when used up. Dollars are estimates. An admin’s token reads all; an agent’s token reads only the budgets that count its own workspace and Claude. This tool changes nothing.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({}),
    handler(ctx) {
      let states: BudgetState[];
      let timezone: string;
      if (ctx.isAgent) {
        const link = spend.sessionScope(ctx.sessionId ?? '');
        if (!link) throw new AppError('NOT_FOUND', 'This session isn’t listed.');
        states = spend.budgetsFor(link.workspaceId, link.claudeId);
        timezone = spend.timezone;
      } else {
        const r = spend.budgets();
        states = r.budgets;
        timezone = r.timezone;
      }
      const hot = states.filter((s) => s.level !== 'ok' && s.budget.enabled);
      return {
        summary: states.length ? `${states.length} budget${states.length === 1 ? '' : 's'}, ${hot.length} near or at the limit${hot.some((s) => s.paused) ? ', one or more pausing new messages' : ''}.` : 'No budgets.',
        budgets: states.map(budgetView),
        thresholds: { warn: 80, critical: 95 },
        timezone,
        basis: BASIS,
      };
    },
  });

  registry.register({
    name: 'usage_spikes',
    title: 'Spend spikes',
    description:
      'Unusual spending the portal noticed, newest first, each with its evidence and labelled heuristic: a Claude’s last 15 minutes against its usual, one session finishing many requests in 10 minutes (a loop between turns), or one request far above the median. Rules of thumb that only alert. An admin’s token reads all; an agent’s token reads only events about its own session and the ones it started.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ range: z.enum(['1d', '7d', '30d']).optional().describe('Default 7d.') }),
    handler(ctx, args) {
      const own = rootOf(ctx, undefined);
      const range = args.range ?? '7d';
      const events = own ? spend.spikesOf(own, range) : spend.spikes(range).events;
      return {
        summary: events.length ? `${events.length} spike${events.length === 1 ? '' : 's'} in ${range}; latest: ${events[0]!.summary}.` : `No spikes in ${range}.`,
        range,
        events: events.map((e) => spikeView(ctx, e)),
        note: 'Heuristics: rules of thumb with their evidence, not proof that anything is wrong. Thresholds are in Settings under Usage.',
        basis: BASIS,
      };
    },
  });

  registry.register({
    name: 'usage_budget_set',
    title: 'Set a budget',
    description:
      'Makes a budget, or changes one with id: a daily or monthly limit in estimated dollars and/or tokens for everything, one Claude or one workspace. It alerts by default. mode pause also refuses new messages once the budget is used up (a running turn finishes); that needs the confirmation round trip. Changing a limit starts the budget’s alerts over. Says what it did. Admin tokens only.',
    scope: 'admin',
    hints: { idempotent: false },
    rate: { perHour: 60 },
    input: z.object({
      id: z.string().max(40).optional().describe('A budget to change; leave out to make a new one.'),
      name: z.string().max(60).optional(),
      scope: z.enum(['all', 'claude', 'workspace']).optional().describe('Needed for a new budget.'),
      scope_id: z.string().max(200).optional().describe('The Claude id, or the workspace id such as docker/api; not for scope all.'),
      period: z.enum(['day', 'month']).optional().describe('Needed for a new budget. Days and months follow the Usage time zone setting.'),
      limit_usd: z.number().nullable().optional().describe('Estimated dollars; null clears it.'),
      limit_tokens: z.number().nullable().optional().describe('Input + output + cache-write tokens; null clears it.'),
      mode: z.enum(['alert', 'pause']).optional(),
      enabled: z.boolean().optional(),
      confirm_token: z.string().optional(),
    }),
    async handler(ctx, args) {
      const raw: Record<string, unknown> = {};
      if (args.name !== undefined) raw.name = args.name;
      if (args.scope !== undefined) raw.scope = { kind: args.scope, id: args.scope_id ?? null };
      else if (args.scope_id !== undefined) throw new AppError('VALIDATION_FAILED', 'Give scope with scope_id.', { details: { scope: 'Give scope with scope_id.' } });
      if (args.period !== undefined) raw.period = args.period;
      if (args.limit_usd !== undefined) raw.limitUsd = args.limit_usd;
      if (args.limit_tokens !== undefined) raw.limitTokens = args.limit_tokens;
      if (args.mode !== undefined) raw.mode = args.mode;
      if (args.enabled !== undefined) raw.enabled = args.enabled;
      const before = args.id ? spend.budget(args.id) : null;
      if (args.mode === 'pause' && before?.budget.mode !== 'pause') {
        const gate = ctx.confirm(args, { change: before ? `${describe(before)} → pause new messages when used up` : 'a new budget that pauses new messages when it is used up', effect: 'Once the budget is used up its scope’s new messages are refused until the period ends or the budget is raised or set to alerts only. A running turn finishes.' }, before ? before.budget.id + '@' + before.budget.updatedAt : 'new');
        if (gate) return gate;
      }
      let state: BudgetState;
      try {
        state = before ? await spend.updateBudget(before.budget.id, raw, whoOf(ctx)) : await spend.createBudget(raw, whoOf(ctx));
      } catch (e) {
        if (e instanceof AppError && e.code === 'VALIDATION_FAILED') throw new PortalToolError('VALIDATION_FAILED', e.message, e.details);
        throw e;
      }
      ctx.affected(`budget:${state.budget.id}`);
      return {
        summary: `${before ? 'Changed' : 'Made'} ${describe(state)}. ${state.usedPct.value}% used so far (${state.level}).`,
        budget: budgetView(state),
        did: before ? 'updated' : 'created',
        basis: BASIS,
      };
    },
  });

  registry.register({
    name: 'usage_budget_delete',
    title: 'Remove a budget',
    description: 'Removes a budget. Its alerts and any pause it was causing end at once. Asks for the confirmation round trip first. Says what it did. Admin tokens only.',
    scope: 'admin',
    hints: { destructive: true, idempotent: true },
    rate: { perHour: 60 },
    input: z.object({ id: z.string().max(40), confirm_token: z.string().optional() }),
    handler(ctx, args) {
      const state = spend.budget(args.id);
      const gate = ctx.confirm(args, { remove: describe(state), pausing_now: state.paused }, `${state.budget.id}@${state.budget.updatedAt}`);
      if (gate) return gate;
      spend.deleteBudget(args.id, whoOf(ctx));
      ctx.affected(`budget:${args.id}`);
      return { summary: `Removed ${describe(state)}.`, removed: true, id: args.id };
    },
  });
}
