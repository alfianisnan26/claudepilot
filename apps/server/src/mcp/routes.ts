// MCP set pool: the catalog (`/api/mcp/catalog…`), "Try in set", and each workspace's MCP status,
// retries and FR19 matchers (`/api/mcp/workspaces/:target/:name…`). Sets themselves use the generic
// pool routes (`/api/pools/mcpset…`). No auth middleware here: app.ts mounts these under a guarded group.

import { AppError, success } from '@isnanme/core';
import type { McpApproveRequest, McpEntryRequest, McpEntryUpdate, McpRevokeRequest, McpTryRequest, McpVersionRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import type { McpSets } from './index.js';

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

const optionalBody = async <T>(c: Context): Promise<Partial<T>> => {
  const value: unknown = await c.req.json().catch(() => null);
  return value && typeof value === 'object' ? (value as Partial<T>) : {};
};

export function createMcpRoutes(mcp: McpSets): Hono {
  const app = new Hono();
  const { catalog } = mcp;
  const id = (c: Context) => c.req.param('id') ?? '';
  const vid = (c: Context) => c.req.param('vid') ?? '';
  const workspaceId = (c: Context) => `${c.req.param('target')}/${c.req.param('name')}`;

  app.get('/catalog', (c) => c.json(success(catalog.list())));
  app.post('/catalog', async (c) => c.json(success(await catalog.create(await body<McpEntryRequest>(c))), 201));
  app.get('/catalog/:id', (c) => c.json(success(catalog.get(id(c)))));
  app.patch('/catalog/:id', async (c) => c.json(success(catalog.update(id(c), await body<McpEntryUpdate>(c)))));
  app.delete('/catalog/:id', (c) => {
    catalog.remove(id(c));
    return c.json(success({ ok: true }));
  });
  app.post('/catalog/:id/versions', async (c) => c.json(success(await catalog.addVersion(id(c), await body<McpVersionRequest>(c))), 201));
  app.put('/catalog/:id/versions/:vid', async (c) => c.json(success(await catalog.updateVersion(id(c), vid(c), await body<McpVersionRequest>(c)))));
  app.delete('/catalog/:id/versions/:vid', (c) => {
    catalog.removeVersion(id(c), vid(c));
    return c.json(success({ ok: true }));
  });
  app.post('/catalog/:id/versions/:vid/approve', async (c) => c.json(success(catalog.approve(id(c), vid(c), await body<McpApproveRequest>(c)))));
  app.post('/catalog/:id/versions/:vid/deprecate', (c) => c.json(success(catalog.deprecate(id(c), vid(c)))));
  app.post('/catalog/:id/versions/:vid/revoke', async (c) => {
    const { reason } = await optionalBody<McpRevokeRequest>(c);
    return c.json(success(mcp.revoke(id(c), vid(c), reason)));
  });

  app.post('/sets/:poolId/try', async (c) => {
    const req = await body<McpTryRequest>(c);
    return c.json(success(mcp.tryInSet(c.req.param('poolId') ?? '', req.entry, req.version)));
  });

  app.get('/workspaces/:target/:name', (c) => c.json(success(mcp.status(workspaceId(c)))));
  app.get('/workspaces/:target/:name/matchers', (c) => c.json(success(mcp.matchers(workspaceId(c)))));
  app.post('/workspaces/:target/:name/installs/retry', (c) => {
    mcp.retry(workspaceId(c), 'installs');
    return c.json(success({ ok: true }));
  });
  app.post('/workspaces/:target/:name/verify', (c) => {
    mcp.retry(workspaceId(c), 'verify');
    return c.json(success({ ok: true }));
  });
  return app;
}
