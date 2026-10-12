// Built-in MCP catalogue (docs/prd/mcp-builtin-catalogue.md §10): `/api/mcp/builtin…`, mounted by ../routes.ts under the portal's
// guarded `/api/mcp` group (session and Origin checks). An agent's token never reaches these: it only reads and proposes
// over the Portal MCP.

import { AppError, success } from '@isnanme/core';
import type { McpBuiltinAddRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import type { McpBuiltin } from './instantiate.js';

async function body(c: Context): Promise<Partial<McpBuiltinAddRequest>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<McpBuiltinAddRequest>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

export function createBuiltinRoutes(builtin: McpBuiltin): Hono {
  const app = new Hono();
  const id = (c: Context) => c.req.param('id') ?? '';
  app.get('/', (c) => c.json(success(builtin.list())));
  app.post('/:id/preview', async (c) => c.json(success(await builtin.preview(id(c), await body(c)))));
  app.post('/:id/add', async (c) => {
    const added = await builtin.add(id(c), await body(c));
    return c.json(success(added), added.result === 'created' ? 201 : 200);
  });
  return app;
}
