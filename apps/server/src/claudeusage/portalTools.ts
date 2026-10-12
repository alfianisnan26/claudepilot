// Claude usage over the Portal MCP (docs/prd/claude-usage.md FR20): one read tool, `claude_usage`. An admin's token reads every
// Claude or one; an agent's per-session token (interface I8) reads only the Claude its own session runs in. Nothing here carries a
// login, an email, an organization or an account id: percent used and left per window, reset times, the state and the plan tier.

import { AppError } from '@isnanme/core';
import { headroomFrom, type ClaudeUsage } from '@portal/contracts';
import { portalTools, z, type PortalToolContext, type ToolRegistry } from '../portalmcp/registry.js';
import type { ClaudeUsageMonitor } from './service.js';

/** The windows Claude Code names itself come from a third party: only the ones the portal labels are plain text. */
const FIXED_LABELS = new Set(['session', 'week', 'week_opus', 'week_sonnet', 'week_apps', 'week_models']);

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
    })),
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
  return `${c.claudeName}: ${h.limiting.label.toLowerCase()} ${Math.round(h.limiting.usedPct)} % used${h.limiting.resetsAt ? `, resets ${h.limiting.resetsAt}` : ''}.`;
}

export function registerClaudeUsageTools(usage: ClaudeUsageMonitor, registry: ToolRegistry = portalTools): void {
  registry.register({
    name: 'claude_usage',
    title: 'Claude plan usage',
    description:
      'How much of each plan limit a Claude has used (the 5-hour session, the week, the weeks of single models), when each resets, and whether it is near or out of usage. Read from Claude Code itself every few minutes, so check checked_at. A Claude on a pool or an API key has no plan limits. An agent reads its own Claude only; an admin token reads every Claude, or one with claude_id.',
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
}
