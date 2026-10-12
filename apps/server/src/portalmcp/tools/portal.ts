import type { PortalAuditOutcome } from '@portal/contracts';
import { z } from 'zod';
import { pageWindow, pageInput } from '../paging.js';
import { registerPortalTool } from '../registry.js';
import { cleanText } from '../sanitize.js';
import type { PortalToolDeps } from './deps.js';
import { uiLink, workspaceBrief } from './common.js';

const OUTCOMES = ['ok', 'error', 'denied', 'rate_limited', 'confirmation_required', 'rejected'] as const;

/** Portal-wide tools: status, the audit trail, and the lockdown (portal-mcp PRD §13.1). */
export function registerPortalTools(deps: PortalToolDeps): void {
  const { store, module, workspaces, chat, reconciler } = deps;

  registerPortalTool({
    name: 'portal_status',
    title: 'Portal status',
    description:
      'What the portal is: its targets, how many workspaces there are and in which state, chat sessions that need attention, delivery problems, whether it is locked, and who you are (the token, its scope, expiry and workspace). Start here.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({}),
    async handler(ctx) {
      const you = {
        token_id: ctx.principal.tokenId,
        label: ctx.principal.label,
        scope: ctx.scope,
        workspace: ctx.workspaceId,
        session: ctx.sessionId,
        expires_at: ctx.principal.expiresAt,
        session_control: ctx.settings.sessionControl,
      };
      if (ctx.isAgent) {
        // An agent sees who it is and how its own workspace stands, nothing about the rest.
        const own = (await workspaces.list()).find((w) => w.id === ctx.workspaceId);
        return { summary: `You are session ${ctx.sessionId} in ${ctx.workspaceId}.`, you, workspace: own ? workspaceBrief(own, ctx) : null };
      }
      const [list, targets] = await Promise.all([workspaces.list(), workspaces.targets()]);
      const byStatus: Record<string, number> = {};
      for (const w of list) byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
      const problems = list.filter((w) => {
        const d = reconciler.row(w.id)?.status;
        return d === 'failed' || d === 'drifted' || d === 'locked' || d === 'frozen';
      });
      const sessions = chat.list().filter((s) => !s.archivedAt);
      const live = sessions.filter((s) => s.state !== 'ended');
      const byState: Record<string, number> = {};
      for (const s of live) byState[s.state] = (byState[s.state] ?? 0) + 1;
      const needsInput = live.filter((s) => s.state === 'waiting').length;
      const trust = store.trust;
      return {
        summary: `${list.length} workspaces (${byStatus.running ?? 0} running), ${live.length} live sessions${needsInput ? `, ${needsInput} need input` : ''}${problems.length ? `, ${problems.length} with delivery problems` : ''}; portal ${trust.state === 'ok' ? 'ok' : trust.state}.`,
        portal: {
          schema_version: store.schemaVersion,
          trust: { state: trust.state, reasons: trust.reasons.map((r) => ({ code: r.code, message: cleanText(r.message, 300) })) },
          ui: uiLink('/admin'),
        },
        targets: targets.map((t) => ({ id: t.id, label: t.label, kind: t.kind, available: t.available, problem: ctx.untrusted(t.problem ?? null, 'runtime') })),
        workspaces: { total: list.length, by_status: byStatus, with_delivery_problems: problems.map((w) => w.id) },
        sessions: { live: live.length, by_state: byState, needing_input: needsInput },
        you,
      };
    },
  });

  registerPortalTool({
    name: 'audit_search',
    title: 'Search the MCP audit trail',
    description: 'Calls made through this MCP endpoint, newest first: which token, which tool, what came of it. Arguments are redacted and addresses are left out.',
    scope: 'read',
    input: z.object({
      tool: z.string().max(60).optional().describe('Only calls of this tool.'),
      token_id: z.string().max(40).optional().describe('Only calls by this token (ptk_…).'),
      outcome: z.enum(OUTCOMES).optional(),
      protocol: z.boolean().optional().describe('Also list the protocol’s own requests (handshakes, tool listings). Default: tool calls and failures only.'),
      ...pageInput,
    }),
    handler(ctx, args) {
      const filter = { tool: args.tool, tokenId: args.token_id, outcome: args.outcome as PortalAuditOutcome | undefined, callsOnly: !args.protocol };
      const { limit, offset, next } = pageWindow(args, filter);
      const total = module.audit.count(filter);
      const rows = module.audit.list({ ...filter, limit, offset });
      return {
        summary: `${total} audit rows match${rows.length < total ? `; showing ${rows.length}` : ''}.`,
        calls: rows.map((r) => ({
          id: r.id,
          at: r.at,
          token: r.tokenLabel ? `${r.tokenLabel} (${r.tokenId})` : r.tokenId,
          client: ctx.untrusted(r.client, 'client'),
          method: r.method,
          tool: r.tool,
          args: ctx.untrusted(r.args, 'client'),
          outcome: r.outcome,
          error_code: r.errorCode,
          duration_ms: r.durationMs,
          affected: r.affected,
        })),
        total,
        next_cursor: next(rows.length, total),
      };
    },
  });

  registerPortalTool({
    name: 'mcp_lockdown',
    title: 'Revoke every token and turn MCP off',
    description:
      'Emergency stop: revokes every access token, this one included, and turns the MCP endpoint off. Only a person in the portal can turn it back on. Asks for confirmation first.',
    scope: 'operate',
    hints: { destructive: true, idempotent: true },
    input: z.object({ confirm_token: z.string().optional().describe('From the confirmation_required answer.') }),
    handler(ctx, args) {
      const live = module.tokens.list().filter((t) => !t.revokedAt && Date.parse(t.expiresAt) > Date.now());
      const agents = module.agents.liveTotal();
      const gate = ctx.confirm(
        args,
        {
          will_revoke: live.map((t) => ({ id: t.id, label: t.label, scope: t.scope, is_this_token: t.id === ctx.principal.tokenId })),
          agent_tokens: agents,
          then: 'MCP is turned off for everyone, including this connection. Only the portal’s UI turns it back on.',
        },
        `tokens:${live.length}:${agents}`,
      );
      if (gate) return gate;
      const result = module.lockdown(`mcp_lockdown by ${ctx.actor}`, { turnOff: true });
      ctx.affected(...live.map((t) => `token:${t.id}`));
      return { summary: `Revoked ${result.revoked} tokens; MCP is off.`, revoked: result.revoked, mcp_enabled: result.enabled };
    },
  });
}
