import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { maskPath, slowLine, slowRequests } from './slowRequests.js';

test('2026-11-02: a slow request logs its route with ids masked and its query names only', async () => {
  assert.equal(maskPath('/api/chat/sessions/5b078677-3a13-4589-989c-40fd63865af3/events'), '/api/chat/sessions/:id/events');
  assert.equal(maskPath('/api/orgs/org_DQ_gJh-QoIFN/members/u_GwuJc01n61sC'), '/api/orgs/:id/members/:id');
  assert.equal(maskPath('/api/tickets/T-3312/comments'), '/api/tickets/:id/comments');
  assert.equal(maskPath('/api/ci/runs/42'), '/api/ci/runs/:id');
  assert.equal(slowLine(2312.4, 'GET', 'http://h/api/chat/sessions/x?limit=5&before=10&token=SECRETVALUE', 200), '[slow] 2312 ms GET /api/chat/sessions/x?before&limit&token 200');
  const lines: string[] = [];
  const app = new Hono();
  app.use(slowRequests((l) => lines.push(l), 20));
  app.get('/fast', (c) => c.text('ok'));
  app.get('/slow/:id', async (c) => {
    await new Promise((r) => setTimeout(r, 40));
    return c.text('ok');
  });
  await app.request('/fast');
  await app.request('/slow/5b078677-3a13-4589-989c-40fd63865af3?q=1');
  assert.equal(lines.length, 1, lines.join(' | '));
  assert.match(lines[0]!, /^\[slow\] \d+ ms GET \/slow\/:id\?q 200$/);
  assert.ok(!lines[0]!.includes('5b078677'), 'no id in the line');
});
