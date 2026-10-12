import type { ChatUsageRange } from '@portal/contracts';
import { z } from 'zod';
import { registerPortalTool } from '../registry.js';
import type { PortalToolDeps } from './deps.js';
import { uiLink } from './common.js';

const WINDOWS: Record<string, ChatUsageRange> = { '1h': '1h', '24h': '1d', '7d': '7d' };

/** Usage and monitoring over MCP (portal-mcp PRD §13.1: monitor_overview) from what the portal already measures. */
export function registerMonitorTools(deps: PortalToolDeps): void {
  const { workspaces, chat, reconciler, module } = deps;

  registerPortalTool({
    name: 'monitor_overview',
    title: 'Monitoring overview',
    description:
      'A snapshot of the fleet: workspaces by status, the busiest running workspaces by CPU and memory, chat sessions by state, tokens and estimated cost over a window, delivery failures and MCP calls today.',
    scope: 'read',
    input: z.object({ window: z.enum(['1h', '24h', '7d']).optional().describe('Window for tokens and cost (default 24h).') }),
    async handler(ctx, args) {
      const range = WINDOWS[args.window ?? '24h']!;
      const [list, usage] = await Promise.all([workspaces.list(), workspaces.usage()]);
      const byStatus: Record<string, number> = {};
      for (const w of list) byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
      const names = new Map(list.map((w) => [w.id, w.name]));
      const busiest = (key: 'cpuPercent' | 'memoryBytes') =>
        usage
          .filter((u) => u[key] !== null)
          .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))
          .slice(0, 10)
          .map((u) => ({ workspace: u.id, name: names.get(u.id) ?? u.id, cpu_percent: u.cpuPercent, memory_mb: u.memoryBytes === null ? null : Math.round(u.memoryBytes / 1_048_576) }));
      const sessions = chat.list().filter((s) => !s.archivedAt && s.state !== 'ended');
      const byState: Record<string, number> = {};
      for (const s of sessions) byState[s.state] = (byState[s.state] ?? 0) + 1;
      const report = chat.usage(range);
      const failures = list
        .map((w) => ({ id: w.id, row: reconciler.row(w.id) }))
        .filter((x) => x.row && ['failed', 'drifted', 'locked', 'frozen'].includes(x.row.status))
        .map((x) => ({ workspace: x.id, status: x.row!.status, reason: ctx.untrusted(x.row!.reason, 'delivery') }));
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      return {
        summary: `${list.length} workspaces, ${sessions.length} live sessions, $${report.totals.costUsd.toFixed(2)} estimated over ${args.window ?? '24h'}.`,
        workspaces: { total: list.length, by_status: byStatus, busiest_by_cpu: busiest('cpuPercent'), busiest_by_memory: busiest('memoryBytes') },
        sessions: { live: sessions.length, by_state: byState, needing_input: byState.waiting ?? 0 },
        usage: {
          window: args.window ?? '24h',
          estimated_cost_usd: Math.round(report.totals.costUsd * 100) / 100,
          tokens: { input: report.totals.input, output: report.totals.output, cache_read: report.totals.cacheRead, cache_write: report.totals.cacheWrite },
          requests: report.totals.requests,
          by_model: report.byModel.slice(0, 5).map((m) => ({ model: m.model, cost_usd: Math.round(m.costUsd * 100) / 100, requests: m.requests })),
          source: 'turns recorded by the portal (an estimate, not a bill)',
          as_of: report.to,
        },
        delivery_failures: failures,
        mcp: { calls_today: module.audit.countSince(midnight.toISOString()), active_tokens: module.tokens.activeCount() },
        ui: uiLink('/admin/usage'),
      };
    },
  });

  registerPortalTool({
    name: 'usage_report',
    title: 'Usage over time',
    description: 'Tokens and estimated cost per Claude and per model, over a window, from the turns the portal recorded.',
    scope: 'read',
    input: z.object({ range: z.enum(['30m', '1h', '12h', '1d', '7d', '30d']).optional().describe('Default 1d.') }),
    handler(_ctx, args) {
      const r = chat.usage(args.range ?? '1d');
      return {
        summary: `$${r.totals.costUsd.toFixed(2)} estimated over ${r.range}, ${r.totals.requests} requests.`,
        range: r.range,
        from: r.from,
        to: r.to,
        totals: r.totals,
        by_claude: r.byClaude.slice(0, 20).map((c) => ({ claude: c.name, workspace: c.workspaceId, cost_usd: Math.round(c.costUsd * 100) / 100, requests: c.requests })),
        by_model: r.byModel.slice(0, 20).map((m) => ({ model: m.model, cost_usd: Math.round(m.costUsd * 100) / 100, requests: m.requests })),
        source: 'turns recorded by the portal (an estimate, not a bill)',
      };
    },
  });
}
