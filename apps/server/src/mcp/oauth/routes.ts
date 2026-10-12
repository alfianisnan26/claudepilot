// OAuth for MCP servers (MCP set PRD §13.3): each OAuth server's sign-in state and the guided sign-in, under
// `/api/mcp/workspaces/:target/:name/…`. `?claude=<id>` picks one of the workspace's Claudes (each has its own sign-in).
// No auth middleware here: app.ts mounts these under a guarded group. The redirect address a person pastes
// carries a one-time code, so it is only ever read from a JSON body, never from a path or query.

import { AppError, success } from '@isnanme/core';
import type { McpSignInComplete, McpSignInRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { OWNER_ACTOR, type McpOAuth } from './service.js';

const optionalBody = async <T>(c: Context): Promise<Partial<T>> => {
  const value: unknown = await c.req.json().catch(() => null);
  return value && typeof value === 'object' ? (value as Partial<T>) : {};
};

export function createOAuthRoutes(oauth: McpOAuth): Hono {
  const app = new Hono();
  const workspaceId = (c: Context) => `${c.req.param('target')}/${c.req.param('name')}`;
  const dir = (c: Context) => oauth.dirOf(workspaceId(c), c.req.query('claude'));
  // Multi-user (PLAN-10): the caller's actor is read here and nowhere else; until sessions carry a user it is the one owner.
  const actor = (_c: Context) => OWNER_ACTOR;
  const signInId = (c: Context) => {
    const id = c.req.param('signInId') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('NOT_FOUND', 'That sign-in has ended. Start it again.');
    return id;
  };

  app.get('/workspaces/:target/:name/auth', (c) => c.json(success(oauth.list(workspaceId(c), dir(c)))));
  app.post('/workspaces/:target/:name/auth', async (c) => {
    const only = await optionalBody<McpSignInRequest>(c);
    return c.json(success(await oauth.check(workspaceId(c), dir(c), only)));
  });
  app.post('/workspaces/:target/:name/signin', async (c) => c.json(success(await oauth.signIn(workspaceId(c), dir(c), await optionalBody<McpSignInRequest>(c), actor(c)))));
  app.post('/workspaces/:target/:name/signin/:signInId/complete', async (c) => {
    const { redirectUrl } = await optionalBody<McpSignInComplete>(c);
    return c.json(success(await oauth.complete(workspaceId(c), signInId(c), redirectUrl, actor(c))));
  });
  app.delete('/workspaces/:target/:name/signin/:signInId', async (c) => {
    await oauth.cancel(workspaceId(c), signInId(c), actor(c));
    return c.json(success({ ok: true }));
  });
  app.post('/workspaces/:target/:name/signout', async (c) => c.json(success(await oauth.signOut(workspaceId(c), dir(c), await optionalBody<McpSignInRequest>(c), actor(c)))));
  return app;
}
