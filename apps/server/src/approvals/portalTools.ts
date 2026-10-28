// Approvals on the Portal MCP (docs/prd/approvals.md): an agent ASKS (`approval_request`) and reads what IT asked (`approval_list`,
// `approval_get`). Allow and deny are never tools: a person decides on the card in the portal. The asking session is the one verified
// from the token, never an argument; another session's request is the same NOT_FOUND as a missing one.

import { APPROVAL_KINDS, APPROVAL_REASON_MAX, APPROVAL_TTL_MAX_MIN, approvalPath, type Approval } from '@portal/contracts';
import { AppError } from '@isnanme/core';
import { actorOfPrincipal } from '../authz/seam.js';
import { portalTools, PortalToolError, z, type PortalToolContext, type ToolRegistry } from '../portalmcp/registry.js';
import { declareApprovalPolicies, NO_APPROVAL } from './authz.js';
import type { ApprovalRequester } from './kinds.js';
import type { Approvals } from './service.js';

/** The verified asking session, or a refusal: only an agent's per-session token asks (a person decides in the portal). */
function sessionOf(ctx: PortalToolContext): ApprovalRequester {
  if (!ctx.isAgent || !ctx.sessionId) throw new PortalToolError('FORBIDDEN', 'Only an agent session asks for an approval; a person decides in the portal.');
  return { sessionId: ctx.sessionId, workspaceId: ctx.workspaceId, actor: actorOfPrincipal(ctx.principal) };
}

export function registerApprovalTools(approvals: Approvals, registry: ToolRegistry = portalTools): void {
  declareApprovalPolicies();

  const view = (ctx: PortalToolContext, a: Approval) => ({
    id: a.id,
    kind: a.kind,
    status: a.status,
    tier: a.tier,
    payload: a.payload,
    reason: ctx.untrusted(a.reason, 'approval', APPROVAL_REASON_MAX),
    created_at: a.createdAt,
    expires_at: a.expiresAt,
    decided_at: a.decidedAt,
    result: a.result ? { ok: a.result.ok, message: ctx.untrusted(a.result.message, 'approval', 500), output: a.result.output ?? null } : null,
    page: approvalPath(a.id),
  });

  registry.register({
    name: 'approval_request',
    title: 'Ask a person to allow an action',
    description:
      'Asks a person to allow one action the portal then runs for you, exactly as you give it (the payload is never edited). Kinds: test.echo {text}; session.bypass {sessionId: your own session}, which puts your session in Bypass if it was started bypass-capable; pool.secret_set {pool: the pool id, name, expose (optional), baseRevision: the revision you read}, when pool_secret_set refuses a protected pool: the person types the VALUE on Allow, so it is never in the payload or anything you see. ' +
      'The request shows on the person\'s Needs you card with your reason; you get a message in this session when it is allowed (with the result) or denied (with the reason). It expires after ttl_minutes (default a day). Never put a secret value in the payload: name it. You can not allow or deny anything.',
    scope: 'agent',
    hints: { readOnly: false, idempotent: false },
    rate: { perMinute: 5, perHour: 30 },
    maxArgsBytes: 6_000,
    input: z.object({
      kind: z.enum(APPROVAL_KINDS),
      payload: z.record(z.string(), z.unknown()),
      reason: z.string().trim().min(1).max(APPROVAL_REASON_MAX).describe('Why you need it, in one or two sentences, for the person.'),
      ttl_minutes: z.number().int().min(1).max(APPROVAL_TTL_MAX_MIN).optional(),
    }),
    handler(ctx, args) {
      const requester = sessionOf(ctx);
      const a = approvals.create({ kind: args.kind, payload: args.payload, reason: args.reason, ...(args.ttl_minutes ? { ttlMinutes: args.ttl_minutes } : {}) }, requester);
      ctx.affected(`approval:${a.id}`);
      return { summary: `Asked: ${a.id} (${a.kind}) waits for a person until ${a.expiresAt}.`, approval: view(ctx, a) };
    },
  });

  registry.register({
    name: 'approval_list',
    title: 'Your approval requests',
    description: 'The approval requests this session asked, newest first, with their status (pending, allowed, denied, expired) and the result or the reason. Only your own.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    handler(ctx, args) {
      if (!ctx.isAgent || !ctx.sessionId) return { summary: 'No requests: only an agent session asks.', items: [] };
      const items = approvals.listOwn(ctx.sessionId, args.limit ?? 20);
      return { summary: items.length ? `${items.length} request(s).` : 'No requests.', items: items.map((a) => view(ctx, a)) };
    },
  });

  registry.register({
    name: 'approval_get',
    title: 'One of your approval requests',
    description: 'One approval request this session asked, whole: its payload, status, and the result or the reason. Another session\'s request is not found.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ id: z.string().trim().min(1).max(80) }),
    handler(ctx, args) {
      if (!ctx.isAgent || !ctx.sessionId) throw new AppError('NOT_FOUND', NO_APPROVAL);
      const a = approvals.ownOne(ctx.sessionId, args.id);
      return { summary: `${a.id}: ${a.status}`, approval: view(ctx, a) };
    },
  });
}
