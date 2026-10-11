import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import type { SecretsContent as View } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { Reconciler } from '../delivery/reconciler.js';
import { MANIFEST_PATH } from '../delivery/types.js';
import { createPoolRoutes, createWorkspacePoolRoutes } from '../pools/routes.js';
import { createSecretsRoutes } from './routes.js';
import { memoryWorkspace, secretsHarness } from './testkit.js';

/** A canary value (PRD §13): if it shows up outside an archive body, in any encoding, something leaked. */
const CANARY = 'cnryQ7zX2mV9kL4pW8nB3hJ6tR1sD5fG';
const ENCODED = (s: string) => [
  s,
  Buffer.from(s).toString('base64'),
  Buffer.from(s).toString('base64url'),
  Buffer.from(s).toString('hex'),
  encodeURIComponent(s),
  [...Buffer.from(s)].map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''),
  s.split('').map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
  // A slice long enough to identify it, in case something truncates.
  s.slice(4, 20),
];
const leaks = (text: string, value = CANARY) => ENCODED(value).filter((e) => text.includes(e) || text.toLowerCase().includes(e.toLowerCase()));

test('canary: a secret value never appears in API responses, errors, logs, events, the manifest or exec command lines', async () => {
  const h = await secretsHarness();
  const ws = memoryWorkspace();
  const logged: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  const reconciler = new Reconciler(h.store, () => ws.runtime, () => [ws.runtime], h.providers);
  h.service.reconciler = reconciler;
  const app = new Hono();
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    if (err.status >= 500) console.error(e);
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  });
  app.route('/api/pools', createPoolRoutes({ service: h.service }));
  app.route('/api/workspaces', createWorkspacePoolRoutes({ service: h.service, reconciler }));
  app.route('/api/workspaces', createSecretsRoutes({ pools: h.service, workspaces: { runtimeFor: () => ws.runtime } }));
  const responses: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    responses.push(`${method} ${path} ${res.status} ${text}`);
    return { status: res.status, json: JSON.parse(text) as { data: unknown; error?: { message: string } } };
  };
  try {
    // Create, with a secret exposed as a variable (so it lands in the drop-in too) and one in terminals.
    const created = await call('POST', '/api/pools/secrets', {
      name: 'team',
      content: {
        entries: [
          { kind: 'variable', name: 'REGION', value: 'eu' },
          { kind: 'secret', name: 'API_TOKEN', newValue: CANARY, options: { expose: true, terminals: true, pathVariable: 'API_TOKEN_FILE' } },
        ],
      },
    });
    assert.equal(created.status, 201);
    const pool = created.json.data as { id: string; content: View };
    // Refusals that carry the canary in their input: the error never repeats the value.
    for (const bad of [
      { kind: 'secret', name: 'K', newValue: `sk-ant-api03-${CANARY}` },
      { kind: 'variable', name: 'K', value: `ghp_${CANARY}` },
      { kind: 'variable', name: 'K', value: `${CANARY}\n` },
      { kind: 'variable', name: 'PATH', value: CANARY },
      { kind: 'secret', name: '../K', newValue: CANARY },
      { kind: 'secret', name: 'K', newValue: `${CANARY}\0` },
    ])
      assert.equal((await call('PUT', `/api/pools/secrets/${pool.id}`, { content: { entries: [bad] } })).status, 422);

    await call('GET', '/api/pools/secrets');
    await call('GET', `/api/pools/secrets/${pool.id}`);
    await call('POST', `/api/pools/secrets/${pool.id}/preview`, {});
    await call('POST', '/api/pools/secrets/preview', { content: { entries: [{ kind: 'secret', name: 'NEW', newValue: CANARY, options: { expose: true } }] } });
    await call('PUT', `/api/workspaces/docker/ws1/pools/secrets`, { items: [{ poolId: pool.id }] });
    await reconciler.request('docker/ws1', 'test');
    assert.equal(reconciler.row('docker/ws1')!.status, 'synced', reconciler.row('docker/ws1')!.reason ?? '');
    await call('GET', '/api/workspaces/docker/ws1/pools');
    await call('GET', '/api/workspaces/docker/ws1/secrets');
    await call('POST', '/api/workspaces/docker/ws1/secrets/check');
    // Rotate, then remove the secret: tombstones and deletions go through the same paths.
    const view = (await call('GET', `/api/pools/secrets/${pool.id}`)).json.data as { content: View };
    await call('PUT', `/api/pools/secrets/${pool.id}`, { content: { entries: view.content.entries.map((e) => (e.kind === 'secret' ? { ...e, newValue: `${CANARY}-v2` } : e)) } });
    await reconciler.request('docker/ws1', 'test');
    ws.state.ages = [3600];
    await call('PUT', `/api/pools/secrets/${pool.id}`, { content: { entries: view.content.entries.filter((e) => e.kind === 'variable') } });
    await reconciler.request('docker/ws1', 'test');
    await call('POST', `/api/pools/secrets/${pool.id}/duplicate`, { name: 'copy' });

    // Where the value did go: archive bodies only (the secret file, and the drop-in while exposed).
    const archived = ws.puts.flat().filter((e) => e.content && leaks(e.content).length);
    assert.ok(archived.length > 0);
    for (const e of archived) assert.match(e.path, /\/files\/\.?API_TOKEN(\.cp-tmp)?$|20-claudepilot-env\.json(\.cp-tmp)?$/, e.path);

    // Everywhere else: never.
    const events = (h.store.db!.prepare('SELECT kind, details FROM delivery_events').all() as { kind: string; details: string }[]).map((e) => `${e.kind} ${e.details}`);
    const manifests = ws.puts.flat().filter((e) => e.path.startsWith(MANIFEST_PATH) || e.path.includes('.state.json')).map((e) => e.content ?? '');
    const revisions = (h.store.db!.prepare('SELECT content FROM pool_revisions').all() as { content: string }[]).map((r) => r.content);
    const rows = JSON.stringify(h.store.db!.prepare('SELECT * FROM workspace_delivery').all());
    const values = JSON.stringify(h.store.db!.prepare('SELECT id, pool_id, entry_id, field, version, fingerprint, hint, byte_length, detected_type FROM secret_values').all());
    const places: [string, string[]][] = [
      ['API responses', responses],
      ['logs', logged],
      ['delivery events', events],
      ['the manifest', manifests],
      ['revision content', revisions],
      ['delivery rows', [rows]],
      ['secret value metadata', [values]],
      ['exec command lines', ws.scripts.map((s) => s.script)],
      ['exec stdin', ws.scripts.map((s) => s.stdin ?? '')],
    ];
    for (const [where, texts] of places)
      for (const text of texts) {
        assert.deepEqual(leaks(text), [], `${where}: ${text.slice(0, 200)}`);
        assert.deepEqual(leaks(text, `${CANARY}-v2`), [], `${where} (rotated value)`);
      }
    assert.ok(manifests.length > 0 && responses.length > 15 && ws.scripts.length > 3, 'the places searched were really used');
  } finally {
    Object.assign(console, original);
    h.done();
  }
});
