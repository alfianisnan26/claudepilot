// D-111 D6: the Home and Glance layouts per person and org context, on a real migrated database (migration 910), through the routes.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { FOUNDING_USER_ID, LAYOUT_LIMITS, type Actor, type UserId } from '@portal/contracts';
import { Hono } from 'hono';
import { clearResolvers, policyFor, useAccountRoles, useOrgAuthority, type AccountRoleOf } from '../authz/seam.js';
import { createOrgs } from '../orgs/index.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { createLayoutRoutes, LayoutStore } from './layouts.js';

const ANA = 'u_Ana00000666' as UserId;
const BEN = 'u_Ben00000666' as UserId;
let store: Store;
let restoreRoles: AccountRoleOf;
let orgId = '';
const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });

function app(actor: Actor) {
  const a = new Hono<{ Variables: { actor: Actor } }>();
  a.use(async (c, next) => (c.set('actor', actor), next()));
  a.onError((e, c) => c.json({ code: isAppError(e) ? e.code : 'ERR' }, (isAppError(e) ? e.status : 500) as 404));
  a.route('/api/layouts', createLayoutRoutes(new LayoutStore(store)));
  return a;
}
const get = async (who: Actor, q = '') => {
  const r = await app(who).request(`/api/layouts${q}`);
  return { status: r.status, body: (await r.json()) as { data?: unknown; code?: string } };
};
const put = async (who: Actor, kind: string, layout: unknown, q = '') => {
  const r = await app(who).request(`/api/layouts/${kind}${q}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout }) });
  return { status: r.status, body: (await r.json()) as { data?: unknown; code?: string } };
};

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-layouts-'), secretKey: null });
  const at = new Date().toISOString();
  for (const [id, role] of [[FOUNDING_USER_ID, 'admin'], [ANA, 'member'], [BEN, 'member']] as const)
    store.db!
      .prepare('INSERT OR IGNORE INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, 'active', 'not-a-hash', at, at, 'ui');
  restoreRoles = useAccountRoles((id) => (store.db!.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member' } | undefined)?.role ?? null);
  const m = createOrgs({ store });
  orgId = m.orgs.create(person(FOUNDING_USER_ID), { name: 'Acme', slug: 'acme' }).id;
  m.orgs.admit(orgId, ANA, 'member', 'invite', 'test');
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
  store.close();
});

test('the routes are the person’s own (`self`)', () => {
  assert.deepEqual(policyFor('GET /api/layouts'), { kind: 'self' });
  assert.deepEqual(policyFor('PUT /api/layouts/:kind'), { kind: 'self' });
});

test('a layout is saved per person: two people never share one', async () => {
  assert.deepEqual((await get(person(ANA))).body.data, { glance: null, home: null }, 'nothing yet');
  assert.equal((await put(person(ANA), 'home', { order: ['ci'], hidden: [] })).status, 200);
  assert.equal((await put(person(ANA), 'glance', { order: ['quota'] }, '?org=personal')).status, 200);
  assert.deepEqual((await get(person(ANA), '?org=personal')).body.data, { glance: { order: ['quota'] }, home: { order: ['ci'], hidden: [] } });
  assert.deepEqual((await get(person(BEN))).body.data, { glance: null, home: null }, 'Ben does not read Ana’s');
  await put(person(BEN), 'home', { order: ['usage'] });
  assert.deepEqual((await get(person(ANA))).body.data, { glance: { order: ['quota'] }, home: { order: ['ci'], hidden: [] } }, 'and does not overwrite it');
  // Saving again replaces (one row per person, context, kind).
  await put(person(ANA), 'home', { order: ['tickets'] });
  assert.deepEqual(((await get(person(ANA))).body.data as { home: unknown }).home, { order: ['tickets'] });
  assert.equal((store.db!.prepare("SELECT count(*) AS n FROM user_layouts WHERE user_id = ? AND kind = 'home'").get(ANA) as { n: number }).n, 1);
});

test('per org context: an org the person is in has its own; any other org is the 404 of a missing one', async () => {
  assert.equal((await put(person(ANA), 'glance', { order: ['sessions'] }, `?org=${orgId}`)).status, 200);
  assert.deepEqual(((await get(person(ANA), `?org=${orgId}`)).body.data as { glance: unknown }).glance, { order: ['sessions'] });
  assert.deepEqual(((await get(person(ANA), '?org=acme')).body.data as { glance: unknown }).glance, { order: ['sessions'] }, 'by slug too');
  assert.deepEqual(((await get(person(ANA))).body.data as { glance: unknown }).glance, { order: ['quota'] }, 'Personal unchanged');
  assert.equal((await get(person(BEN), `?org=${orgId}`)).status, 404, 'not a member');
  assert.equal((await put(person(BEN), 'glance', { order: [] }, `?org=${orgId}`)).status, 404);
  assert.equal((await get(person(ANA), '?org=org_madeupxxxx')).status, 404);
});

test('refused: an unknown kind, a body that is not an object, one too large, a token or an agent', async () => {
  assert.equal((await put(person(ANA), 'other', { a: 1 })).status, 404);
  assert.equal((await put(person(ANA), 'home', [1, 2])).status, 422);
  assert.equal((await put(person(ANA), 'home', 'text')).status, 422);
  assert.equal((await put(person(ANA), 'home', { order: ['x'.repeat(LAYOUT_LIMITS.bytes)] })).status, 422);
  assert.equal((await get({ kind: 'token', userId: ANA, tokenId: 'ptk_x', scope: 'admin' })).status, 403);
  assert.equal((await put({ kind: 'agent', userId: ANA, tokenId: 't', sessionId: 's', workspaceId: 'docker/x' }, 'home', { a: 1 })).status, 403);
});
