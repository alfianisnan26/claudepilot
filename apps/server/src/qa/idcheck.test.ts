// QA-032: the workspace-id check in the session guard reads the JSON body to look for ids. It must leave the stream for the handler:
// the avatar, vault import and file routes read the raw body themselves, and a guard that consumed it made them answer 500.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { Portal } from '../portal.js';

const stub: object = new Proxy(function () {}, { get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub), apply: () => stub, construct: () => stub, set: () => true });
// A holder, not a `let`: TypeScript would narrow a variable assigned inside the stub to `null` in the tests.
const seen: { put: { id: string; path: string; bytes: number } | null } = { put: null };
const got = () => seen.put;
const knowledge = {
  limits: { attachmentBytes: 1_000_000 },
  putFile: (id: string, path: string, data: Uint8Array) => {
    seen.put = { id, path, bytes: data.byteLength };
    return { ok: true };
  },
};
const portal = new Portal('24681357', 60_000);
const token = portal.signIn('24681357');
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const app = make(portal, stub, stub, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, knowledge });
const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const put1 = (body: string, type: string) =>
  app.request('http://localhost:3000/api/knowledge/vaults/v1/file?path=a.txt', { method: 'PUT', headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: `portal_session=${token}`, 'content-type': type }, body }, env);

test('a route that reads the raw body still gets all of it when the JSON id check has looked at it', async () => {
  seen.put = null;
  const body = JSON.stringify({ workspaceId: 'docker/ws-1', text: 'x'.repeat(5000) });
  const res = await put1(body, 'application/json');
  assert.equal(res.status, 201, await res.clone().text());
  assert.deepEqual(got(), { id: 'v1', path: 'a.txt', bytes: Buffer.byteLength(body) });
});

test('the same route refuses a hostile id before it reads anything, and a body that is not JSON is not parsed at all', async () => {
  seen.put = null;
  const res = await put1(JSON.stringify({ workspaceId: 'docker/x%2f..%2f..%2fcontainers' }), 'application/json');
  assert.equal(res.status, 422);
  assert.equal(got(), null);
  // Not JSON: the guard does not look, so bytes that merely contain the text pass through.
  const res2 = await put1('{"workspaceId":"../x"}', 'application/octet-stream');
  assert.equal(res2.status, 201);
  assert.equal(got()?.bytes, 22);
  // Broken JSON is the handler's to judge, not a 500 from the guard.
  const res3 = await put1('{"workspaceId":', 'application/json');
  assert.equal(res3.status, 201);
});
