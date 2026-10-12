// Codespaces POC: the HTTP routes (docs/prd/codespaces-poc.md §12; CODESPACES_API in packages/contracts/src/codespaces.ts). No auth middleware
// here: app.ts mounts this under a guarded group (`requireSession`, the Origin check on mutating requests) at /api/codespaces. Who is asking
// comes from the authorization seam (`actorOf`) once per request; the service decides who may use which connection (service.ts header).
// Nothing here returns a token, a device code or a GitHub response body.

import { success } from '@isnanme/core';
import { Hono } from 'hono';
import { actorOf } from '../authz/seam.js';
import type { Codespaces } from './service.js';

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createCodespacesRoutes(cs: Codespaces): Hono {
  const r = new Hono();

  r.get('/', (c) => c.json(success(cs.status(actorOf(c)))));

  r.post('/connections', async (c) => c.json(success(await cs.connect(actorOf(c), (await body(c)) as never)), 201));
  r.post('/connections/:id/check', async (c) => c.json(success(await cs.check(actorOf(c), c.req.param('id')))));
  r.delete('/connections/:id', async (c) => {
    const b = await body(c);
    return c.json(success(cs.disconnect(actorOf(c), c.req.param('id'), { deleteSecret: b.deleteSecret === true })));
  });

  r.post('/device', async (c) => c.json(success(await cs.startDevice(actorOf(c))), 201));
  r.get('/device/:flowId', (c) => c.json(success(cs.deviceFlow(actorOf(c), c.req.param('flowId')))));
  r.delete('/device/:flowId', (c) => c.json(success(cs.cancelDevice(actorOf(c), c.req.param('flowId')))));

  r.get('/connections/:id/repos', async (c) => c.json(success(await cs.repos(actorOf(c), c.req.param('id'), c.req.query('q') ?? null))));
  r.get('/connections/:id/repos/:owner/:repo/options', async (c) =>
    c.json(success(await cs.options(actorOf(c), c.req.param('id'), `${c.req.param('owner')}/${c.req.param('repo')}`, c.req.query('ref') ?? null))),
  );
  r.get('/connections/:id/billing', (c) => c.json(success(cs.billing(actorOf(c), c.req.param('id')))));

  r.get('/connections/:id/codespaces', async (c) => c.json(success(await cs.list(actorOf(c), c.req.param('id')))));
  r.post('/connections/:id/codespaces', async (c) => c.json(success(await cs.create(actorOf(c), c.req.param('id'), (await body(c)) as never)), 201));
  r.get('/connections/:id/codespaces/:name', async (c) => c.json(success(await cs.get(actorOf(c), c.req.param('id'), c.req.param('name')))));
  r.post('/connections/:id/codespaces/:name/start', async (c) => c.json(success(await cs.start(actorOf(c), c.req.param('id'), c.req.param('name')))));
  r.post('/connections/:id/codespaces/:name/stop', async (c) => c.json(success(await cs.stopCodespace(actorOf(c), c.req.param('id'), c.req.param('name')))));
  r.post('/connections/:id/codespaces/:name/attach', async (c) => c.json(success(await cs.attach(actorOf(c), c.req.param('id'), c.req.param('name')))));
  r.post('/connections/:id/codespaces/:name/detach', (c) => {
    cs.detach(actorOf(c), c.req.param('id'), c.req.param('name'));
    return c.json(success({ detached: true }));
  });
  r.delete('/connections/:id/codespaces/:name', async (c) => {
    const b = await body(c);
    await cs.remove(actorOf(c), c.req.param('id'), c.req.param('name'), b.confirm);
    return c.json(success({ deleted: true }));
  });

  return r;
}
