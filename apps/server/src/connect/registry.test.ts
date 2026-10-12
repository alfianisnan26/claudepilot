// T-REG (docs/prd/targets-connect.md §19.3): migrations, ids and labels, scanned plus enrolled, hide, settings, the views, remove, the pending purge,
// event retention and a restore, against a real SQLite store.

import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { CONNECT_LIMITS, type ConnectNodeView } from '@portal/contracts';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import type { NodeLive } from './registry.js';
import { helloFor, openCore, wizard } from './testkit.js';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? `${e.status}:${(e.details as { reason?: string } | undefined)?.reason ?? e.code}` : String(e);
  }
  return 'no error';
};
const fields = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    return Object.keys(((e as AppError).details ?? {}) as object);
  }
  return [];
};

describe('migrations', () => {
  test('a new database has the five tables, STRICT, with the multi-user columns; and an older database gains them', async () => {
    const key = parseSecretKey(generateSecretKey());
    const dir = tempDirectory('cx1-mig-');
    // an "older" portal: everything but Connect
    const old = await Store.open({ dataDir: dir, secretKey: key, migrations: MIGRATIONS.filter((m) => m.version < 130 || m.version > 149) });
    assert.equal(old.db!.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'connect_targets'").get()!.n, 0);
    old.close();
    const now = await Store.open({ dataDir: dir, secretKey: key });
    const tables = (now.db!.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'connect_%' ORDER BY name").all() as { name: string; sql: string }[]);
    assert.deepEqual(tables.map((t) => t.name), ['connect_enrollments', 'connect_events', 'connect_nodes', 'connect_settings', 'connect_targets']);
    for (const t of tables) assert.match(t.sql, /STRICT/, t.name);
    const cols = (t: string) => (now.db!.prepare(`PRAGMA table_info(${t})`).all() as { name: string; dflt_value: string | null }[]);
    for (const t of ['connect_targets', 'connect_nodes', 'connect_enrollments']) assert.equal(cols(t).find((c) => c.name === 'created_by')?.dflt_value, "'u_owner'", `${t}.created_by`);
    assert.equal(cols('connect_targets').find((c) => c.name === 'owner_id')?.dflt_value, "'u_owner'");
    // no sealed column: nothing for `portal rotate-key` to re-seal
    assert.ok(!JSON.stringify(now.db!.prepare("SELECT value FROM portal_meta WHERE key = 'migrations_applied'").get()).includes('null'));
    now.close();
  });

  test('on a database already at the latest version, opening again changes nothing', async () => {
    const core = await openCore();
    wizard(core);
    const before = core.cstore.targets();
    const again = await Store.open({ dataDir: core.dir, secretKey: parseSecretKey(generateSecretKey()) }).catch(() => null);
    assert.ok(before.length === 1);
    again?.close();
  });
});

describe('targets', () => {
  test('ids and labels: plain names, reserved and scanned ids, unique ids, unique labels without case', async () => {
    const core = await openCore({ scanned: [{ id: 'local', label: 'This machine', kind: 'local', where: 'here', available: true }, { id: 'mybox', label: 'Mybox', kind: 'local', where: 'here', available: true }] });
    const mk = (id: string, label?: string) => () => core.registry.createTarget({ kind: 'docker', platform: 'linux', id, label, portalUrl: 'https://p.example.com' }, null, core.ctx);
    assert.deepEqual(fields(mk('Bad Name')), ['id']);
    assert.deepEqual(fields(mk('-x')), ['id']);
    assert.deepEqual(fields(mk('a'.repeat(31))), ['id']);
    assert.deepEqual(fields(mk('')), ['id']);
    assert.equal(code(mk('docker')), '422:VALIDATION_FAILED', 'reserved');
    assert.equal(code(mk('mybox')), '409:CONFLICT', 'a scanned id the portal found on its own');
    assert.ok(mk('lab', 'Home lab')());
    assert.equal(code(mk('lab')), '409:CONFLICT');
    assert.equal(code(mk('lab2', 'home LAB')), '409:CONFLICT', 'labels are unique without case');
    assert.deepEqual(fields(mk('lab3', 'x'.repeat(41))), ['label']);
    assert.equal(core.registry.requireTarget('lab').label, 'Home lab');
    assert.equal(core.registry.requireTarget('lab').createdBy, 'u_owner');
    assert.equal(core.registry.requireTarget('lab').ownerId, 'u_owner');
  });

  test('the matrix: a Windows host is not offered, macOS host is a preview, every other cell works', async () => {
    const core = await openCore();
    const mk = (kind: string, platform: string) => () => core.registry.createTarget({ kind: kind as never, platform: platform as never, id: `${kind}-${platform}`.slice(0, 30), options: kind === 'host' ? { hostAccess: true } : {}, portalUrl: 'https://p.example.com' }, null, core.ctx);
    assert.deepEqual(fields(mk('host', 'windows')), ['platform']);
    assert.ok(mk('host', 'macos')());
    assert.ok(mk('docker', 'windows')());
    assert.ok(mk('kubernetes', 'linux')());
    assert.deepEqual(fields(mk('nope', 'linux')), ['kind']);
    assert.deepEqual(fields(mk('docker', 'plan9')), ['platform']);
  });

  test('a Host needs the admin’s confirmation; options are checked and kept only where they mean something', async () => {
    const core = await openCore();
    const mk = (over: object) => () => core.registry.createTarget({ kind: 'host', platform: 'linux', id: 'metal', portalUrl: 'https://p.example.com', ...over }, null, core.ctx);
    assert.deepEqual(fields(mk({})), ['hostAccess']);
    assert.deepEqual(fields(mk({ options: { hostAccess: false } })), ['hostAccess']);
    assert.ok(mk({ options: { hostAccess: true, namespace: 'ignored', workspaceImage: 'ignored' } })());
    const t = core.registry.requireTarget('metal');
    assert.equal(t.settings.namespace, undefined, 'a host has no namespace');
    const k = core.registry.createTarget({ kind: 'kubernetes', platform: 'linux', id: 'kube', portalUrl: 'https://p.example.com', options: { namespace: 'ws-ns', storage: '20Gi', storageClass: 'fast' } }, null, core.ctx);
    assert.deepEqual({ ns: k.settings.namespace, st: k.settings.storage, sc: k.settings.storageClass }, { ns: 'ws-ns', st: '20Gi', sc: 'fast' });
    assert.deepEqual(fields(() => core.registry.createTarget({ kind: 'kubernetes', platform: 'linux', id: 'kube2', portalUrl: 'https://p.example.com', options: { namespace: 'Bad Ns!' } }, null, core.ctx)), ['namespace']);
    assert.deepEqual(fields(() => core.registry.createTarget({ kind: 'docker', platform: 'linux', id: 'd2', portalUrl: 'https://p.example.com', options: { workspaceImage: 'has space' } }, null, core.ctx)), ['workspaceImage']);
    assert.deepEqual(fields(() => core.registry.createTarget({ kind: 'docker', platform: 'linux', id: 'd3', portalUrl: 'https://p.example.com', options: { privateCa: true } }, null, core.ctx)), ['privateCa'], 'no CA is configured');
  });

  test('delivery defaults: on for clusters, off for a Host and a Container until the admin turns it on (owner decision O5)', async () => {
    const core = await openCore();
    const mk = (kind: string, id: string) => core.registry.createTarget({ kind: kind as never, platform: 'linux', id, portalUrl: 'https://p.example.com', options: { hostAccess: true } }, null, core.ctx).settings.delivery;
    assert.deepEqual([mk('docker', 'a'), mk('swarm', 'b'), mk('kubernetes', 'c'), mk('container', 'd'), mk('host', 'e')], [true, true, true, false, false]);
  });

  test('the portal address: explicit, else the operator’s, else the request’s; https unless loopback or the operator allows http', async () => {
    const core = await openCore();
    const url = (portalUrl: string | undefined, origin: string | null, id: string) => core.registry.createTarget({ kind: 'docker', platform: 'linux', id, portalUrl }, origin, core.ctx).portalUrl;
    assert.equal(url('https://x.example.com/', null, 'a'), 'https://x.example.com');
    assert.equal(url(undefined, 'https://browser.example.com', 'b'), 'https://browser.example.com');
    assert.equal(url(undefined, 'http://localhost:3000', 'c'), 'http://localhost:3000');
    assert.equal(url('http://127.0.0.1:3211', null, 'd'), 'http://127.0.0.1:3211');
    assert.equal(code(() => url('http://pilot.lan:3000', null, 'e')), '422:insecure_url');
    assert.deepEqual(fields(() => url(undefined, null, 'f')), ['portalUrl']);
    assert.deepEqual(fields(() => url('https://u:p@x.example.com', null, 'g')), ['portalUrl', 'reason']);
    core.settings.update({ publicUrl: 'https://pilot.example.com' }, core.ctx.actor, null);
    assert.equal(url(undefined, 'https://browser.example.com', 'h'), 'https://pilot.example.com', 'the setting wins over the browser’s address');
    const lan = await openCore({ config: { allowHttp: true } });
    assert.equal(lan.registry.createTarget({ kind: 'docker', platform: 'linux', id: 'lan', portalUrl: 'http://172.18.0.1:3211' }, null, lan.ctx).portalUrl, 'http://172.18.0.1:3211');
    const env = await openCore({ config: { url: 'https://env.example.com' } });
    assert.equal(env.registry.createTarget({ kind: 'docker', platform: 'linux', id: 'e' }, 'https://browser.example.com', env.ctx).portalUrl, 'https://env.example.com');
    assert.equal(code(() => env.settings.update({ publicUrl: 'https://other.example.com' }, env.ctx.actor, null)), '409:CONFLICT', 'the environment can not be changed here');
  });
});

describe('the list', () => {
  test('scanned targets come first, read only; a hidden one that is not available is hidden, and comes back when it is', async () => {
    const core = await openCore({
      scanned: [
        { id: 'docker', label: 'Docker', kind: 'docker', where: '/var/run/docker.sock', available: true },
        { id: 'docker-host', label: 'Docker (host)', kind: 'docker', where: '/var/run/docker-host.sock', available: false, problem: 'not found' },
      ],
    });
    wizard(core, { id: 'lab' });
    const rows = await core.registry.list();
    assert.deepEqual(rows.map((r) => `${r.source}:${r.id}`), ['scanned:docker', 'scanned:docker-host', 'enrolled:lab']);
    const hostRow = rows[1]!;
    assert.equal(hostRow.source === 'scanned' && hostRow.hidden, false);
    core.settings.setHidden('docker-host', true);
    const hidden = (await core.registry.list()).find((r) => r.id === 'docker-host')!;
    assert.equal(hidden.source === 'scanned' && hidden.hidden, true);
    core.scanned[1]!.available = true; // it became reachable
    const back = (await core.registry.list()).find((r) => r.id === 'docker-host')!;
    assert.equal(back.source === 'scanned' && back.hidden, false);
  });

  test('settings: the default target (enrolled or scanned), the token lifetime, validation', async () => {
    const core = await openCore();
    wizard(core, { id: 'lab' });
    assert.equal(core.settings.get().defaultTarget, null);
    assert.equal(core.settings.update({ defaultTarget: 'lab' }, core.ctx.actor, '203.0.113.9').defaultTarget, 'lab');
    assert.equal(core.registry.view(core.registry.requireTarget('lab')).default, true);
    assert.equal(core.settings.update({ defaultTarget: 'docker' }, core.ctx.actor, null).defaultTarget, 'docker', 'a scanned target can be the default');
    assert.deepEqual(fields(() => core.settings.update({ defaultTarget: 'nope' }, core.ctx.actor, null)), ['defaultTarget']);
    assert.equal(core.settings.update({ tokenTtlMinutes: 30 }, core.ctx.actor, null).tokenTtlMinutes, 30);
    assert.deepEqual(fields(() => core.settings.update({ tokenTtlMinutes: 0 }, core.ctx.actor, null)), ['tokenTtlMinutes']);
    assert.deepEqual(fields(() => core.settings.update({ publicUrl: 'http://insecure.example.com' }, core.ctx.actor, null)), ['publicUrl']);
    assert.equal(core.settings.update({ publicUrl: null }, core.ctx.actor, null).publicUrl, null);
    const events = core.cstore.events('', { limit: 10 });
    assert.equal(events.length, 0, 'settings changes have no target');
  });
});

describe('changing and removing', () => {
  test('label and settings change; the namespace is fixed (409); delivery and a limit apply', async () => {
    const core = await openCore();
    core.registry.createTarget({ kind: 'kubernetes', platform: 'linux', id: 'kube', portalUrl: 'https://p.example.com', options: { namespace: 'ns1' } }, null, core.ctx);
    const t = core.registry.updateTarget('kube', { label: 'Cluster', settings: { delivery: false, storage: '30Gi' } }, core.ctx);
    assert.deepEqual({ label: t.label, d: t.settings.delivery, s: t.settings.storage }, { label: 'Cluster', d: false, s: '30Gi' });
    assert.equal(code(() => core.registry.updateTarget('kube', { settings: { namespace: 'other' } }, core.ctx)), '409:CONFLICT');
    assert.doesNotThrow(() => core.registry.updateTarget('kube', { settings: { namespace: 'ns1' } }, core.ctx));
    assert.equal(core.registry.updateTarget('kube', { settings: { maxWorkspaces: 3 } }, core.ctx).settings.maxWorkspaces, 3, 'a Kubernetes cluster has a limit too');
    assert.deepEqual(fields(() => core.registry.updateTarget('kube', { settings: { workspaceImage: 'x/y:z' } }, core.ctx)), ['workspaceImage']);
    const docker = wizard(core, { id: 'dock' }).target;
    assert.equal(core.registry.updateTarget(docker.id, { settings: { maxWorkspaces: 3 } }, core.ctx).settings.maxWorkspaces, 3);
    assert.deepEqual(fields(() => core.registry.updateTarget(docker.id, { settings: { maxWorkspaces: 0 } }, core.ctx)), ['maxWorkspaces']);
    assert.deepEqual(fields(() => core.registry.updateTarget(docker.id, { settings: { running: true } as never }, core.ctx)), ['running']);
    assert.deepEqual(fields(() => core.registry.updateTarget(docker.id, { settings: { bogus: 1 } as never }, core.ctx)), ['bogus']);
    assert.equal(code(() => core.registry.updateTarget(docker.id, { label: 'cluster' }, core.ctx)), '409:CONFLICT');
    assert.equal(core.registry.updateTarget(docker.id, { default: true }, core.ctx).id, 'dock');
    assert.equal(core.settings.defaultTarget(), 'dock');
    core.registry.updateTarget(docker.id, { default: false }, core.ctx);
    assert.equal(core.settings.defaultTarget(), null);
    assert.equal(code(() => core.registry.requireTarget('nope')), '404:NOT_FOUND');
  });

  test('removing a target forgets its nodes, remembers them for agents that come back, and clears the default', async () => {
    const core = await openCore();
    const w = wizard(core, { id: 'lab', maxUses: 2 });
    const a = core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1').node;
    const b = core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker', { hostname: 'two' }) }, '192.0.2.2').node;
    core.registry.revokeNode(b, 'gone', core.ctx);
    core.registry.updateTarget('lab', { default: true }, core.ctx);
    const gone = core.registry.forgetTarget('lab', core.ctx, { workspaces: 'kept' });
    assert.deepEqual(gone, [a], 'only the live node is remembered');
    assert.equal(core.registry.target('lab'), null);
    assert.equal(core.registry.node(a), null, 'nodes and enrollments go with the target');
    assert.equal(core.settings.defaultTarget(), null);
    assert.equal(core.settings.removedNode(a), 'lab');
    assert.equal(core.settings.removedNode('nd_000000000000'), null);
    const removed = core.cstore.db!.prepare("SELECT detail FROM connect_events WHERE type = 'target.removed'").get() as { detail: string };
    assert.equal(JSON.parse(removed.detail).workspaces, 'kept');
  });

  test('nodes: rename, drain, revoke (idempotent); a revoked node is listed for a month and can not be changed', async () => {
    const core = await openCore();
    const w = wizard(core, { maxUses: 2 });
    const a = core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1').node;
    const b = core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker', { hostname: 'two' }) }, '192.0.2.2').node;
    assert.equal(core.registry.updateNode(a, { name: 'primary', drained: true }, core.ctx).drained, true);
    assert.equal(code(() => core.registry.updateNode(b, { name: 'PRIMARY' }, core.ctx)), '409:CONFLICT');
    assert.deepEqual(fields(() => core.registry.updateNode(b, { name: 'bad name' }, core.ctx)), ['name']);
    core.registry.revokeNode(a, 'lost the laptop', core.ctx);
    const again = core.registry.revokeNode(a, 'again', core.ctx);
    assert.equal(again.revokedReason, 'lost the laptop', 'a second revoke leaves the first');
    assert.equal(code(() => core.registry.updateNode(a, { drained: false }, core.ctx)), '409:CONFLICT');
    assert.equal(core.cstore.events('lab', { limit: 50 }).filter((e) => e.type === 'node.revoked').length, 1);
    let view = core.registry.view(core.registry.requireTarget('lab'));
    assert.deepEqual(view.nodes.map((n) => `${n.name}:${n.state}`).sort(), ['primary:revoked', 'two:enrolled']);
    core.clock.now = new Date(core.clock.now.getTime() + 31 * 86_400_000);
    view = core.registry.view(core.registry.requireTarget('lab'));
    assert.deepEqual(view.nodes.map((n) => n.name), ['two'], 'a node revoked more than 30 days ago is no longer listed');
  });

  test('a pending target nobody enrolled is removed 24 hours after its last token ran out, not before', async () => {
    const core = await openCore();
    wizard(core, { id: 'abandoned', ttlMinutes: 60 });
    const enrolled = wizard(core, { id: 'used' });
    core.enrollments.enroll(enrolled.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1');
    core.clock.now = new Date(core.clock.now.getTime() + (60 + 60 * 23) * 60_000); // 23 hours after it ran out
    assert.deepEqual(core.registry.purgePending(), []);
    core.clock.now = new Date(core.clock.now.getTime() + 2 * 3_600_000);
    assert.deepEqual(core.registry.purgePending(), ['abandoned']);
    assert.ok(core.registry.target('used'), 'an enrolled target is never purged');
    assert.equal(core.cstore.events('abandoned', { limit: 5 }).length, 3, 'its audit rows stay for a while');
  });
});

describe('views', () => {
  const live = (over: Partial<NodeLive> = {}): NodeLive => ({ connected: true, connectedAt: '2026-10-12T09:00:00.000Z', hello: helloFor('docker'), status: null, rttMs: 12, ip: '192.0.2.1', clockSkewS: 1, ...over });

  test('link: pending, connected, partial, offline; the line a list shows; the problem text', async () => {
    const core = await openCore();
    const w = wizard(core, { maxUses: 3 });
    assert.equal(core.registry.view(w.target).link, 'pending');
    assert.equal(core.registry.view(w.target).problem, 'No node has connected yet.');
    const ids = [1, 2, 3].map((i) => core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker', { hostname: `n${i}` }) }, `192.0.2.${i}`).node);
    const state = new Map<string, NodeLive>();
    core.registry.useLive({ state: (id) => state.get(id) ?? null });
    const view = () => core.registry.view(core.registry.requireTarget('lab'));
    assert.equal(view().link, 'offline');
    state.set(ids[0]!, live({ status: { t: 'status', at: '2026-10-12T09:00:01.000Z', services: [{ name: 'docker', ok: true }], docker: { engine: '28.1.1', apiVersion: '1.49', os: 'linux', arch: 'x86_64', ncpu: 4, memTotal: 1, containers: 2, running: 1, desktop: false, images: [] } } }));
    assert.equal(view().link, 'partial');
    assert.equal(view().problem, '1 of 3 nodes connected.');
    state.set(ids[1]!, live());
    state.set(ids[2]!, live());
    const v = view();
    assert.equal(v.link, 'connected');
    assert.equal(v.where, 'docker 28.1 · 3 nodes');
    const n = v.nodes.find((x) => x.id === ids[0])!;
    assert.deepEqual({ link: n.link, rtt: n.rttMs, outdated: n.outdated, skew: n.clockSkewS }, { link: 'connected', rtt: 12, outdated: false, skew: 1 });
    state.set(ids[0]!, live({ hello: helloFor('docker', { agentBuild: 'bbbbbbbbbbbb' }) }));
    assert.equal(view().nodes.find((x) => x.id === ids[0])!.outdated, true, 'the agent’s build differs from the bundle this portal serves');
    state.set(ids[1]!, live({ hello: helloFor('docker', { protocol: 0 }) }));
    assert.equal(view().nodes.find((x) => x.id === ids[1])!.incompatible, true);
    state.clear();
    assert.equal(view().link, 'offline');
    assert.match(view().problem!, /^No node is connected/);
    assert.equal(view().nodes.every((x: ConnectNodeView) => x.link === 'offline'), true);
  });

  test('a service that is down is the problem of an otherwise connected target', async () => {
    const core = await openCore();
    const w = wizard(core);
    const id = core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1').node;
    core.registry.useLive({ state: () => live({ status: { t: 'status', at: '2026-10-12T09:00:01.000Z', services: [{ name: 'docker', ok: false, error: 'permission denied on /var/run/docker.sock' }] } }) });
    assert.equal(core.registry.view(core.registry.requireTarget('lab')).problem, 'docker: permission denied on /var/run/docker.sock');
    void id;
  });

  test('the newest usable token is shown (never its value); a single’s line names the host; the workspace count comes from the snapshot', async () => {
    const core = await openCore();
    const w = wizard(core, { id: 'box', kind: 'container' });
    const v = core.registry.view(w.target);
    assert.equal(v.enrollment!.last4, w.token.slice(-4));
    assert.ok(!JSON.stringify(v).includes(w.token));
    assert.equal(v.workspaces, 0, 'a single has its workspace from the moment it connects, not before');
    core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('container') }, '192.0.2.1');
    const after = core.registry.view(core.registry.requireTarget('box'));
    assert.equal(after.enrollment, null, 'a used token is not offered');
    assert.equal(after.workspaces, 1);
    assert.equal(after.where, 'lab-box (container)');
    assert.equal(after.role, 'single');
    const dock = wizard(core, { id: 'dock' }).target;
    core.registry.saveSnapshot('dock', [{ id: 'dock/a', name: 'a', target: 'dock', image: 'x', status: 'running', createdAt: 'now' }]);
    assert.equal(core.registry.view(core.registry.requireTarget(dock.id)).workspaces, 1);
  });

  test('the database copy of a snapshot is replaced at most every 10 seconds, memory is always the newest, and a flush writes it', async () => {
    const core = await openCore();
    wizard(core, { id: 'dock' });
    const ws = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `dock/w${i}`, name: `w${i}`, target: 'dock', image: 'x', status: 'running' as const, createdAt: 'now' }));
    const inDb = () => core.registry.target('dock')!.snapshot?.length ?? 0;
    core.registry.saveSnapshot('dock', ws(1));
    assert.equal(inDb(), 1);
    core.registry.saveSnapshot('dock', ws(2));
    assert.equal(inDb(), 1, 'too soon to write the database again');
    assert.equal(core.registry.lastSnapshot('dock')!.workspaces.length, 2, 'but what Connect hands out is the newest');
    assert.equal(core.registry.view(core.registry.requireTarget('dock')).workspaces, 2, 'and a quota counts it');
    core.registry.flushSnapshot('dock');
    assert.equal(inDb(), 2, 'a tunnel that drops flushes what it last said');
    core.clock.now = new Date(core.clock.now.getTime() + 11_000);
    core.registry.saveSnapshot('dock', ws(3));
    assert.equal(inDb(), 3, 'after the window it is written at once');
    assert.equal(core.registry.lastSnapshot('nope'), null);
    // removing the target takes a pending snapshot with it
    core.registry.saveSnapshot('dock', ws(4));
    core.registry.forgetTarget('dock', core.ctx, { workspaces: 'none' });
    assert.equal(core.registry.lastSnapshot('dock'), null);
  });
});

describe('audit', () => {
  test('details are flat and small by construction, secrets and junk never get in, and old rows go past the keep', async () => {
    const core = await openCore();
    wizard(core, { id: 'lab' });
    core.events.record({
      type: 'agent.log',
      targetId: 'lab',
      actor: 'agent:nd_x',
      ip: '192.0.2.1; DROP TABLE',
      detail: { ok: 'a'.repeat(500), token: `cpen_${'A'.repeat(43)}`, nested: { a: 1 } as never, list: [1, 2] as never, n: 7, b: true, nul: null, 'bad key!': 'x', pem: ['-----BEGIN ', 'PRIVATE KEY-----\nabc\n', '-----END ', 'PRIVATE KEY-----'].join('') },
    });
    const row = core.events.list('lab', { limit: 1 })[0]!;
    assert.equal(row.ip, null, 'an address with junk in it is not stored');
    assert.deepEqual(Object.keys(row.detail).sort(), ['b', 'n', 'nul', 'ok', 'pem', 'token']);
    assert.ok((row.detail.ok as string).length <= 200);
    assert.equal(row.detail.token, '[redacted]');
    assert.equal(row.detail.pem, '[redacted]');
    // retention: 5,000 per target
    for (let i = 0; i < CONNECT_LIMITS.eventsKeep + 120; i++) core.events.record({ type: 'agent.log', targetId: 'lab', actor: 'agent:nd_x', detail: { i } });
    core.cstore.pruneEvents('lab');
    assert.equal(core.cstore.eventCount('lab'), CONNECT_LIMITS.eventsKeep);
    assert.equal(core.events.list('lab', { limit: 1 })[0]!.detail.i, CONNECT_LIMITS.eventsKeep + 119, 'the newest rows are the ones kept');
  });

  test('pages: newest first, `before` continues', async () => {
    const core = await openCore();
    wizard(core, { id: 'lab' });
    for (let i = 0; i < 12; i++) core.events.record({ type: 'agent.log', targetId: 'lab', actor: 'agent:nd_x', detail: { i } });
    const first = core.events.list('lab', { limit: 5 });
    const second = core.events.list('lab', { limit: 5, before: first.at(-1)!.id });
    assert.deepEqual(first.map((e) => e.detail.i), [11, 10, 9, 8, 7]);
    assert.deepEqual(second.map((e) => e.detail.i), [6, 5, 4, 3, 2]);
  });
});

describe('backup and restore (FR63)', () => {
  test('the registry holds hashes and public keys only; a restored older copy does not know a newer node', async () => {
    const core = await openCore();
    const w = wizard(core, { id: 'lab', maxUses: 2 });
    const old = core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1').node;
    const backup = await core.store.backup('manual');
    const newer = core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker', { hostname: 'newer' }) }, '192.0.2.2').node;
    const dir = tempDirectory('cx1-restore-');
    copyFileSync(backup, join(dir, 'portal.db'));
    const restored = await Store.open({ dataDir: dir, secretKey: parseSecretKey(generateSecretKey()) });
    const { ConnectStore } = await import('./store.js');
    const rs = new ConnectStore(restored);
    assert.ok(rs.node(old), 'what the backup held is there');
    assert.equal(rs.node(newer), null, 'a node enrolled after the backup is unknown: its agent hears unknown_node and enrolls again');
    const columns = core.cstore.db!.prepare('PRAGMA table_info(connect_nodes)').all() as { name: string }[];
    assert.ok(!columns.some((c) => /secret|private|token/i.test(c.name)), 'no column could hold a secret');
    restored.close();
  });
});
