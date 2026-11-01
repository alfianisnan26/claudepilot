// T-723: which actor the HTTP routes hand the controller, so the audit row names who asked: `ui` for a signed-in person, the token's own
// name for anything else. The routes only pass the name on; what the controller then allows or refuses is tested where it lives.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { actorOfPrincipal, actorString, ownerActor } from '../authz/seam.js';
import type { ChatController } from './controller.js';
import { createChatRoutes } from './routes.js';

type Seen = { op: string; actor: string | undefined; acknowledged?: boolean };

function harness(who: ReturnType<typeof ownerActor>) {
  const seen: Seen[] = [];
  const controller = {
    enterBypass: async (_id: string, r: { actor?: string; acknowledged: boolean }) => (seen.push({ op: 'enter', actor: r.actor, acknowledged: r.acknowledged }), {}),
    allowBypass: async (_id: string, o: { actor?: string }) => (seen.push({ op: 'allow', actor: o.actor }), {}),
    models: async (_id: string, o: { actor?: string }) => (seen.push({ op: 'models', actor: o.actor }), []),
    restart: async (_id: string, o: { actor?: string }) => (seen.push({ op: 'restart', actor: o.actor }), {}),
  } as unknown as ChatController;
  const app = new Hono<{ Variables: { actor: ReturnType<typeof ownerActor> } }>();
  app.use('*', async (c, next) => {
    c.set('actor', who);
    await next();
  });
  app.route('/', createChatRoutes(controller) as never);
  const post = (path: string, body: unknown = {}) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { seen, app, post };
}

const tokenActor = () => actorOfPrincipal({ kind: 'user', userId: 'u_owner', tokenId: 'tk_route', scope: 'admin', workspaceId: null, sessionId: null });

test('T-723: the bypass, bypass/allow, models and restart routes pass `ui` for a person', async () => {
  const h = harness(ownerActor());
  assert.equal((await h.post('/s1/bypass', { acknowledged: true })).status, 200);
  assert.equal((await h.post('/s1/bypass/allow')).status, 200);
  assert.equal((await h.app.request('/s1/models')).status, 200);
  assert.equal((await h.post('/s1/restart')).status, 200);
  assert.deepEqual(
    h.seen.map((x) => [x.op, x.actor]),
    [['enter', 'ui'], ['allow', 'ui'], ['models', 'ui'], ['restart', 'ui']],
  );
});

test('T-723: the same routes pass the token’s own name for a request that is not a person, never `ui`', async () => {
  const who = tokenActor();
  const name = actorString(who);
  assert.notEqual(name, 'ui');
  const h = harness(who);
  await h.post('/s1/bypass', { acknowledged: true });
  await h.post('/s1/bypass/allow');
  await h.app.request('/s1/models');
  await h.post('/s1/restart');
  assert.deepEqual(
    h.seen.map((x) => [x.op, x.actor]),
    [['enter', name], ['allow', name], ['models', name], ['restart', name]],
  );
});

test('T-723: `acknowledged` reaches the controller true only when the body says exactly true', async () => {
  const h = harness(ownerActor());
  for (const value of ['true', 1, 'yes', null, {}, [true]]) await h.post('/s1/bypass', { acknowledged: value });
  await h.post('/s1/bypass', {});
  await h.post('/s1/bypass', { acknowledged: true });
  assert.deepEqual(
    h.seen.map((x) => x.acknowledged),
    [false, false, false, false, false, false, false, true],
  );
});
