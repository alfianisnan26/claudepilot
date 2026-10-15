// T-515: when the Kubernetes API was slow (k3s-master out of memory, 2026-10-15 08:03-08:09 UTC), GET /api/workspaces answered [] and the
// owner saw no workspace and no Claudes. A target whose list fails or times out must keep its last good workspaces, each `unavailable`
// with a short redacted reason and the time of that answer; its Claudes stay listed; the other targets still answer; a portal restarted
// during the outage lists them too (the last good lists are on disk); the list recovers by itself on the next good answer.
//
// The Kubernetes API is the in-process fake (connect/agent/testkit/fakeKube.ts) with every request held unanswered: no cluster, no kubeconfig.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Workspace, WorkspaceClaude, WorkspaceClaudeState, WorkspaceTarget } from '@portal/contracts';
import { createApp } from '../app.js';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import { JsonFile } from '../jsonFile.js';
import { Portal } from '../portal.js';
import { kubeRuntimeOn } from './kubeTestkit.js';
import { Workspaces, type LastKnownLists } from './manager.js';
import type { Runtime } from './runtime.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Answers every property, call and construction with itself: enough for createApp to wire its routes (as in qa/auth.test.ts). */
const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const CODE = '24681357';

/** The chat controller: the stub, except for the store's Claudes of a workspace. */
function chatWith(claudes: Record<string, WorkspaceClaude[]>): object {
  return new Proxy(stub, {
    get: (t, p) => (p === 'claudesOf' ? async (id: string) => claudes[id] ?? [] : Reflect.get(t, p)),
    set: () => true,
  });
}

/** A Docker-like target that always answers. */
function dockerLike(workspaces: Workspace[]): Runtime {
  const target: Omit<WorkspaceTarget, 'available' | 'problem'> = { id: 'docker', label: 'Docker', kind: 'docker', where: '/var/run/docker.sock' };
  return { target, check: async () => undefined, list: async () => workspaces } as unknown as Runtime;
}

const pendingFile = { read: () => [] as Workspace[], write: () => undefined } as unknown as JsonFile<Workspace[]>;
const timing = { ttlMs: 40, timeoutMs: 150, listTimeoutMs: 150 };

function portalOn(ws: Workspaces, claudes: Record<string, WorkspaceClaude[]>) {
  const portal = new Portal(CODE, 60_000);
  const app = make(portal, ws, stub, stub, stub, stub, stub, chatWith(claudes), { serveWeb: false, poolService: stub, mcp: stub, skills: stub });
  const cookie = `portal_session=${portal.signIn(CODE)}`;
  const get = async <T>(path: string): Promise<{ status: number; data: T; ms: number }> => {
    const t = Date.now();
    const res = await app.request(`http://localhost:3000${path}`, { method: 'GET', headers: { host: 'localhost:3000', cookie } });
    const body = (await res.json()) as { data: T };
    return { status: res.status, data: body.data, ms: Date.now() - t };
  };
  return { get };
}

const byId = (list: Workspace[]) => new Map(list.map((w) => [w.id, w]));

test('a Kubernetes API that stops answering keeps its workspaces listed as unavailable, with their Claudes, and the list recovers by itself', async () => {
  const fake = await FakeKube.start();
  const dir = mkdtempSync(join(tmpdir(), 't515-'));
  try {
    await kubeRuntimeOn(fake, undefined, { targetId: 'kubernetes' }).create({ name: 'kohi' }, () => undefined);
    const docker = dockerLike([{ id: 'docker/dev', name: 'dev', target: 'docker', image: 'img', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' }]);
    const lastKnown = new JsonFile<LastKnownLists>(join(dir, 'last-known-workspaces.json'), {});
    const claude: WorkspaceClaude = { id: 'c1', workspaceId: 'kubernetes/kohi', name: 'Default', directory: '', removedAt: null, createdAt: '2026-01-01T00:00:00.000Z' };
    const claudes = { 'kubernetes/kohi': [claude] };
    const ws = new Workspaces([kubeRuntimeOn(fake, undefined, { targetId: 'kubernetes' }), docker], pendingFile, timing, undefined, lastKnown);
    const { get } = portalOn(ws, claudes);

    // A good answer: both targets, kohi running; its last good list is on disk.
    const before = await get<Workspace[]>('/api/workspaces');
    assert.equal(before.status, 200);
    assert.equal(byId(before.data).get('kubernetes/kohi')?.status, 'running');
    assert.equal(byId(before.data).get('docker/dev')?.status, 'running');
    assert.deepEqual(Object.keys(lastKnown.read()).sort(), ['docker', 'kubernetes']);
    const seenAt = lastKnown.read().kubernetes!.at;

    // The API stops answering: the request still answers in time, kohi is there as unavailable with the reason and the last good time.
    fake.stalled = true;
    await sleep(60); // past the check's TTL
    const during = await get<Workspace[]>('/api/workspaces');
    assert.equal(during.status, 200);
    assert.ok(during.ms < 1_000, `the list answered in ${during.ms} ms`);
    const kohi = byId(during.data).get('kubernetes/kohi');
    assert.ok(kohi, 'kubernetes/kohi is still listed');
    assert.equal(kohi.status, 'unavailable');
    assert.match(kohi.detail ?? '', /Timed out/);
    assert.ok(kohi.lastSeenAt && Date.parse(kohi.lastSeenAt) >= Date.parse(seenAt), 'lastSeenAt is the last good answer');
    assert.ok(kohi.stableId?.startsWith('ws_'), 'it keeps its identity');
    assert.equal(byId(during.data).get('docker/dev')?.status, 'running', 'the other target still answers');

    // Asked again while the check itself times out: still listed, still unavailable.
    await sleep(200);
    const later = await get<Workspace[]>('/api/workspaces');
    assert.equal(byId(later.data).get('kubernetes/kohi')?.status, 'unavailable');
    assert.ok(later.ms < 1_000, `the list answered in ${later.ms} ms`);

    // Its Claudes stay listed, from the store, without waiting for the API (sign-in unknown).
    const cl = await get<WorkspaceClaudeState[]>('/api/workspaces/kubernetes/kohi/claudes');
    assert.equal(cl.status, 200);
    assert.ok(cl.ms < 1_000, `the Claudes answered in ${cl.ms} ms`);
    assert.deepEqual(cl.data.map((s) => [s.claude.name, s.auth, s.terminals]), [['Default', null, 0]]);

    // One workspace by its alias answers as listed; one that does not exist is the same 404 as before.
    assert.equal((await get<Workspace>('/api/workspaces/kubernetes/kohi')).data.status, 'unavailable');
    assert.equal((await get<unknown>('/api/workspaces/kubernetes/nope')).status, 404);

    // A portal restarted during the outage: the last good list comes from disk.
    const restarted = new Workspaces([kubeRuntimeOn(fake, undefined, { targetId: 'kubernetes' }), docker], pendingFile, timing, undefined, lastKnown);
    const afterRestart = await portalOn(restarted, claudes).get<Workspace[]>('/api/workspaces');
    assert.equal(byId(afterRestart.data).get('kubernetes/kohi')?.status, 'unavailable');
    assert.equal(byId(afterRestart.data).get('kubernetes/kohi')?.lastSeenAt, lastKnown.read().kubernetes!.at);
    assert.equal(byId(afterRestart.data).get('docker/dev')?.status, 'running');

    // The API answers again: the list recovers by itself, no restart and no action.
    fake.stalled = false;
    let recovered: Workspace | undefined;
    for (let i = 0; i < 40 && recovered?.status !== 'running'; i++) {
      await sleep(50);
      recovered = byId((await get<Workspace[]>('/api/workspaces')).data).get('kubernetes/kohi');
    }
    assert.equal(recovered?.status, 'running', 'kohi is running again');
    assert.equal(recovered?.lastSeenAt, undefined);
    assert.equal(ws.isUnavailable('kubernetes'), false);
  } finally {
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the reason shown never carries a credential or a URL, and stays one short line', async () => {
  // Built at run time: no token-shaped literal in the repository.
  const secret = ['Zq', '9x', 'Lm', '4T'].join('').repeat(6);
  const message = `Get "https://10.43.0.1:6443/api/v1/namespaces/x/pods?token=${secret}": net/http: TLS handshake timeout\nAuthorization: Bearer ${secret}\n${'x'.repeat(400)}`;
  // A list that fails with that message lists the workspace with a clean, short reason only.
  let fail = false;
  const kube = {
    target: { id: 'kubernetes', label: 'Kubernetes', kind: 'kubernetes', where: 'ns' },
    check: async () => undefined,
    list: async () => {
      if (fail) throw new Error(message);
      return [{ id: 'kubernetes/kohi', name: 'kohi', target: 'kubernetes', image: 'img', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' }];
    },
  } as unknown as Runtime;
  const ws = new Workspaces([kube], pendingFile, timing);
  assert.equal((await ws.list())[0]?.status, 'running');
  fail = true;
  const [kohi] = await ws.list();
  assert.equal(kohi?.status, 'unavailable');
  assert.ok(!JSON.stringify(kohi).includes(secret), 'the token is nowhere in the workspace');
  const reason = kohi?.detail ?? '';
  assert.ok(!reason.includes('10.43.0.1'), 'the URL is gone');
  assert.ok(!reason.includes('\n'));
  assert.ok(reason.length <= 160, `${reason.length} characters`);
  assert.match(reason, /TLS handshake timeout/);
});

test('a target that never answered lists nothing (no guess), and the others still answer', async () => {
  const fake = await FakeKube.start();
  try {
    fake.stalled = true;
    const docker = dockerLike([{ id: 'docker/dev', name: 'dev', target: 'docker', image: 'img', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' }]);
    const ws = new Workspaces([kubeRuntimeOn(fake, undefined, { targetId: 'kubernetes' }), docker], pendingFile, timing);
    const t = Date.now();
    const list = await ws.list();
    assert.ok(Date.now() - t < 1_000);
    assert.deepEqual(list.map((w) => [w.id, w.status]), [['docker/dev', 'running']]);
  } finally {
    await fake.stop();
  }
});

test('the last good lists are written when they change, not on every page load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't515-'));
  try {
    const path = join(dir, 'last.json');
    let writes = 0;
    const file = new JsonFile<LastKnownLists>(path, {});
    const counting = { read: () => file.read(), write: (v: LastKnownLists) => (writes++, file.write(v)) } as unknown as JsonFile<LastKnownLists>;
    const list: Workspace[] = [{ id: 'docker/dev', name: 'dev', target: 'docker', image: 'img', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' }];
    const ws = new Workspaces([dockerLike(list)], pendingFile, timing, undefined, counting);
    for (let i = 0; i < 5; i++) await ws.list();
    assert.equal(writes, 1);
    list[0] = { ...list[0]!, status: 'stopped' };
    await ws.list();
    assert.equal(writes, 2);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as LastKnownLists).docker?.workspaces[0]?.status, 'stopped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
