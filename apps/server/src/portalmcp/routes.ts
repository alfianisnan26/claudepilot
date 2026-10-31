// Portal MCP: the `/mcp` endpoint and the admin's routes that manage it (`/api/portal-mcp`). The endpoint
// takes bearer tokens, never the session cookie. The admin routes carry no auth middleware of their own:
// app.ts mounts them under a guarded group, as it does every other /api route.

import type { IncomingMessage } from 'node:http';
import { AppError, success } from '@isnanme/core';
import type {
  CreatePortalTokenRequest,
  PortalAgentWorkspace,
  PortalAuditOutcome,
  RevokePortalTokenLabelRequest,
  SetAgentAccessRequest,
  UpdatePortalMcpSettingsRequest,
  UpdatePortalTokenRequest,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf, actorString, actorUserId, requireCan } from '../authz/seam.js';
import { config } from '../config.js';
import { declarePortalMcpPolicies, tokenRef } from './authz.js';
import type { PortalMcpModule } from './module.js';

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

/** The caller's address: the socket's, or the last `X-Forwarded-For` entry behind a proxy the operator trusts. */
export function clientIp(c: Context): string {
  const forwarded = config.trustProxy ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
  return forwarded || ((c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket.remoteAddress ?? 'unknown');
}

/** The `/mcp` URL as this request reached the portal, for the snippets Access → MCP shows. */
export function mcpUrl(c: Context): string {
  if (config.portalMcp.url) return config.portalMcp.url;
  const url = new URL(c.req.url);
  const proto = (config.trustProxy ? c.req.header('x-forwarded-proto') : undefined) ?? url.protocol.replace(':', '');
  return `${proto}://${c.req.header('host') ?? url.host}/mcp`;
}

/** `/mcp`: not behind the session guard and not under /api (whose CSRF check rejects form posts). Mount before the SPA fallback. */
export function createPortalMcpEndpoint(module: PortalMcpModule): Hono {
  const app = new Hono();
  app.all('/mcp', (c) => module.mcp.handle(c.req.raw, { ip: clientIp(c) }));
  return app;
}

const OUTCOMES: PortalAuditOutcome[] = ['ok', 'error', 'denied', 'rate_limited', 'confirmation_required', 'rejected'];

export interface PortalMcpRoutesDeps {
  /** Every workspace, for the agent access switches. */
  workspaces: () => Promise<{ id: string; name: string }[]>;
}

/** `/api/portal-mcp`: switches, access tokens, audit, agent access. Mount under a guarded group. */
export function createPortalMcpRoutes(module: PortalMcpModule, deps?: PortalMcpRoutesDeps): Hono {
  declarePortalMcpPolicies();
  const app = new Hono();

  app.get('/', (c) => c.json(success(module.state(mcpUrl(c)))));

  app.put('/settings', async (c) => {
    const req = await body<UpdatePortalMcpSettingsRequest>(c);
    const before = module.settings.get();
    const settings = module.settings.update(req);
    if (before.enabled !== settings.enabled) module.audit.event(settings.enabled ? 'enabled' : 'disabled', null);
    if (before.sessionControl !== settings.sessionControl) module.audit.event(settings.sessionControl ? 'session_control_on' : 'session_control_off', null);
    return c.json(success(settings));
  });

  // Minting and revoking need `manage` on the person's tokens: a read or operate token is below it, an agent's token is refused (authz.ts).
  app.post('/tokens', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'manage', tokenRef());
    const req = await body<CreatePortalTokenRequest>(c);
    // Organizations slice 0 (P2): bound to the person asking (a token's person when an admin token asks), never to the founding user by default.
    return c.json(success(module.createToken(req, mcpUrl(c), actorString(actor), undefined, actorUserId(actor) ?? undefined)), 201);
  });

  // "Revoke older" and "Revoke all of this label" on the tokens page: one audit row per token, with who.
  app.post('/tokens/revoke-label', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'manage', tokenRef());
    const req = await body<RevokePortalTokenLabelRequest>(c);
    if (typeof req.label !== 'string' || !req.label.trim()) throw new AppError('VALIDATION_FAILED', 'Name the label.', { details: { label: 'Required.' } });
    if (req.keepNewest !== undefined && typeof req.keepNewest !== 'boolean') throw new AppError('VALIDATION_FAILED', '`keepNewest` must be true or false.', { details: { keepNewest: 'Use true or false.' } });
    return c.json(success({ revoked: module.revokeLabel(req.label.trim(), req.keepNewest === true, actorString(actor)) }));
  });

  // T-1105: a token's default workspace for the tickets it makes. A person's manage on the token, and operate on the workspace (module.ts
  // checks that, that the token may operate it and that it exists). Never a tool: an agent can't send a token's tickets elsewhere.
  app.patch('/tokens/:id', async (c) => {
    const actor = actorOf(c);
    const id = c.req.param('id');
    requireCan(actor, 'manage', tokenRef(id));
    if (!module.tokens.get(id)) throw new AppError('NOT_FOUND', 'No such token.');
    const req = await body<UpdatePortalTokenRequest>(c);
    if (!('defaultWorkspaceId' in req) || (req.defaultWorkspaceId !== null && typeof req.defaultWorkspaceId !== 'string'))
      throw new AppError('VALIDATION_FAILED', 'Give defaultWorkspaceId: a workspace or null.', { details: { defaultWorkspaceId: 'A workspace or null.' } });
    const known = deps && req.defaultWorkspaceId ? (await deps.workspaces()).map((w) => w.id) : undefined;
    return c.json(success(module.setTokenDefaultWorkspace(id, req.defaultWorkspaceId, actor, known, actorString(actor))));
  });

  app.delete('/tokens/:id', (c) => {
    const actor = actorOf(c);
    const id = c.req.param('id');
    requireCan(actor, 'manage', tokenRef(id));
    if (!module.tokens.get(id)) throw new AppError('NOT_FOUND', 'No such token.');
    module.revokeToken(id, undefined, actorString(actor));
    return c.json(success({ ok: true }));
  });

  // Every token, at once. Unlike the `mcp_lockdown` tool, this leaves MCP switched on: the admin can make new ones.
  app.post('/revoke-all', (c) => c.json(success(module.lockdown('revoked all in the portal'))));

  // "Agent access to portal tools" (interface I8): per workspace, off by default.
  app.get('/agents', async (c) => {
    const live = module.agents.liveCounts();
    const on = new Set(module.agents.enabledWorkspaces());
    const list = deps ? await deps.workspaces() : [];
    const known = new Set(list.map((w) => w.id));
    const rows: PortalAgentWorkspace[] = [
      ...list.map((w) => ({ workspaceId: w.id, name: w.name, enabled: on.has(w.id), liveTokens: live.get(w.id) ?? 0 })),
      // A workspace that is switched on but gone (or its target is down) stays listed, so it can be switched off.
      ...[...on].filter((id) => !known.has(id)).map((id) => ({ workspaceId: id, name: id.slice(id.indexOf('/') + 1), enabled: true, liveTokens: live.get(id) ?? 0 })),
    ];
    return c.json(success(rows));
  });

  app.put('/agents/:target/:name', async (c) => {
    const { enabled } = await body<SetAgentAccessRequest>(c);
    if (typeof enabled !== 'boolean') throw new AppError('VALIDATION_FAILED', '`enabled` must be true or false.');
    const id = `${c.req.param('target')}/${c.req.param('name')}`;
    const { revoked } = module.agents.setEnabled(id, enabled);
    module.audit.event(enabled ? 'agent_access_on' : 'agent_access_off', null, { workspace: id, revoked });
    return c.json(success({ workspaceId: id, enabled, revoked }));
  });

  app.get('/audit', (c) => {
    const outcome = c.req.query('outcome');
    if (outcome && !OUTCOMES.includes(outcome as PortalAuditOutcome)) throw new AppError('VALIDATION_FAILED', 'Unknown outcome.');
    const before = Number(c.req.query('before'));
    const limit = Number(c.req.query('limit'));
    return c.json(
      success(
        module.audit.list({
          tool: c.req.query('tool') || undefined,
          outcome: (outcome || undefined) as PortalAuditOutcome | undefined,
          tokenId: c.req.query('tokenId') || undefined,
          before: Number.isFinite(before) && before > 0 ? before : undefined,
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        }),
      ),
    );
  });

  return app;
}
