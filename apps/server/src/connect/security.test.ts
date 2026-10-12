// T-SEC (docs/prd/targets-connect.md §19.3, §17.3): canaries injected through every writer an agent or an admin has (a token, a private key, an
// API key) must be absent from every response, audit row, log line and file the portal wrote; agent text is cleaned and clipped; an agent can
// open nothing but `control`; the portal never dials anything an agent names.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { helloFor, openCore, openHub, openModule } from './testkit.js';
import { generateNodeKeyPair } from './tunnel/auth.js';

// Built at runtime: the repository holds no token-shaped literal (a provider's key format, a PEM block, the portal's own tokens).
const TOKEN = ['cpen', '_', 'k9Z'.repeat(14), 'K'].join('');
const PEM = ['-----BEGIN ', 'PRIVATE KEY-----', '\nMC4CAQAwBQYDK2VwBCIEIDcanarycanarycanarycanarycanarycanaryAAAA\n', '-----END ', 'PRIVATE KEY-----'].join('');
const ANTHROPIC = ['sk', 'ant', 'api03', 'canarycanarycanarycanary0123'].join('-');
const GITHUB = ['ghp', '_', 'canarycanarycanarycanarycanary012345'].join('');
const CANARIES = [TOKEN, 'canarycanarycanary', ANTHROPIC, GITHUB, 'k9Zk9Zk9Z'];
const text = `host ${TOKEN} ${ANTHROPIC} ${GITHUB}`;

const diskOf = (dir: string) =>
  readdirSync(dir)
    .filter((f) => /portal\.db/.test(f))
    .map((f) => readFileSync(join(dir, f)).toString('latin1'))
    .join('\n');
const leaks = (haystack: string) => CANARIES.filter((c) => haystack.includes(c));

describe('canaries through every writer', () => {
  test('hello, status, logs and names that carry secrets are stored clean', async () => {
    const core = await openCore();
    const h = await openHub(core);
    try {
      const n = h.enrollNode({ id: 'lab' }, { hostname: `box-${TOKEN}`, agentVersion: ANTHROPIC, os: GITHUB, arch: PEM, services: [{ name: 'docker', ok: false, error: text, version: PEM }] });
      const d = await h.dial(n.nodeId, n.keys, { hello: { hostname: `box-${TOKEN}`, agentVersion: ANTHROPIC, os: GITHUB, arch: PEM, services: [{ name: 'docker', ok: false, error: text, version: PEM }] } });
      const c = await h.control(d);
      await c.send({
        t: 'status',
        at: '2026-10-12T09:00:00.000Z',
        services: [{ name: 'docker', ok: false, error: text, version: PEM }],
        docker: { engine: PEM, apiVersion: TOKEN, os: ANTHROPIC, arch: GITHUB, ncpu: 1, memTotal: 1, containers: 1, running: 1, desktop: false, images: [text, PEM] },
        denied: [{ rule: 'path', count: 1 }],
      });
      for (let i = 0; i < 3; i++) await c.send({ t: 'log', level: 'error', message: `${text} ${PEM}`, at: '2026-10-12T09:00:00.000Z' });
      await c.send({ t: 'bye', reason: 'error', message: text });
      await h.waitFor(() => h.hub.state(n.nodeId)?.status !== null);
      await new Promise((r) => setTimeout(r, 100));
      d.session.close(1000, text);
      await h.waitFor(() => !h.hub.isConnected(n.nodeId));
      const everything = [
        JSON.stringify(core.registry.view(core.registry.requireTarget('lab'))),
        JSON.stringify(core.events.list('lab', { limit: 500 })),
        JSON.stringify(core.cstore.nodes('lab')),
        h.logs.join('\n'),
      ].join('\n');
      assert.deepEqual(leaks(everything), []);
      core.store.db!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      assert.deepEqual(leaks(diskOf(core.dir)), []);
      // and the text that was kept is plain, short and has no escape characters
      const view = core.registry.view(core.registry.requireTarget('lab'));
      for (const v of [view.nodes[0]!.name, view.nodes[0]!.agentVersion ?? '', view.nodes[0]!.os ?? '']) assert.ok(v.length <= 80 && !/[\x00-\x1f\x7f]/.test(v), v);
    } finally {
      await h.close();
    }
  });

  test('the enroll request’s own fields: a node name, a hello and a public key never come back or land in a file', async () => {
    const core = await openCore();
    const w = (await import('./testkit.js')).wizard(core);
    const keys = generateNodeKeyPair();
    core.enrollments.enroll(w.token, { publicKey: keys.publicKey, nodeName: `n-${TOKEN}`, hello: helloFor('docker', { hostname: PEM, agentVersion: TOKEN }) }, '203.0.113.50');
    const all = JSON.stringify([core.registry.view(core.registry.requireTarget('lab')), core.events.list('lab', { limit: 100 })]);
    assert.deepEqual(leaks(all), []);
    core.store.db!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.deepEqual(leaks(diskOf(core.dir)), []);
  });

  test('admin inputs: a label or a setting with a secret in it is stored clean, and an error response does not echo it', async () => {
    const m = await openModule();
    const made = await m.admin('POST', '/targets', { kind: 'docker', platform: 'linux', id: 'lab', label: `Lab ${TOKEN}`, portalUrl: 'https://pilot.example.com' });
    assert.equal(made.status, 201);
    const refused = await m.admin('POST', '/targets', { kind: 'docker', platform: 'linux', id: `bad ${TOKEN}`, portalUrl: 'https://pilot.example.com' });
    assert.equal(refused.status, 422);
    const refusedImage = await m.admin('PATCH', '/targets/lab', { settings: { workspaceImage: `x/${TOKEN}` } });
    const everything = [made.text.replace(made.json.data.token, ''), refused.text, refusedImage.text, (await m.admin('GET', '/targets')).text, (await m.admin('GET', '/targets/lab/events')).text].join('\n');
    assert.deepEqual(leaks(everything), []);
    await m.close();
  });
});

describe('an agent can do nothing to the portal beyond its own node', () => {
  test('an agent that opens docker, kube or host streams, or a second control, is answered bad_open and the portal dials nothing', async () => {
    const core = await openCore();
    const h = await openHub(core);
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      await h.control(d);
      const { readLine, writeLine } = await import('./tunnel/index.js');
      for (const service of ['docker', 'kube', 'host', 'control', 'tcp', '../etc/passwd']) {
        const s = d.session.open();
        s.on('error', () => undefined);
        await writeLine(s, { v: 1, service, args: { op: 'read', path: '/etc/shadow' } });
        const reply = JSON.parse((await readLine(s, 1_000)) ?? '{}') as { ok?: boolean; code?: string };
        assert.equal(reply.ok, false, service);
        assert.equal(reply.code, 'bad_open', service);
        s.destroy();
      }
      assert.equal(h.hub.isConnected(n.nodeId), true, 'and the connection is fine');
    } finally {
      await h.close();
    }
  });

  test('the hub has no code path that opens a socket to an address from the wire (no net.connect, fetch or request in hub.ts, enrollment.ts, registry.ts)', async () => {
    for (const file of ['hub.ts', 'enrollment.ts', 'registry.ts', 'admin.ts', 'agentText.ts', 'settings.ts']) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      assert.ok(!/\bfetch\(|net\.connect|createConnection|https?\.request|http\.get|new WebSocket\(/.test(src), `${file} dials out`);
    }
  });
});
