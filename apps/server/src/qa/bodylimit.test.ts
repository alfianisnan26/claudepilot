// QA regression (QA-028): a request body is refused by its size before it is read into memory. Sign-in needs no session, so
// without a limit a stranger could make the portal buffer hundreds of megabytes per request (measured: a 120 MB POST to
// /api/login took the process from 238 MB to 538 MB).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { Portal } from '../portal.js';

const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const app = make(new Portal('24681357', 60_000), stub, stub, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub });
const base = { host: 'localhost:3000', origin: 'http://localhost:3000' };
/** What @hono/node-server provides to the app: the socket the request came in on. */
const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const post = (path: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  app.request(`http://localhost:3000${path}`, { method: 'POST', headers: { ...base, ...headers }, body }, env);
const json = { 'content-type': 'application/json' };

test('sign-in refuses a body over 4 KB with 413 and a JSON error', async () => {
  const res = await post('/api/login', JSON.stringify({ code: 'x', pad: 'A'.repeat(5000) }), json);
  assert.equal(res.status, 413);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'PAYLOAD_TOO_LARGE');
  // A normal sign-in attempt is untouched: wrong code is 401, not 413.
  assert.equal((await post('/api/login', JSON.stringify({ code: '00000000' }), json)).status, 401);
});

test('a JSON call over 4 MB is refused whatever it is for, before the session is even looked at', async () => {
  const big = JSON.stringify({ name: 'x', pad: 'A'.repeat(4 * 1024 * 1024 + 10) });
  for (const path of ['/api/workspaces', '/api/accounts', '/api/pools/secrets', '/api/chat/sessions']) assert.equal((await post(path, big, json)).status, 413, path);
  // Under the limit it reaches the session guard (401: not signed in).
  assert.equal((await post('/api/workspaces', JSON.stringify({ name: 'x' }), json)).status, 401);
});

test('a body without a declared length is counted as it arrives', async () => {
  const chunk = new TextEncoder().encode('A'.repeat(1024));
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= 6) return controller.close();
      sent++;
      controller.enqueue(chunk);
    },
  });
  const res = await app.request('http://localhost:3000/api/login', { method: 'POST', headers: { ...base, ...json }, body: stream, duplex: 'half' } as RequestInit, env);
  assert.equal(res.status, 413, '6 KB streamed to sign-in');
});

test('other content types are capped far higher, so uploads with their own limits still work', async () => {
  const res = await post('/api/workspaces', new Uint8Array(2 * 1024 * 1024), { 'content-type': 'application/octet-stream' });
  assert.equal(res.status, 401, 'a 2 MB upload is not refused here (the session guard answers)');
});
