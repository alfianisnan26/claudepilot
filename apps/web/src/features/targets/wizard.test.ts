import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectEnrollment, ConnectNodeView, ConnectTargetView } from '@portal/contracts';
import { kindsOf } from './kinds';
import { canAddNode, formProblems, initialForm, offersSudo, platformChoices, platformFromUserAgent, toCreateRequest, withKind, withPlatform, withRole } from './wizard';
import { enrollmentLive, reachableLine, rowLine } from './view';

const ctx = { taken: ['docker', 'lab'], allowHttp: false };
const form = () => ({ ...initialForm('Mozilla/5.0 (X11; Linux x86_64)', ''), id: 'my-server' });

test('platform preselected from the browser', () => {
  assert.equal(platformFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(platformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'macos');
  assert.equal(platformFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'linux');
  assert.equal(platformFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
});

test('role switch keeps a kind that fits and resets the rest', () => {
  const f = withRole(form(), 'single');
  assert.equal(f.kind, 'container');
  assert.deepEqual(kindsOf('single').map((k) => k.kind), ['container', 'host']);
  assert.equal(withRole(withKind(f, 'host'), 'cluster').kind, 'docker');
});

test('host needs the acknowledgement; its platform cell for Windows is closed', () => {
  const host = withKind(withRole(form(), 'single'), 'host');
  assert.equal(formProblems(host, ctx).hostAccess, 'Confirm to continue.');
  assert.equal(formProblems({ ...host, hostAccess: true }, ctx).hostAccess, undefined);
  const win = platformChoices('host').find((p) => p.value === 'windows')!;
  assert.equal(win.disabled, true);
  assert.match(platformChoices('host').find((p) => p.value === 'macos')!.label, /Preview/);
  assert.ok(formProblems(withPlatform({ ...host, hostAccess: true }, 'windows'), ctx).platform);
});

test('name and address problems', () => {
  assert.ok(formProblems({ ...form(), id: '' }, ctx).id);
  assert.ok(formProblems({ ...form(), id: 'Docker' }, ctx).id);
  assert.equal(formProblems({ ...form(), id: 'lab' }, ctx).id, 'That name is in use.');
  assert.ok(formProblems({ ...form(), portalUrl: 'http://portal.example.com' }, ctx).portalUrl);
  assert.equal(formProblems({ ...form(), portalUrl: 'http://portal.example.com' }, { ...ctx, allowHttp: true }).portalUrl, undefined);
  assert.equal(formProblems({ ...form(), portalUrl: 'https://portal.example.com' }, ctx).portalUrl, undefined);
  assert.ok(formProblems({ ...form(), ttlMinutes: '0' }, ctx).ttlMinutes);
  assert.deepEqual(formProblems(form(), ctx), {});
});

test('request carries only what applies', () => {
  assert.deepEqual(toCreateRequest(form()), { kind: 'docker', platform: 'linux', id: 'my-server' });
  assert.deepEqual(toCreateRequest({ ...form(), sudo: true, nodeName: 'n1', ttlMinutes: '30', portalUrl: 'https://p.example.com/' }), {
    kind: 'docker',
    platform: 'linux',
    id: 'my-server',
    portalUrl: 'https://p.example.com',
    options: { sudo: true, nodeName: 'n1' },
    ttlMinutes: 30,
  });
  // sudo is a Linux Docker-kind option; namespace is Kubernetes only.
  const mac = withPlatform({ ...form(), sudo: true }, 'macos');
  assert.equal(offersSudo(mac), false);
  assert.equal(toCreateRequest(mac).options, undefined);
  const k8s = withKind({ ...form(), namespace: 'ns', storageClass: 'fast', nodeName: 'x' }, 'kubernetes');
  assert.deepEqual(toCreateRequest(k8s).options, { namespace: 'ns', storageClass: 'fast' });
  const host = { ...withKind(withRole(form(), 'single'), 'host'), hostAccess: true };
  assert.deepEqual(toCreateRequest(host).options, { hostAccess: true });
});

test('Add node is for Docker and Swarm', () => {
  assert.deepEqual((['docker', 'swarm', 'kubernetes', 'container', 'host'] as const).filter(canAddNode), ['docker', 'swarm']);
});

const node = (o: Partial<ConnectNodeView>): ConnectNodeView => ({ id: 'nd_1', targetId: 't', name: 'n', state: 'enrolled', link: 'connected', lastSeenAt: null, ...o }) as ConnectNodeView;
const target = (o: Partial<ConnectTargetView>): ConnectTargetView =>
  ({ source: 'enrolled', id: 't', label: 't', kind: 'docker', role: 'cluster', state: 'active', link: 'connected', where: '', nodes: [], settings: {}, workspaces: 0, default: false, enrollment: null, ...o }) as ConnectTargetView;
const enrollment = (o: Partial<ConnectEnrollment>): ConnectEnrollment => ({ id: 'en_1', state: 'waiting', expiresAt: new Date(Date.now() + 60_000).toISOString(), ...o }) as ConnectEnrollment;

test('live line: waiting, connected, expired, revoked, removed', () => {
  const now = Date.now();
  assert.deepEqual(enrollmentLive(target({}), enrollment({}), [], now), { state: 'waiting', enrolled: false });
  assert.equal(enrollmentLive(target({ nodes: [node({})] }), enrollment({ state: 'used' }), [], now).state, 'connected');
  // Add node: the node that was already there does not count.
  assert.equal(enrollmentLive(target({ nodes: [node({})] }), enrollment({}), ['nd_1'], now).state, 'waiting');
  assert.equal(enrollmentLive(target({ nodes: [node({}), node({ id: 'nd_2' })] }), enrollment({}), ['nd_1'], now).state, 'connected');
  assert.equal(enrollmentLive(target({}), enrollment({ expiresAt: new Date(now - 1).toISOString() }), [], now).state, 'expired');
  assert.equal(enrollmentLive(target({}), enrollment({ state: 'expired' }), [], now).state, 'expired');
  assert.equal(enrollmentLive(target({}), enrollment({ state: 'revoked' }), [], now).state, 'revoked');
  assert.equal(enrollmentLive(null, null, [], now).state, 'removed');
  // A revoked node does not count as connected.
  assert.equal(enrollmentLive(target({ nodes: [node({ state: 'revoked' })] }), enrollment({}), [], now).state, 'waiting');
});

test('row lines follow the PRD table', () => {
  const now = Date.parse('2026-10-12T10:00:00Z');
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  assert.equal(rowLine(target({ nodes: [node({}), node({ id: 'nd_2' })], workspaces: 5 }), now), 'Docker · 2 nodes · 5 workspaces');
  assert.equal(rowLine(target({ link: 'offline', nodes: [node({ link: 'offline', lastSeenAt: ago(3) })] }), now), 'Offline · 3 minutes ago');
  assert.equal(rowLine(target({ link: 'pending' }), now), 'Waiting for the connector');
  assert.equal(rowLine(target({ kind: 'host', role: 'single', workspaces: 1 }), now), 'Host · 1 workspace');
  assert.equal(rowLine({ source: 'scanned', id: 'docker', label: 'Docker', kind: 'docker', where: '/var/run/docker.sock', available: true, hidden: false }, now), 'Scanned · /var/run/docker.sock');
  assert.equal(
    rowLine(target({ link: 'partial', nodes: [node({}), node({ id: 'nd_2', link: 'offline' }), node({ id: 'nd_3', link: 'offline' })], workspaces: 2 }), now),
    'Docker · 1 of 3 nodes · 2 workspaces',
  );
});

test('reachable line counts connected, partial and available scanned', () => {
  const rows = [target({}), target({ link: 'offline' }), target({ link: 'partial' }), { source: 'scanned', id: 'k', label: 'k', kind: 'kubernetes', where: '', available: false, hidden: false } as const];
  assert.equal(reachableLine(rows), '2 of 4 reachable');
});
