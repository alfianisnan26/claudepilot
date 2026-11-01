// Organizations slice 2 (docs/prd/organizations.md §13 P5): knowledge search, quick search, the vault list and the graphs keep to the vaults
// the person may VIEW (the seam's `can(actor, 'view', vaultRef(id))`). Two people each own a vault (a fake `vault` resolver, as slice 1's
// owners will provide): `u_b` searching `u_a`'s vault gets the same 404 as a vault that does not exist, and no hit of it anywhere.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { vaultRef, type Actor } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { can, registerResolver } from '../authz/seam.js';
import { createKnowledgeRoutes } from './routes.js';
import { KnowledgeService } from './service.js';
import { harness } from './testkit.js';

const A = 'u_Alice_000001';
const B = 'u_Bob_00000001';
const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'x', via: 'ui' });

const h = await harness();
after(() => h.close());
const svc = new KnowledgeService(h.store, { dir: join(h.dir, 'knowledge'), backupsDir: join(h.dir, 'backups'), limits: h.limits, now: () => h.clock.now });
const va = svc.create({ name: 'Alice notes' });
const vb = svc.create({ name: 'Bob notes' });
svc.putNote(va.id, 'plan.md', { content: '# Plan\n\nthe zebra launch is secret', create: true });
svc.putNote(vb.id, 'plan.md', { content: '# Plan\n\nthe zebra budget', create: true });
const owners: Record<string, string> = { [va.id]: A, [vb.id]: B };
registerResolver({ type: 'vault', resolve: (id) => (owners[id] ? { ref: vaultRef(id), owner: { kind: 'user', id: owners[id]! } } : null) });

const app = new Hono();
app.onError((e, c) => {
  const err = isAppError(e) ? e : null;
  if (!err) throw e;
  return c.json(err.toJSON(), err.status as ContentfulStatusCode);
});
app.use('*', async (c, next) => {
  c.set('actor' as never, person(c.req.header('x-test-user') ?? '') as never);
  await next();
});
app.route('/api/knowledge', createKnowledgeRoutes(svc));
const get = async (user: string, path: string) => {
  const res = await app.request(`/api/knowledge${path}`, { headers: { 'x-test-user': user } });
  return { status: res.status, body: (await res.json()) as { data?: any; error?: { code: string; message: string } } };
};

test('X: search and quick search of another person’s vault are the same 404 as a vault that does not exist', async () => {
  const own = await get(A, `/vaults/${va.id}/search?q=zebra`);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.data.hits.map((x: { path: string }) => x.path), ['plan.md']);
  const theirs = await get(B, `/vaults/${va.id}/search?q=zebra`);
  const missing = await get(B, `/vaults/v_does_not_exist/search?q=zebra`);
  assert.equal(theirs.status, 404);
  assert.deepEqual(theirs.body.error, missing.body.error, 'no existence leak');
  assert.ok(!JSON.stringify(theirs.body).includes('secret'));
  // By name too: a vault named in the URL is resolved among the ones the person may view.
  assert.equal((await get(B, `/vaults/${encodeURIComponent('Alice notes')}/search?q=zebra`)).status, 404);
  assert.equal((await get(B, `/vaults/${va.id}/quick?q=pla`)).status, 404);
  assert.equal((await get(A, `/vaults/${va.id}/quick?q=pla`)).status, 200);
});

test('X: the vault list and the cross-vault graphs keep to what the person may view', async () => {
  const listA = await get(A, '/vaults');
  assert.deepEqual(listA.body.data.map((v: { id: string }) => v.id), [va.id]);
  const listB = await get(B, '/vaults');
  assert.deepEqual(listB.body.data.map((v: { id: string }) => v.id), [vb.id]);
  assert.equal((await get(B, `/graph?lens=docs&vault=${va.id}`)).status, 404);
  const ctx = await get(B, '/graph?lens=context');
  assert.equal(ctx.status, 200);
  assert.ok(!JSON.stringify(ctx.body).includes(va.id), 'no node of A’s vault in B’s context graph');
});

test('X: a Portal MCP token is held to what its minter may view (the service scope the tools build)', () => {
  const asB = person(B);
  const scope = { vaults: null, canView: (id: string) => can(asB, 'view', vaultRef(id)).allow };
  assert.deepEqual(svc.list(scope).map((v) => v.id), [vb.id]);
  assert.throws(() => svc.search(va.id, 'zebra', {}, undefined, scope), (e: unknown) => (e as { reason?: string }).reason === 'NOT_FOUND');
  assert.equal(svc.search(vb.id, 'zebra', {}, undefined, scope).hits.length, 1);
});

test('an anonymous request (no actor) sees no vault at all: fail closed', async () => {
  assert.deepEqual((await get('', '/vaults')).body.data, []);
  assert.equal((await get('', `/vaults/${vb.id}/search?q=zebra`)).status, 404);
});
