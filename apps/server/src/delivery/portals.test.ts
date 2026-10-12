import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { SETTING_KEYS } from '@portal/contracts';
import type Docker from 'dockerode';
import { memoryWorkspace } from '../secrets/testkit.js';
import { SettingsModule } from '../settings/index.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { DockerRuntime } from '../workspaces/docker.js';
import { LABEL } from '../workspaces/runtime.js';
import { Reconciler, type FragmentProvider } from './reconciler.js';
import { MANIFEST_PATH, type Manifest } from './types.js';

// Two portals on one Docker daemon (agents' scratch portals, a dev portal beside the deployed one) must never touch
// each other's workspaces: a portal with "Pool MCP only" on once wrote its lockdown into ANOTHER portal's brand-new
// container, before the owner's first manifest existed. Containers carry the id of the portal that created them;
// a portal skips the ones that carry another's, and never writes the first manifest of one. Containers without the
// label (made before it existed) stay adoptable.

const WS = 'docker/ws1';
const DROP_IN = '/etc/claude-code/managed-settings.d/05-claudepilot-settings.json';

/** A portal: its own store (so its own id), the settings module with a global lockdown on, and a reconciler on the shared fake runtime. */
async function portal(runtime: ReturnType<typeof memoryWorkspace>, lockdown = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-portals-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const settings = new SettingsModule(store, providers);
  if (lockdown) settings.settings.set(SETTING_KEYS.mcpPoolOnly, true, { actor: 'it' });
  const reconciler = new Reconciler(store, () => runtime.runtime, () => [runtime.runtime], providers);
  const done = () => (reconciler.stop(), store.close(), rmSync(dataDir, { recursive: true, force: true }));
  return { store, id: store.portalId!, reconciler, done };
}
const written = (ws: ReturnType<typeof memoryWorkspace>) => ws.files.has(DROP_IN) || ws.files.has(MANIFEST_PATH) || ws.puts.length > 0;
const manifestOf = (ws: ReturnType<typeof memoryWorkspace>) => JSON.parse(ws.files.get(MANIFEST_PATH)?.content ?? 'null') as Manifest | null;

test('a workspace another portal created is never read or written by this one, the first manifest and a global lockdown included', async () => {
  const ws = memoryWorkspace();
  const a = await portal(ws, true);
  const b = await portal(ws, true);
  try {
    assert.notEqual(a.id, b.id);
    // A creates the workspace (the label is set at creation); B, with its lockdown on, is asked to deliver to it.
    ws.state.portal = a.id;
    await b.reconciler.request(WS, 'started');
    assert.equal(written(ws), false, 'nothing of B’s was written, no manifest either');
    assert.equal(b.reconciler.row(WS), null, 'B keeps no state for it');
    assert.equal(ws.scripts.length, 0, 'not even a script ran in it');

    // A row from before the label existed is marked rather than left looking healthy.
    b.store.db!.prepare("INSERT INTO workspace_delivery (workspace_id, generation, status, checked_at) VALUES (?, 0, 'synced', ?)").run(WS, new Date().toISOString());
    await b.reconciler.request(WS, 'timer');
    assert.deepEqual([b.reconciler.row(WS)?.status, b.reconciler.row(WS)?.reason], ['frozen', 'Created by another portal.']);
    assert.equal(written(ws), false);

    // The owner delivers as usual: its manifest names it, and B's lockdown is not there.
    await a.reconciler.request(WS, 'started');
    assert.equal(manifestOf(ws)?.portalId, a.id);
    assert.equal(a.reconciler.row(WS)?.status, 'synced', a.reconciler.row(WS)?.reason ?? '');
    assert.equal(ws.files.has(DROP_IN), true, 'A’s own lockdown is in');
    const before = ws.scripts.length;
    await b.reconciler.request(WS, 'timer');
    assert.equal(ws.scripts.length, before, 'B still touches nothing');
  } finally {
    a.done();
    b.done();
  }
});

test('a workspace made before the label existed stays adoptable, and one labelled with this portal’s own id is delivered to as usual', async () => {
  const legacy = memoryWorkspace();
  const mine = memoryWorkspace();
  const a = await portal(legacy, true);
  const b = await portal(mine, true);
  try {
    // No label: this portal may write the first manifest (the workspace is adoptable).
    legacy.state.portal = null;
    await a.reconciler.request(WS, 'started');
    assert.equal(manifestOf(legacy)?.portalId, a.id);
    assert.equal(legacy.files.has(DROP_IN), true);
    // Another portal arriving after that finds a manifest that isn't its own: the existing freeze, not a write.
    const second = memoryWorkspace();
    second.files.set(MANIFEST_PATH, legacy.files.get(MANIFEST_PATH)!);
    const c = await portal(second, true);
    try {
      await c.reconciler.request(WS, 'started');
      assert.match(c.reconciler.row(WS)?.reason ?? '', /Set up by another portal/);
    } finally {
      c.done();
    }

    mine.state.portal = b.id;
    await b.reconciler.request(WS, 'started');
    assert.equal(manifestOf(mine)?.portalId, b.id);
    assert.equal(mine.files.has(DROP_IN), true);
  } finally {
    a.done();
    b.done();
  }
});

/* ---------- The Docker runtime ---------- */

/** Just enough of a Docker client for the runtime's list, create, inspect and events, with every container carrying labels. */
function fakeDocker() {
  const containers: { Id: string; Names: string[]; Image: string; State: string; Status: string; Created: number; Labels: Record<string, string> }[] = [];
  const created: { Labels: Record<string, string> }[] = [];
  const events = new PassThrough();
  const client = {
    listContainers: async (opts: { filters?: { label?: string[]; name?: string[] } }) => {
      const wanted = opts.filters?.label ?? [];
      const name = opts.filters?.name?.[0];
      return containers.filter((c) => wanted.every((l) => c.Labels[l.split('=')[0]!] === l.split('=')[1]) && (!name || c.Names.some((n) => new RegExp(name).test(n))));
    },
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async (spec: { name: string; Labels: Record<string, string> }) => {
      created.push(spec);
      containers.push({ Id: spec.name, Names: [`/${spec.name}`], Image: 'img', State: 'running', Status: 'Up', Created: 1, Labels: spec.Labels });
      return { start: async () => undefined };
    },
    getContainer: (name: string) => ({
      inspect: async () => {
        const c = containers.find((x) => x.Names.includes(`/${name}`));
        if (!c) throw Object.assign(new Error('no such container'), { statusCode: 404 });
        return { State: { Running: true }, Config: { Labels: c.Labels } };
      },
    }),
    getEvents: (_opts: unknown, cb: (err: Error | null, stream?: NodeJS.ReadableStream) => void) => cb(null, events),
  };
  return { client: client as unknown as Docker, containers, created, events };
}

test('the Docker runtime labels what it creates with its portal’s id, lists its own and unlabelled workspaces only, and ignores another portal’s events', async () => {
  const f = fakeDocker();
  const base = { Image: 'img', State: 'running', Status: 'Up', Created: 1 };
  f.containers.push(
    { Id: '1', Names: ['/claudepilot-mine'], ...base, Labels: { [LABEL.managed]: 'true', [LABEL.name]: 'mine', [LABEL.portal]: 'portal-a' } },
    { Id: '2', Names: ['/claudepilot-theirs'], ...base, Labels: { [LABEL.managed]: 'true', [LABEL.name]: 'theirs', [LABEL.portal]: 'portal-b' } },
    { Id: '3', Names: ['/claudepilot-old'], ...base, Labels: { [LABEL.managed]: 'true', [LABEL.name]: 'old' } },
  );
  const a = new DockerRuntime({ id: 'docker', label: 'Docker', socket: '/nope' }, 'img', '.', () => 'portal-a', f.client);
  assert.deepEqual((await a.list()).map((w) => w.name).sort(), ['mine', 'old'], 'another portal’s workspace is not listed');
  const b = new DockerRuntime({ id: 'docker', label: 'Docker', socket: '/nope' }, 'img', '.', () => 'portal-b', f.client);
  assert.deepEqual((await b.list()).map((w) => w.name).sort(), ['old', 'theirs']);
  // A portal that doesn't know its own id can't tell: it lists everything, and labels nothing.
  const unknown = new DockerRuntime({ id: 'docker', label: 'Docker', socket: '/nope' }, 'img', '.', () => null, f.client);
  assert.equal((await unknown.list()).length, 3);

  await a.create({ name: 'fresh' }, () => undefined);
  assert.equal(f.created.at(-1)!.Labels[LABEL.portal], 'portal-a');
  assert.equal(f.created.at(-1)!.Labels[LABEL.managed], 'true');
  await unknown.create({ name: 'unlabelled' }, () => undefined);
  assert.equal(LABEL.portal in f.created.at(-1)!.Labels, false);

  // What delivery asks of a workspace: whether it exists and which portal made it.
  assert.deepEqual(await a.delivery.state('theirs'), { exists: true, running: true, portal: 'portal-b' });
  assert.deepEqual(await a.delivery.state('old'), { exists: true, running: true, portal: null });
  assert.equal((await a.delivery.state('nothing')).exists, false);

  // Start events: only this portal's workspaces (and unlabelled ones) reach delivery.
  const started: string[] = [];
  const stop = a.delivery.watchStarts((name) => started.push(name));
  const line = (attributes: Record<string, string>) => `${JSON.stringify({ Actor: { Attributes: attributes } })}\n`;
  f.events.write(line({ [LABEL.name]: 'theirs', [LABEL.portal]: 'portal-b' }));
  f.events.write(line({ [LABEL.name]: 'mine', [LABEL.portal]: 'portal-a' }));
  f.events.write(line({ [LABEL.name]: 'old' }));
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.deepEqual(started, ['mine', 'old']);
});
