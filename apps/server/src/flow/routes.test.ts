// `GET /api/flow` is the owner's (T-1966): a platform admin as a person or an admin token; an agent, a narrower token or another user get
// the same 404. Also: the state survives a restart (portal_meta), and the stall notification reads in fixed words.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { Hono } from 'hono';
import { freshStore } from '../notify/testkit.js';
import { render } from '../notify/templates.js';
import type { PlatformOwner } from '../platform/owner.js';
import { createFlowRoutes } from './routes.js';
import { emptyFlowState, MetaFlowStore } from './store.js';

function owner(actor: Record<string, unknown>, userId: string | null): PlatformOwner {
  return {
    actorOf: () => ({ actor, userId, admin: userId === 'u_a', label: 'x' }),
    isAdmin: (u: string) => u === 'u_a',
  } as unknown as PlatformOwner;
}

function app(o: PlatformOwner) {
  const a = new Hono();
  a.onError((e, c) => c.json({ ok: false }, e instanceof AppError && e.code === 'NOT_FOUND' ? 404 : 500));
  a.route('/api/flow', createFlowRoutes({ owner: o, engine: { snapshot: () => ({ enabled: true, lastRunAt: null, programs: [], actions: [] }) } }));
  return a;
}

test('GET /api/flow: the owner (a person or an admin token) reads it; an agent, a narrow token or another user get 404', async () => {
  const ok = [owner({ kind: 'user', userId: 'u_a' }, 'u_a'), owner({ kind: 'token', scope: 'admin' }, 'u_a')];
  for (const o of ok) assert.equal((await app(o).request('/api/flow')).status, 200);
  const no = [
    owner({ kind: 'agent', sessionId: 's1' }, 'u_a'),
    owner({ kind: 'token', scope: 'read' }, 'u_a'),
    owner({ kind: 'user', userId: 'u_b' }, 'u_b'),
    owner({ kind: 'user' }, null),
  ];
  for (const o of no) assert.equal((await app(o).request('/api/flow')).status, 404);
});

test('the state is kept in portal_meta: a restart keeps the rate limits and the trail', async () => {
  const { store } = await freshStore();
  const a = new MetaFlowStore(store);
  const st = emptyFlowState();
  st.sent['merge:x'] = 123;
  st.actions.push({ at: '2026-10-21T00:00:00.000Z', program: 'konfersi', condition: 'merge', kind: 'told', sessionId: 's', tickets: ['T-1'], note: 'n' });
  a.save(st);
  const b = new MetaFlowStore(store).load();
  assert.equal(b.sent['merge:x'], 123);
  assert.equal(b.actions[0]!.tickets[0], 'T-1');
  store.close();
});

test('the stall notification: fixed words and counts only', () => {
  const r = render({
    id: 'evt_1',
    kind: 'keepgoing_attention',
    at: '2026-10-21T00:00:00.000Z',
    subject: { type: 'portal', id: 'flow-konfersi' },
    facts: { what: 'flow_stalled', program: 'konfersi', inReview: 92, hours: 3 },
  });
  assert.equal(r.title, 'Flow stalled');
  assert.match(r.body, /konfersi · 92 in review · none done in 3 h/);
});
