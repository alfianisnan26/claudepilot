// Claude usage over the Portal MCP (docs/prd/claude-usage.md FR20, §20.10): `claude_usage` reads each plan window and, since round 4, how fast it
// fills and where it is heading; `claude_usage_summary`, `claude_usage_report` and `claude_move_advice` are admin-token reads of what requests spent,
// what changed since the previous period and which Claude a chat could move to. An admin's token reads every Claude or one; an agent's per-session
// token (interface I8) reads only the Claude its own session runs in, and only plan usage (no spend, nothing about other Claudes). Every derived
// figure carries how it is known (`measured`, `estimate`, or `unavailable` with a reason). Nothing here carries a login, an email, an
// organization or an account id.

import { AppError } from '@isnanme/core';
import { CHAT_USAGE_RANGES, headroomFrom, reasonText, type ClaudeUsage, type Figure, type LimitOutlook, type WindowPace } from '@portal/contracts';
import { portalTools, z, type PortalToolContext, type ToolRegistry } from '../portalmcp/registry.js';
import { OWNER_ACTOR } from './actor.js';
import type { ClaudeUsageMonitor } from './service.js';

/** The windows Claude Code names itself come from a third party: only the ones the portal labels are plain text. */
const FIXED_LABELS = new Set(['session', 'week', 'week_opus', 'week_sonnet', 'week_apps', 'week_models']);

/** A figure as a tool returns it: the value, how it is known, and when it is not, the reason in a code and in words. */
function fig(f: Figure<unknown>) {
  return f.basis === 'unavailable' ? { value: null, basis: f.basis, reason: f.reason, why: reasonText(f.reason) } : { value: f.value, basis: f.basis };
}

const isFigure = (v: unknown): v is Figure<unknown> => !!v && typeof v === 'object' && 'basis' in v && 'value' in v && ((v as { basis: unknown }).basis === 'measured' || (v as { basis: unknown }).basis === 'estimate' || (v as { basis: unknown }).basis === 'unavailable');
/** snake_case, with the names a model reads best for the estimate's fields (the same as `paceView` and `outlookView` use). */
const RENAME: Record<string, string> = { etaAt: 'runs_out_at', projectedPct: 'projected_pct_at_reset', evenPct: 'even_pace_pct', aheadPts: 'ahead_of_even_pace_pts' };
const snake = (k: string) => RENAME[k] ?? k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

/** A report as a tool returns it: keys in snake_case like the rest of the tools, every figure as `fig` says. */
function view(v: unknown): unknown {
  if (isFigure(v)) return fig(v);
  if (Array.isArray(v)) return v.map(view);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), view(x)]));
  return v;
}

const paceView = (p: WindowPace | undefined) =>
  p
    ? { speed_pct_per_hour: fig(p.speed), projected_pct_at_reset: fig(p.projectedPct), runs_out_at: fig(p.etaAt), status: fig(p.status), even_pace_pct: fig(p.evenPct), ahead_of_even_pace_pts: fig(p.aheadPts), readings: p.readings, span_min: p.spanMin, method: p.method, low_confidence: p.lowConfidence }
    : null;

const outlookView = (o: LimitOutlook) => ({ status: fig(o.status), window: o.window && { key: o.window.key, label: o.window.label, used_pct: o.window.usedPct, resets_at: o.window.resetsAt }, runs_out_at: fig(o.etaAt), projected_pct_at_reset: fig(o.projectedPct) });

function claudeView(ctx: PortalToolContext, c: ClaudeUsage) {
  return {
    claude_id: c.claudeId,
    claude: c.claudeName,
    workspace_id: c.workspaceId,
    runs_on: c.runsOn,
    state: c.state,
    plan: c.plan,
    windows: c.windows.map((w) => ({
      key: w.key,
      label: FIXED_LABELS.has(w.key) ? w.label : ctx.untrusted(w.label, 'claude-usage', 60),
      used_pct: w.usedPct,
      left_pct: w.usedPct === null ? null : Math.max(0, Math.round((100 - w.usedPct) * 10) / 10),
      resets_at: w.resetsAt,
      level: w.level,
      pace: paceView(w.pace),
    })),
    outlook: outlookView(c.outlook),
    extra_usage: c.extra ? { enabled: c.extra.enabled, used_pct: c.extra.usedPct } : null,
    checked_at: c.checkedAt,
    source: c.source,
    stale: c.stale,
    workspace_running: c.workspaceRunning,
    problem: c.problem,
  };
}

/** One line a model can use: the fullest window, or why there is none. */
function lineOf(c: ClaudeUsage): string {
  const h = headroomFrom({ claudeId: c.claudeId, runsOn: c.runsOn, windows: c.windows, checkedAt: c.checkedAt, stale: c.stale });
  if (h.kind === 'no_limits') return `${c.claudeName}: no plan limits.`;
  if (h.kind === 'signed_out') return `${c.claudeName}: not signed in.`;
  if (h.kind !== 'plan' || !h.limiting) return `${c.claudeName}: usage not known.`;
  if (h.exhausted) return `${c.claudeName}: out of usage${h.availableAt ? ` until ${h.availableAt}` : ''}.`;
  const runsOut = c.outlook.status.value === 'over' && c.outlook.etaAt.value ? ` At this pace (an estimate) ${c.outlook.window?.label.toLowerCase() ?? 'it'} runs out about ${c.outlook.etaAt.value}, before it resets.` : '';
  return `${c.claudeName}: ${h.limiting.label.toLowerCase()} ${Math.round(h.limiting.usedPct)} % used${h.limiting.resetsAt ? `, resets ${h.limiting.resetsAt}` : ''}.${runsOut}`;
}

export function registerClaudeUsageTools(usage: ClaudeUsageMonitor, registry: ToolRegistry = portalTools): void {
  registry.register({
    name: 'claude_usage',
    title: 'Claude plan usage',
    description:
      'How much of each plan limit a Claude has used (the 5-hour session, the week, the weeks of single models), when each resets, and whether it is near or out of usage. Each window also has its pace: percentage points per hour from the readings of this period, where it will stand at the reset and when it reaches 100 % at that speed (estimates; a figure with no basis to stand on says why), and the Claude has an outlook (will a limit run out before it resets). Read from Claude Code itself every few minutes, so check checked_at. A Claude on a pool or an API key has no plan limits. An agent reads its own Claude only; an admin token reads every Claude, or one with claude_id.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ claude_id: z.string().max(80).optional().describe('Admin tokens only: one Claude (as listed). Default: every Claude.') }),
    async handler(ctx, args) {
      const report = await usage.report();
      let claudes = report.claudes;
      if (ctx.isAgent) {
        const own = ctx.sessionId ? usage.claudeOfSession(ctx.sessionId) : null;
        if (args.claude_id && args.claude_id !== own) throw new AppError('FORBIDDEN', 'An agent can read only its own Claude’s usage.');
        claudes = claudes.filter((c) => c.claudeId === own);
        if (!claudes.length) throw new AppError('NOT_FOUND', 'This session’s Claude isn’t listed.');
      } else if (args.claude_id) {
        claudes = claudes.filter((c) => c.claudeId === args.claude_id);
        if (!claudes.length) throw new AppError('NOT_FOUND', 'No such Claude.');
      }
      return {
        summary: claudes.length === 1 ? lineOf(claudes[0]!) : `${claudes.length} Claudes: ${claudes.filter((c) => c.state === 'exhausted').length} out of usage, ${claudes.filter((c) => c.state === 'near').length} near a limit.`,
        claudes: claudes.map((c) => claudeView(ctx, c)),
        thresholds: report.thresholds,
        now: report.now,
      };
    },
  });

  registry.register({
    name: 'claude_usage_summary',
    title: 'Claude usage summary',
    description:
      'What requests spent today (dollars are Claude Code’s API-price estimate, not a bill), how fast (tokens and dollars per minute over the last 15 minutes and since the first request today: estimates), which Claude will run out of plan usage first and when (an estimate from the percentages Claude Code reported, never from tokens), and the next reset, overall or for one Claude. Every figure says how it is known: measured, estimate, or unavailable with the reason.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      claude_id: z.string().max(120).optional().describe('One Claude (as listed). Default: every Claude.'),
      tz_offset_min: z.number().int().min(-1440).max(1440).optional().describe('The caller’s Date.getTimezoneOffset(), so "today" starts at their midnight. Default: UTC.'),
    }),
    async handler(_ctx, args) {
      const s = await usage.summary({ claudeId: args.claude_id, tzOffsetMin: args.tz_offset_min, actorId: OWNER_ACTOR });
      const money = (f: Figure<number>) => (f.value === null ? 'unknown' : `$${f.value.toFixed(2)}`);
      const limit =
        s.limit.status.value === 'over'
          ? `${s.limit.claudeName ?? 'A Claude'} runs out about ${s.limit.etaAt.value} (estimate), before its reset.`
          : s.limit.status.value === 'under'
            ? 'No plan limit is projected to run out before its reset (estimate).'
            : s.limit.status.value === 'exhausted'
              ? `${s.limit.claudeName ?? 'A Claude'} is out of plan usage.`
              : `Time until the limit is not available: ${reasonText(s.limit.status.reason)}`;
      return {
        summary: `Today ${money(s.today.costUsd)} (estimate), ${s.today.requests.value} requests. ${limit}${s.nextReset.at.value ? ` Next reset ${s.nextReset.at.value}.` : ''}`,
        ...(view(s) as Record<string, unknown>),
      };
    },
  });

  registry.register({
    name: 'claude_usage_report',
    title: 'Claude usage report',
    description:
      'Requests over a window (30m, 1h, 12h, 1d, 7d, 30d): totals, tokens by how the prompt cache served them with the hit rate, the split by Claude and by model, and the change against the previous period of the same length (unavailable with a reason when the portal’s history does not reach back that far). Dollars are Claude Code’s API-price estimate, not a bill; tokens and requests are stored counts.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      range: z.enum(CHAT_USAGE_RANGES).optional().describe('Default 1d.'),
      claude_id: z.string().max(120).optional().describe('One Claude. Default: every Claude.'),
      tz_offset_min: z.number().int().min(-1440).max(1440).optional(),
      include_buckets: z.boolean().optional().describe('Also the per-bucket totals (about 24 to 30 rows). Default false.'),
    }),
    async handler(ctx, args) {
      const r = usage.requestsReport(args.range ?? '1d', { claudeId: args.claude_id, tzOffsetMin: args.tz_offset_min, actorId: OWNER_ACTOR });
      const money = `$${r.totals.costUsd.toFixed(2)}`;
      const change = r.previous.change.costUsd;
      return {
        summary: `${r.totals.requests} requests, ${money} (estimate) over ${r.range}${change.value === null ? '' : `, ${change.value >= 0 ? '+' : ''}${change.value} % against the period before`}.`,
        range: r.range,
        from: r.from,
        to: r.to,
        bucket_ms: r.bucketMs,
        basis: view(r.basis),
        totals: view(r.totals),
        cache: view(r.cache),
        by_claude: r.byClaude.map(({ claudeId, name, workspaceId, slot: _slot, ...rest }) => ({ claude_id: claudeId, claude: name, workspace_id: workspaceId, ...(view(rest) as object) })),
        by_model: r.byModel.map(({ model, slot: _slot, ...rest }) => ({ model: ctx.untrusted(model, 'claude-usage', 80), ...(view(rest) as object) })),
        previous: { from: r.previous.from, to: r.previous.to, coverage: r.previous.coverage, totals: view(r.previous.totals), change: view(r.previous.change) },
        ...(args.include_buckets ? { buckets: r.buckets.map((b) => view(b)), previous_buckets: r.previous.buckets.map((b) => view(b)) } : {}),
      };
    },
  });

  registry.register({
    name: 'claude_move_advice',
    title: 'Where to move a chat',
    description:
      'The Claudes of a workspace a chat can move to, ranked by how much of their fullest plan window is left (an estimated pace can lower a Claude’s rank), with a reason and how it is known for each. A Claude that is signed out, out of usage, not read yet or nearly out is never recommended; one on a pool or an API key has no plan limits but bills per use. It is advice only: nothing is moved. Give workspace_id, or from_claude_id (the Claude the chat leaves) and the workspace follows.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      workspace_id: z.string().max(120).optional().describe('`<target>/<name>`. Optional when from_claude_id is given.'),
      from_claude_id: z.string().max(120).optional().describe('The Claude the chat leaves; left out of the candidates.'),
    }),
    async handler(_ctx, args) {
      if (!args.workspace_id && !args.from_claude_id) throw new AppError('VALIDATION_FAILED', 'Give workspace_id, or from_claude_id.');
      const m = args.workspace_id ? await usage.recommend(args.workspace_id, args.from_claude_id, OWNER_ACTOR) : await usage.recommendFrom(args.from_claude_id!, OWNER_ACTOR);
      const best = m.candidates.find((c) => c.recommended);
      return {
        summary: best ? `Move to ${best.name} (${best.reason.replace('_', ' ')}${best.leftPct.value !== null ? `, ${best.leftPct.value} % left` : ''}).` : `No Claude is recommended (${(m.none ?? 'none').replace(/_/g, ' ')}).`,
        ...(view(m) as Record<string, unknown>),
      };
    },
  });
}
