// T-REG and T-ENR over HTTP (docs/prd/targets-connect.md §15, §19.3), T-SEC (responses): the admin REST as app.ts mounts it, the agent-facing
// routes with no cookie, the kill switch, the audit of admin acts, and the route table against its declarations.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONNECT_API, CONNECT_REMOVE_QUERY, isConnectToken, type Workspace } from '@portal/contracts';
import { declaredPolicies } from '../authz/seam.js';
import { helloFor, openModule, type TestModule } from './testkit.js';
import { generateNodeKeyPair } from './tunnel/auth.js';
import { dialTunnel } from './tunnel/index.js';

const wsOf = (target: string, name: string): Workspace => ({ id: `${target}/${name}`, name, target, image: 'x', status: 'running', createdAt: 'now' });

const create = (m: TestModule, over: Record<string, unknown> = {}) =>
  m.admin('POST', '/targets', { kind: 'docker', platform: 'linux', id: 'lab', portalUrl: 'https://pilot.example.com', ...over });

const enroll = (m: TestModule, token: string, over: { hello?: object; publicKey?: string; headers?: Record<string, string>; ip?: string } = {}) =>
  m.call('POST', '/connect/v1/enroll', { publicKey: over.publicKey ?? generateNodeKeyPair().publicKey, hello: over.hello ?? helloFor('docker') }, { authorization: `Bearer ${token}`, ...over.headers }, over.ip ?? '198.51.100.7');

describe('targets', () => {
  test('POST makes a pending target and its token, once; GET never shows the token again', async () => {
    const m = await openModule();
    const res = await create(m);
    assert.equal(res.status, 201);
    const d = res.json.data;
    assert.ok(isConnectToken(d.token));
    assert.equal(d.target.id, 'lab');
    assert.equal(d.target.link, 'pending');
    assert.equal(d.target.createdBy, 'u_owner');
    assert.equal(d.enrollment.state, 'waiting');
    assert.ok(d.commands.install.includes(d.token), 'the command carries it');
    const list = await m.admin('GET', '/targets');
    assert.deepEqual(list.json.data.map((r: { source: string; id: string }) => `${r.source}:${r.id}`), ['scanned:docker', 'enrolled:lab']);
    for (const path of ['/targets', '/targets/lab', '/targets/lab/enrollments', '/targets/lab/events']) {
      const r = await m.admin('GET', path);
      assert.equal(r.status, 200, path);
      assert.ok(!r.text.includes(d.token), `${path} must not show the token`);
    }
    assert.equal((await m.admin('GET', '/targets/lab')).json.data.enrollment.last4, d.token.slice(-4));
    assert.equal((await m.admin('GET', '/targets/nope')).status, 404);
    assert.equal((await m.admin('GET', '/targets/Bad%20Id')).status, 404);
    assert.equal((await m.admin('GET', '/targets/docker')).status, 404, 'a scanned target is not an enrolled one');
    assert.ok(m.topics.n > 0, 'pages are told');
    await m.close();
  });

  test('validation: fields named, 409 for a taken id or label, a Host needs its confirmation, a Windows host is not offered', async () => {
    const m = await openModule();
    assert.equal((await create(m, { id: 'Bad Name' })).json.error.details.id.length > 0, true);
    assert.equal((await create(m, { kind: 'nope' })).status, 422);
    assert.equal((await create(m, { id: 'docker' })).status, 422, 'reserved');
    assert.equal((await create(m, { portalUrl: 'http://pilot.lan:3000' })).json.error.details.reason, 'insecure_url');
    assert.equal((await create(m, { kind: 'host', id: 'metal' })).json.error.details.hostAccess.length > 0, true);
    assert.equal((await create(m, { kind: 'host', platform: 'windows', id: 'win', options: { hostAccess: true } })).json.error.details.platform.length > 0, true);
    assert.equal((await create(m, { kind: 'host', id: 'metal', options: { hostAccess: true } })).status, 201);
    assert.equal((await create(m)).status, 201);
    assert.equal((await create(m)).status, 409);
    assert.equal((await create(m, { id: 'lab2', label: 'LAB' })).status, 409);
    assert.equal((await m.admin('POST', '/targets', '[1]')).status, 400);
    assert.equal((await m.admin('POST', '/targets', 'not json')).status, 400);
    await m.close();
  });

  test('the default address is the request’s own origin when none is configured, and the operator’s when one is', async () => {
    const m = await openModule();
    const a = await m.call('POST', '/api/connect/targets', { kind: 'docker', platform: 'linux', id: 'one' }, { origin: 'https://browser.example.com' });
    assert.equal(a.json.data.target.portalUrl, 'https://browser.example.com');
    await m.admin('PUT', '/settings', { publicUrl: 'https://public.example.com' });
    const b = await m.call('POST', '/api/connect/targets', { kind: 'docker', platform: 'linux', id: 'two' }, { origin: 'https://browser.example.com' });
    assert.equal(b.json.data.target.portalUrl, 'https://public.example.com');
    await m.close();
  });

  test('PATCH changes the label, the settings and the default; the namespace is fixed (409)', async () => {
    const m = await openModule();
    await create(m, { id: 'kube', kind: 'kubernetes', options: { namespace: 'ns1' } });
    const ok = await m.admin('PATCH', '/targets/kube', { label: 'Cluster', settings: { delivery: false, maxWorkspaces: 4 }, default: true });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.data.label, ok.json.data.settings.delivery, ok.json.data.settings.maxWorkspaces, ok.json.data.default], ['Cluster', false, 4, true]);
    assert.equal((await m.admin('PATCH', '/targets/kube', { settings: { namespace: 'other' } })).status, 409);
    assert.equal((await m.admin('PATCH', '/targets/kube', { settings: { bogus: 1 } })).status, 422);
    assert.equal((await m.admin('GET', '/settings')).json.data.defaultTarget, 'kube');
    await m.close();
  });

  test('check asks the manager for a fresh look and answers with the view', async () => {
    const m = await openModule();
    await create(m);
    const r = await m.admin('POST', '/targets/lab/check');
    assert.equal(r.status, 200);
    assert.deepEqual(m.rechecked, ['lab']);
    assert.equal(r.json.data.id, 'lab');
    await m.close();
  });
});

describe('enrolling over HTTP', () => {
  test('the agent’s enroll: 200 with the node, the tunnel address and the portal id; then the audit, the view and the status', async () => {
    const m = await openModule();
    const made = (await create(m)).json.data;
    const res = await enroll(m, made.token);
    assert.equal(res.status, 200);
    assert.match(res.json.data.node, /^nd_[0-9a-f]{12}$/);
    assert.equal(res.json.data.tunnel, 'wss://pilot.example.com/connect/v1/tunnel');
    assert.equal(res.json.data.portalId, m.store.portalId);
    const status = await m.call('GET', '/connect/v1/enroll/status', undefined, { authorization: `Bearer ${made.token}` });
    assert.deepEqual(status.json.data, { state: 'enrolled', node: res.json.data.node, target: 'lab' });
    const view = (await m.admin('GET', '/targets/lab')).json.data;
    assert.equal(view.state, 'active');
    assert.equal(view.nodes.length, 1);
    const events = (await m.admin('GET', '/targets/lab/events')).json.data;
    const enrolled = events.find((e: { type: string }) => e.type === 'node.enrolled');
    assert.equal(enrolled.ip, '198.51.100.7');
    assert.equal(events.find((e: { type: string }) => e.type === 'target.created').actor, 'user:u_owner');
    assert.equal(events.find((e: { type: string }) => e.type === 'target.created').ip, '203.0.113.9');
    await m.close();
  });

  test('refusals carry error.details.reason: used, wrong, expired, revoked, bad key, wrong mode, no token at all', async () => {
    const m = await openModule();
    const a = (await create(m)).json.data;
    assert.equal((await enroll(m, a.token)).status, 200);
    const again = await enroll(m, a.token);
    assert.deepEqual([again.status, again.json.error.details.reason], [401, 'token_used']);
    const wrong = await enroll(m, `cpen_${'A'.repeat(43)}`);
    assert.deepEqual([wrong.status, wrong.json.error.details.reason], [401, 'token_invalid']);
    const none = await m.call('POST', '/connect/v1/enroll', { publicKey: 'x', hello: {} });
    assert.deepEqual([none.status, none.json.error.details.reason], [401, 'token_invalid']);
    const b = (await create(m, { id: 'lab2' })).json.data;
    const bad = await enroll(m, b.token, { publicKey: 'short' });
    assert.deepEqual([bad.status, bad.json.error.details.reason], [422, 'bad_key']);
    assert.equal((await enroll(m, b.token, { hello: helloFor('host') })).status, 422);
    const enr = (await m.admin('GET', '/targets/lab2/enrollments')).json.data[0];
    assert.equal((await m.admin('DELETE', `/targets/lab2/enrollments/${enr.id}`)).status, 200);
    const revoked = await enroll(m, b.token);
    assert.deepEqual([revoked.status, revoked.json.error.details.reason], [401, 'token_revoked']);
    const c = (await create(m, { id: 'lab3', ttlMinutes: 1 })).json.data;
    m.clock.now = new Date(m.clock.now.getTime() + 2 * 60_000);
    const expired = await enroll(m, c.token);
    assert.deepEqual([expired.status, expired.json.error.details.reason], [401, 'token_expired']);
    await m.close();
  });

  test('eleven wrong tokens from one address: the eleventh is 429, and it stays so for that address only', async () => {
    const m = await openModule();
    const made = (await create(m)).json.data;
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await enroll(m, `cpen_${String(i).padStart(43, 'B')}`, { ip: '192.0.2.50' })).status);
    assert.deepEqual(codes, [...Array(10).fill(401), 429]);
    assert.equal((await enroll(m, made.token, { ip: '192.0.2.50' })).status, 429);
    assert.equal((await enroll(m, made.token, { ip: '192.0.2.51' })).status, 200);
    await m.close();
  });

  test('a browser (an Origin header), a body that is not JSON, and a body over the limit are refused', async () => {
    const m = await openModule();
    const made = (await create(m)).json.data;
    assert.equal((await enroll(m, made.token, { headers: { origin: 'https://evil.example.com' } })).status, 403);
    assert.equal((await m.call('GET', '/connect/v1/enroll/status', undefined, { authorization: `Bearer ${made.token}`, origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await m.call('POST', '/connect/v1/enroll', 'not json', { authorization: `Bearer ${made.token}` })).status, 400);
    const big = await m.call('POST', '/connect/v1/enroll', JSON.stringify({ publicKey: 'x'.repeat(40_000), hello: {} }), { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' });
    assert.equal(big.status, 413);
    assert.equal((await enroll(m, made.token)).status, 200, 'none of that used the token up');
    await m.close();
  });

  test('enroll/status: waiting, connected; revoked; a spent token for 30 minutes and then 401; wrong tokens count against the address', async () => {
    const m = await openModule();
    const made = (await create(m)).json.data;
    const status = (token: string, ip = '203.0.113.9') => m.call('GET', '/connect/v1/enroll/status', undefined, { authorization: `Bearer ${token}` }, ip);
    assert.deepEqual((await status(made.token)).json.data, { state: 'waiting' });
    const node = (await enroll(m, made.token)).json.data.node;
    const key = generateNodeKeyPair();
    void key;
    m.clock.now = new Date(m.clock.now.getTime() + 31 * 60_000);
    const late = await status(made.token);
    assert.deepEqual([late.status, late.json.error.details.reason], [401, 'token_used']);
    assert.ok(node);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await status(`cpen_${'C'.repeat(43)}`, '192.0.2.60')).status;
    assert.equal(last, 429);
    await m.close();
  });

  test('a node that dials in shows as connected in the status and the view', async () => {
    const m = await openModule();
    const made = (await create(m)).json.data;
    const keys = generateNodeKeyPair();
    const res = await enroll(m, made.token, { publicKey: keys.publicKey });
    const { createServer } = await import('node:http');
    const server = createServer();
    m.connect.attach(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const dialled = await dialTunnel({ url: `ws://127.0.0.1:${port}/connect/v1/tunnel`, nodeId: res.json.data.node, privateKey: keys.privateKey, hello: () => helloFor('docker') });
    for (let i = 0; i < 100 && !m.connect.hub.isConnected(res.json.data.node); i++) await new Promise((r) => setTimeout(r, 10));
    const status = await m.call('GET', '/connect/v1/enroll/status', undefined, { authorization: `Bearer ${made.token}` });
    assert.equal(status.json.data.state, 'connected');
    assert.equal((await m.admin('GET', '/targets/lab')).json.data.link, 'connected');
    dialled.session.destroy();
    server.closeAllConnections();
    await m.close();
    await new Promise((r) => server.close(r));
  });
});

describe('a locked store over HTTP (FR19)', () => {
  test('enrolling and changing the registry answer 503 with the words and the reason; reading still works', async () => {
    const m = await openModule();
    const made = (await create(m)).json.data;
    m.store.freeze('frozen-by-admin', 'test');
    const e = await enroll(m, made.token);
    assert.deepEqual([e.status, e.json.error.code, e.json.error.details.reason], [503, 'SERVICE_UNAVAILABLE', 'store_locked']);
    assert.match(e.json.error.message, /locked/);
    const c = await create(m, { id: 'other' });
    assert.deepEqual([c.status, c.json.error.details.reason], [503, 'store_locked']);
    assert.equal((await m.admin('PATCH', '/targets/lab', { label: 'x' })).status, 503);
    assert.equal((await m.admin('GET', '/targets/lab')).status, 200);
    m.store.resume();
    assert.equal((await enroll(m, made.token)).status, 200);
    await m.close();
  });
});

describe('the agent-facing prefix', () => {
  test('health, an unknown path, and a tunnel path that is not an upgrade', async () => {
    const m = await openModule();
    const h = await m.call('GET', '/connect/v1/health');
    assert.deepEqual(h.json, { ok: true, protocol: 1, version: '0.0.0' });
    const nope = await m.call('GET', '/connect/v1/nothing-here');
    assert.deepEqual([nope.status, nope.json.error.code], [404, 'NOT_FOUND']);
    assert.equal((await m.call('GET', '/connect/v1/tunnel')).status, 426);
    assert.equal((await m.call('POST', '/connect/v1/health')).status, 404);
    await m.close();
  });

  test('the kill switch: everything under /connect/ is 404, no token can be made, and the registry stays readable (FR61)', async () => {
    const m = await openModule({ config: { enabled: false } });
    for (const [method, path] of [['GET', '/connect/v1/health'], ['POST', '/connect/v1/enroll'], ['GET', '/connect/v1/enroll/status'], ['GET', '/connect/v1/tunnel'], ['GET', '/connect/nothing']] as const) {
      assert.equal((await m.call(method, path)).status, 404, `${method} ${path}`);
    }
    assert.equal((await m.admin('GET', '/targets')).status, 200);
    assert.equal((await create(m)).status, 409);
    assert.equal(m.connect.enabled, false);
    await m.close();
  });
});

describe('removing a target', () => {
  const withNode = async (m: TestModule, id = 'lab') => {
    const made = (await create(m, { id })).json.data;
    const res = await enroll(m, made.token);
    return { made, node: res.json.data.node as string };
  };

  test('a target with workspaces answers 428 with the list until the request says keep or remove; keep forgets it and leaves the workspaces', async () => {
    const m = await openModule({ workspaces: [wsOf('lab', 'a'), wsOf('lab', 'b'), wsOf('other', 'c')] });
    await withNode(m);
    const blocked = await m.admin('DELETE', '/targets/lab');
    assert.equal(blocked.status, 428);
    assert.equal(blocked.json.error.code, 'CONFIRM_REQUIRED');
    assert.deepEqual(blocked.json.error.details, { workspaces: ['lab/a', 'lab/b'], connected: false });
    assert.equal((await m.admin('DELETE', '/targets/lab?onWorkspaces=maybe')).status, 422);
    assert.equal((await m.admin('DELETE', '/targets/lab?onWorkspaces=keep')).status, 200);
    assert.deepEqual(m.removed, [], 'nothing was removed on the host');
    assert.equal((await m.admin('GET', '/targets/lab')).status, 404);
    assert.equal(m.connect.registry.target('lab'), null);
    await m.close();
  });

  test('the query is named onWorkspaces (the session guard of app.ts refuses `workspaces=keep`), and the contract builds the URL', async () => {
    assert.equal(CONNECT_REMOVE_QUERY, 'onWorkspaces');
    assert.equal(CONNECT_API.removeTarget('lab'), '/api/connect/targets/lab');
    assert.equal(CONNECT_API.removeTarget('lab', 'keep'), '/api/connect/targets/lab?onWorkspaces=keep');
    // the guard's own list (app.ts WORKSPACE_FIELDS): nothing Connect reads from a query or a body may be called one of these
    const guarded = ['workspaceId', 'workspaceIds', 'workspace', 'workspaces'];
    assert.ok(!guarded.includes(CONNECT_REMOVE_QUERY));
    const m = await openModule({ workspaces: [wsOf('lab', 'a')] });
    await create(m);
    // the old name is not a parameter of this route any more: without the new one the 428 still stands
    assert.equal((await m.admin('DELETE', '/targets/lab?workspaces=keep')).status, 428);
    assert.equal((await m.call('DELETE', CONNECT_API.removeTarget('lab', 'keep'), undefined, { origin: 'https://pilot.example.com' })).status, 200, 'the contract’s URL works');
    await m.close();
  });

  test('remove needs the target connected; with a node connected the workspaces are removed first', async () => {
    const m = await openModule({ workspaces: [wsOf('lab', 'a'), wsOf('lab', 'b')] });
    const { made, node } = await withNode(m);
    void made;
    assert.equal((await m.admin('DELETE', '/targets/lab?onWorkspaces=remove')).status, 409, 'offline');
    const keys = generateNodeKeyPair();
    void keys;
    // bring the node up with its own key
    const m2 = await openModule({ workspaces: [wsOf('lab', 'a'), wsOf('lab', 'b')] });
    const made2 = (await create(m2)).json.data;
    const k = generateNodeKeyPair();
    const r = await enroll(m2, made2.token, { publicKey: k.publicKey });
    const { createServer } = await import('node:http');
    const server = createServer();
    m2.connect.attach(server);
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as { port: number }).port;
    const dialled = await dialTunnel({ url: `ws://127.0.0.1:${port}/connect/v1/tunnel`, nodeId: r.json.data.node, privateKey: k.privateKey, hello: () => helloFor('docker') });
    for (let i = 0; i < 100 && !m2.connect.hub.isConnected(r.json.data.node); i++) await new Promise((x) => setTimeout(x, 10));
    const blocked = await m2.admin('DELETE', '/targets/lab');
    assert.equal(blocked.json.error.details.connected, true);
    assert.equal((await m2.admin('DELETE', '/targets/lab?onWorkspaces=remove')).status, 200);
    assert.deepEqual(m2.removed, ['lab/a', 'lab/b']);
    for (let i = 0; i < 100 && !dialled.session.closed; i++) await new Promise((x) => setTimeout(x, 10));
    assert.equal(dialled.session.closed, true, 'the tunnel was closed');
    assert.equal(m2.connect.settings.removedNode(r.json.data.node), 'lab', 'the agent will hear target_removed');
    server.closeAllConnections();
    await m2.close();
    await new Promise((x) => server.close(x));
    assert.ok(node);
    await m.close();
  });

  test('a pending target and a single have no workspaces to ask about: removed at once', async () => {
    const m = await openModule({ workspaces: [] });
    await create(m);
    assert.equal((await m.admin('DELETE', '/targets/lab')).status, 200, 'Cancel in the wizard');
    await create(m, { id: 'box', kind: 'container' });
    const box = (await m.admin('GET', '/targets/box/enrollments')).json.data[0];
    assert.ok(box);
    assert.equal((await m.admin('DELETE', '/targets/box')).status, 200);
    await m.close();
  });
});

describe('tokens and nodes', () => {
  test('another token for the same target ("Add node"), listed without its value, revoked, with a plan preview', async () => {
    const m = await openModule();
    const first = (await create(m, { id: 'lab', maxUses: 2 })).json.data;
    const second = await m.admin('POST', '/targets/lab/enrollments', { platform: 'linux', maxUses: 1 });
    assert.equal(second.status, 201);
    assert.notEqual(second.json.data.token, first.token);
    assert.ok(second.json.data.commands.install.includes(second.json.data.token));
    const list = (await m.admin('GET', '/targets/lab/enrollments')).json.data;
    assert.equal(list.length, 2);
    assert.ok(!JSON.stringify(list).includes(first.token) && !JSON.stringify(list).includes(second.json.data.token));
    const plan = await m.admin('GET', `/targets/lab/enrollments/${second.json.data.enrollment.id}/plan`);
    assert.deepEqual(plan.json.data, { steps: ['Install the agent for lab'], manifest: null });
    assert.equal((await m.admin('GET', '/targets/other/enrollments/en_000000000000/plan')).status, 404);
    assert.equal((await m.admin('GET', '/targets/lab/enrollments/en_000000000000/plan')).status, 404);
    assert.equal((await m.admin('DELETE', `/targets/lab/enrollments/${second.json.data.enrollment.id}`)).status, 200);
    assert.equal((await m.admin('POST', '/targets/nope/enrollments', { platform: 'linux' })).status, 404);
    const kube = await m.admin('POST', '/targets', { kind: 'kubernetes', platform: 'linux', id: 'kube', portalUrl: 'https://pilot.example.com' });
    const kubePlan = await m.admin('GET', `/targets/kube/enrollments/${kube.json.data.enrollment.id}/plan`);
    assert.ok(typeof kubePlan.json.data.manifest === 'string');
    await m.close();
  });

  test('a single refuses a second token while it has a node (409 target_enrolled)', async () => {
    const m = await openModule();
    const made = (await create(m, { id: 'box', kind: 'container' })).json.data;
    await enroll(m, made.token, { hello: helloFor('container') });
    const again = await m.admin('POST', '/targets/box/enrollments', { platform: 'linux' });
    assert.deepEqual([again.status, again.json.error.details.reason], [409, 'target_enrolled']);
    await m.close();
  });

  test('nodes: rename and drain; revoke closes and forgets the key; rotate on an offline node is 409', async () => {
    const m = await openModule();
    const made = (await create(m)).json.data;
    const node = (await enroll(m, made.token)).json.data.node as string;
    const patched = await m.admin('PATCH', `/nodes/${node}`, { name: 'primary', drained: true });
    assert.deepEqual([patched.status, patched.json.data.name, patched.json.data.drained], [200, 'primary', true]);
    assert.equal((await m.admin('PATCH', `/nodes/${node}`, { name: 'bad name' })).status, 422);
    assert.equal((await m.admin('POST', `/nodes/${node}/rotate`)).status, 409);
    assert.equal((await m.admin('DELETE', `/nodes/${node}`)).status, 200);
    assert.equal((await m.admin('DELETE', `/nodes/${node}`)).status, 200, 'idempotent');
    assert.equal((await m.admin('GET', '/targets/lab')).json.data.nodes[0].state, 'revoked');
    assert.equal((await m.admin('POST', `/nodes/${node}/rotate`)).status, 409);
    assert.equal((await m.admin('PATCH', `/nodes/${node}`, { drained: false })).status, 409);
    assert.equal((await m.admin('PATCH', '/nodes/nd_000000000000', {})).status, 404);
    await m.close();
  });

  test('scanned targets: hide one, see it hidden only while it is not there; settings read and written', async () => {
    const m = await openModule({ scanned: [{ id: 'docker-host', label: 'Docker (host)', kind: 'docker', where: '/x.sock', available: false, problem: 'not found' }] });
    const hid = await m.admin('PATCH', '/scanned/docker-host', { hidden: true });
    assert.deepEqual([hid.status, hid.json.data.hidden, hid.json.data.source], [200, true, 'scanned']);
    m.scanned[0]!.available = true;
    assert.equal((await m.admin('GET', '/targets')).json.data[0].hidden, false, 'reachable: it is listed again');
    assert.equal((await m.admin('PATCH', '/scanned/nope', { hidden: true })).status, 404);
    assert.equal((await m.admin('PATCH', '/scanned/docker-host', { hidden: 'yes' })).status, 422);
    const s = await m.admin('PUT', '/settings', { tokenTtlMinutes: 30, defaultTarget: 'docker-host' });
    assert.deepEqual([s.json.data.tokenTtlMinutes, s.json.data.defaultTarget, s.json.data.allowHttp, s.json.data.caConfigured], [30, 'docker-host', false, false]);
    assert.equal((await m.admin('PUT', '/settings', { tokenTtlMinutes: 99999 })).status, 422);
    await m.close();
  });
});

describe('with the real installers (T4)', () => {
  test('the commands carry the token and the script’s checksum; the plan preview lists the steps; Kubernetes adds the manifest with the token hidden', async () => {
    const { realInstall } = await import('./installPort.js');
    const m = await openModule({ install: realInstall });
    const made = (await create(m)).json.data;
    assert.ok(made.commands.install.includes(made.token));
    assert.match(made.commands.install, /connect\/install\.sh/);
    assert.match(made.commands.scriptSha256, /^[0-9a-f]{64}$/);
    assert.ok(!made.commands.upgrade.includes(made.token) && !made.commands.uninstall.includes(made.token), 'only the install commands hold a token');
    const plan = (await m.admin('GET', `/targets/lab/enrollments/${made.enrollment.id}/plan`)).json.data;
    assert.ok(plan.steps.length >= 2 && plan.manifest === null);
    const kube = (await m.admin('POST', '/targets', { kind: 'kubernetes', platform: 'linux', id: 'kube', portalUrl: 'https://pilot.example.com', options: { namespace: 'ws-ns' } })).json.data;
    const kubePlan = (await m.admin('GET', `/targets/kube/enrollments/${kube.enrollment.id}/plan`)).json.data;
    assert.match(kubePlan.manifest, /kind: Deployment/);
    assert.match(kubePlan.manifest, /<token>/);
    assert.ok(!kubePlan.manifest.includes(kube.token));
    // and its public routes are mounted: the installer, latest.json, the plan for a token (without using it up)
    const sh = await m.call('GET', '/connect/install.sh');
    assert.equal(sh.status, 200);
    assert.match(sh.headers.get('etag') ?? '', /^"[0-9a-f]{64}"$/);
    assert.equal((await m.call('GET', '/connect/v1/agent/latest.json')).json.build, 'aaaaaaaaaaaa');
    const planText = await m.call('GET', '/connect/v1/plan', undefined, { authorization: `Bearer ${made.token}` });
    assert.equal(planText.status, 200);
    assert.match(planText.text, /^PILOT_PLAN=1\n/);
    assert.match(planText.text, /PILOT_TARGET=lab\n/);
    assert.ok(!planText.text.includes(made.token), 'a plan never holds the token');
    assert.equal((await m.admin('GET', '/targets/lab')).json.data.enrollment.uses, 0, 'asking for the plan used nothing up');
    const wrong = await m.call('GET', '/connect/v1/plan', undefined, { authorization: `Bearer cpen_${'Z'.repeat(43)}` });
    assert.deepEqual([wrong.status, wrong.json.error.details.reason], [401, 'token_invalid']);
    await m.close();
  });
});

describe('the token-less commands (the Outdated chip)', () => {
  test('GET …/commands gives upgrade, uninstall and doctor with the latest token’s platform and options, and makes no token', async () => {
    const { realInstall } = await import('./installPort.js');
    const m = await openModule({ install: realInstall });
    const made = (await create(m, { options: { sudo: true } })).json.data;
    const before = (await m.admin('GET', '/targets/lab/enrollments')).json.data.length;
    const res = await m.admin('GET', CONNECT_API.commands('lab').replace('/api/connect', ''));
    assert.equal(res.status, 200);
    const cmds = res.json.data;
    assert.deepEqual(Object.keys(cmds).sort(), ['doctor', 'scriptSha256', 'scriptUrl', 'uninstall', 'upgrade']);
    assert.equal(cmds.upgrade, made.commands.upgrade, 'the same command the wizard showed');
    assert.match(cmds.upgrade, /^curl .*\| sudo env .*PILOT_TARGET=lab sh -s -- upgrade$/);
    assert.ok(!res.text.includes('PILOT_TOKEN') && !res.text.includes(made.token));
    assert.equal((await m.admin('GET', '/targets/lab/enrollments')).json.data.length, before, 'no token was made');
    const win = (await m.admin('GET', CONNECT_API.commands('lab', 'windows').replace('/api/connect', ''))).json.data;
    assert.match(win.upgrade, /install\.ps1\)\)\) upgrade$/);
    assert.equal((await m.admin('GET', '/targets/lab/commands?platform=beos')).status, 422);
    assert.equal((await m.admin('GET', '/targets/nope/commands')).status, 404);
    await m.close();
  });
});

describe('wrong tokens count once across plan, enroll and status', () => {
  test('six wrong plan requests and four wrong enrolls make ten: the next call of any of the three is 429', async () => {
    const { realInstall } = await import('./installPort.js');
    const m = await openModule({ install: realInstall });
    const made = (await create(m)).json.data;
    const ip = '192.0.2.99';
    const wrong = (i: number) => `cpen_${String(i).padStart(43, 'Y')}`;
    for (let i = 0; i < 6; i++) assert.equal((await m.call('GET', '/connect/v1/plan', undefined, { authorization: `Bearer ${wrong(i)}` }, ip)).status, 401);
    for (let i = 6; i < 10; i++) assert.equal((await enroll(m, wrong(i), { ip })).status, 401);
    assert.equal((await m.call('GET', '/connect/v1/plan', undefined, { authorization: `Bearer ${made.token}` }, ip)).status, 429, 'plan');
    assert.equal((await enroll(m, made.token, { ip })).status, 429, 'enroll');
    assert.equal((await m.call('GET', '/connect/v1/enroll/status', undefined, { authorization: `Bearer ${made.token}` }, ip)).status, 429, 'status');
    assert.equal((await m.call('GET', '/connect/v1/plan', undefined, { authorization: `Bearer ${made.token}` }, '192.0.2.100')).status, 200, 'another address is fine');
    await m.close();
  });
});

describe('authorization and the route table', () => {
  test('without a signed-in actor every admin route answers 401 and changes nothing', async () => {
    const m = await openModule({ signedIn: false });
    for (const [method, path] of [['GET', '/targets'], ['POST', '/targets'], ['GET', '/targets/lab'], ['DELETE', '/targets/lab'], ['PATCH', '/nodes/nd_000000000000'], ['GET', '/settings'], ['PUT', '/settings']] as const) {
      const r = await m.admin(method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
      assert.equal(r.status, 401, `${method} ${path}`);
    }
    assert.equal(m.connect.registry.targets().length, 0);
    await m.close();
  });

  test('a target the resolver does not know is 404 for a signed-in admin too (no such object)', async () => {
    const m = await openModule();
    assert.equal((await m.admin('GET', '/targets/nothing')).status, 404);
    assert.equal((await m.admin('GET', '/targets/docker/events')).status, 404, 'a scanned target has no events: it is not enrolled');
    await m.close();
  });

  test('every route this module mounts is declared (default deny needs a declaration for each)', async () => {
    const m = await openModule();
    const declared = declaredPolicies();
    const missing = m.app.routes
      .filter((r) => r.method !== 'ALL' || r.path === '/connect/*')
      .map((r) => `${r.method} ${r.path}`)
      .filter((key, i, all) => all.indexOf(key) === i)
      .filter((key) => !declared.has(key));
    assert.deepEqual(missing, [], 'routes without a declaration');
    await m.close();
  });
});

describe('canaries over HTTP', () => {
  test('the token is in the reply that made it and nowhere else: not in any later reply, the audit, or the store', async () => {
    const m = await openModule();
    const made = (await create(m)).json.data;
    const bodies: string[] = [];
    bodies.push((await enroll(m, made.token)).text);
    bodies.push((await enroll(m, made.token)).text);
    bodies.push((await enroll(m, `cpen_${'Q'.repeat(43)}`)).text);
    for (const path of ['/targets', '/targets/lab', '/targets/lab/enrollments', '/targets/lab/events?limit=500', '/settings']) bodies.push((await m.admin('GET', path)).text);
    bodies.push((await m.call('GET', '/connect/v1/enroll/status', undefined, { authorization: `Bearer ${made.token}` })).text);
    assert.ok(bodies.every((b) => !b.includes(made.token)), 'no reply repeats the token');
    assert.ok(bodies.every((b) => !b.includes('QQQQQ')), 'nor a wrong one');
    const rows = JSON.stringify(m.store.db!.prepare('SELECT * FROM connect_events').all());
    assert.ok(!rows.includes(made.token) && !rows.includes('QQQQQ'));
    await m.close();
  });
});
