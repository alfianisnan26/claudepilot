// The reconciler delivering an MCP set into a Kubernetes workspace end to end (foundation PRD §6.2; mcpset-pool), through the real
// KubernetesRuntime and its exec over a WebSocket to the in-process fake API server (no cluster: KUBERNETES SAFETY RULE):
// - always: the pod is `memoryPod` (kubeTestkit.ts), which decodes the delivery protocol and keeps the files in memory; assignment, the first
//   delivery, a new revision rolled out, a stop (pending, nothing written), and a new pod (everything outside the home volume gone) that the
//   start watch delivers to again.
// - CLAUDEPILOT_DOCKER_TESTS=1: the pod is a throwaway container of the real workspace image, entered as uid 1000 (`docker exec -u 1000:1000`),
//   so the wrapper's `sudo -n`, tar's owners and modes and the root-owned /etc/claude-code are the image's own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { McpCatalogEntry } from '@portal/contracts';
import { CP_SESSION, CP_SESSION_PATH } from '../chat/host.js';
import { hostInstaller } from '../chat/install.js';
import { config } from '../config.js';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import { McpSets } from '../mcp/index.js';
import { References } from '../pools/references.js';
import { PoolService } from '../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { WorkspaceSteps } from './steps.js';
import { dockerPod, kubeRuntimeOn, memoryPod } from '../workspaces/kubeTestkit.js';
import { Reconciler, type FragmentProvider } from './reconciler.js';
import { MANIFEST_PATH, MARKETPLACE_JSON, type Manifest } from './types.js';

const MCP_DROPIN = '/etc/claude-code/managed-settings.d/30-claudepilot-mcp.json';
const docker = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const saved = process.env.KUBECONFIG;
before(() => {
  process.env.KUBECONFIG = '/nonexistent/kd-kubeconfig';
});
after(() => {
  if (saved === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = saved;
});

const until = async (fn: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'kd-k8s-e2e-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const fake = await FakeKube.start();
  const rt = kubeRuntimeOn(fake, { pollMs: 40 });
  const ws = `${rt.target.id}/kw`;
  const providers: FragmentProvider[] = [];
  const pools = new PoolService(store, { providers });
  const references = new References();
  references.provideSecretNames({ namesFor: () => new Map() });
  const steps = { enqueue: () => undefined, queued: () => [] } as unknown as WorkspaceSteps;
  const mcp = new McpSets(store, pools, references, () => undefined, { resolveDns: false, steps });
  const reconciler = new Reconciler(store, (t) => (t === rt.target.id ? rt : undefined), () => [rt], providers);
  pools.reconciler = reconciler;
  await rt.create({ name: 'kw' }, () => undefined);
  const row = () => reconciler.row(ws);
  const done = async () => {
    reconciler.stop();
    await fake.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, fake, rt, ws, pools, mcp, reconciler, row, done };
}

async function memoryServer(mcp: McpSets): Promise<McpCatalogEntry> {
  const e = await mcp.catalog.create({
    key: 'memory',
    displayName: 'Memory',
    kind: 'npm',
    version: '1.0.0',
    spec: { package: '@modelcontextprotocol/server-memory' },
    slots: [{ name: 'MEMORY_FILE_PATH', target: 'env', default: '/home/node/.memory.json' }],
  });
  return mcp.catalog.approve(e.id, e.versions[0]!.id, { reviewed: true });
}
const server = (e: McpCatalogEntry, key: string, args: string[] = []) => ({ key, entry: e.id, version: '1.0.0', enabled: true, config: {}, secrets: {}, ...(args.length ? { args } : {}) });

test('an MCP set reaches a Kubernetes workspace: assignment, first delivery, a new revision, a stop and a new pod', async () => {
  const h = await harness();
  const pod = memoryPod(h.fake);
  try {
    const m = await memoryServer(h.mcp);
    const set = h.pools.create('mcpset', { name: 'Team', content: { servers: [server(m, 'memory')] } });
    h.pools.setAssignments(h.ws, 'mcpset', [{ poolId: set.id }]);
    await until(() => h.row()?.status === 'synced', 'the first delivery');
    const manifest = () => JSON.parse(pod.files.get(MANIFEST_PATH)?.content ?? 'null') as Manifest | null;
    assert.deepEqual(manifest()!.pools.map((p) => [p.type, p.id, p.revision]), [['mcpset', set.id, 1]]);
    assert.deepEqual(JSON.parse(pod.files.get(MCP_DROPIN)!.content).enabledPlugins, { 'cpm-team@claudepilot': true });
    assert.equal(pod.files.get(MCP_DROPIN)!.uid, 0, 'root-owned, as Claude Code wants its managed settings');
    const catalog = pod.files.get(MARKETPLACE_JSON)!.content;
    const folder = /"source": "\.\/plugins\/cpm-team\/([0-9a-f]{12})"/.exec(catalog)![1]!;
    const mcpJson = JSON.parse(pod.files.get(`/etc/claudepilot/marketplace/plugins/cpm-team/${folder}/.mcp.json`)!.content) as { mcpServers: Record<string, { args: string[] }> };
    assert.deepEqual(Object.keys(mcpJson.mcpServers), ['memory']);
    assert.ok(pod.files.get('/etc/claudepilot/bin/mcp-launch')?.content.startsWith('#!/usr/bin/env node'));
    // Every write was a root put or a root run through the wrapper; the readable check ran as the workspace user.
    assert.ok(pod.execs.filter((e) => e.kind === 'put').every((e) => e.user === 'root'));
    assert.ok(pod.execs.some((e) => e.kind === 'run' && e.user === 'root' && e.first.toString().includes(`mv -f '${MANIFEST_PATH.replace('state.json', '.state.json.cp-tmp')}'`)));
    assert.deepEqual(h.mcp.status(h.ws).servers.map((s) => [s.key, s.state]), [['memory', 'delivered']]);

    // A new revision rolls out to the assigned workspace.
    h.pools.update(set.id, { content: { servers: [server(m, 'memory'), server(m, 'notes')] } });
    await until(() => manifest()?.pools[0]?.revision === 2 && h.row()?.status === 'synced', 'the second revision');
    const next = JSON.parse(pod.files.get(`/etc/claudepilot/marketplace/plugins/cpm-team/${/"source": "\.\/plugins\/cpm-team\/([0-9a-f]{12})"/.exec(pod.files.get(MARKETPLACE_JSON)!.content)![1]}/.mcp.json`)!.content) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(next.mcpServers).sort(), ['memory', 'notes']);

    // Stopped: no pod to write into; the row waits for the start and nothing is attempted.
    const asked: string[] = [];
    const request = h.reconciler.request.bind(h.reconciler);
    h.reconciler.request = (id, why, opts) => (asked.push(why ?? ''), request(id, why, opts));
    h.reconciler.start();
    await h.rt.stop('kw');
    const execs = pod.execs.length;
    await h.reconciler.request(h.ws, 'test');
    assert.deepEqual([h.row()!.status, h.row()!.reason], ['pending', 'Delivered when the workspace starts.']);
    assert.equal(pod.execs.length, execs);

    // The next pod starts from the image: everything outside the home volume is gone, and the start watch delivers it all again.
    for (const p of [...pod.files.keys()]) if (!p.startsWith('/home/node/')) pod.files.delete(p);
    for (const p of [...pod.dirs.keys()]) if (!p.startsWith('/home/node')) pod.dirs.delete(p);
    await h.rt.start('kw');
    await until(() => manifest()?.pools[0]?.revision === 2 && h.row()?.status === 'synced', 'the delivery at the start');
    assert.ok(pod.files.has(MCP_DROPIN));
    // The start watch (a poll of the pod list) asks too. It may ask a moment after the delivery: a reconcile already under way runs once
    // more as "queued", which delivers the same, so wait for the ask instead of reading it at once (a loaded machine made that a race).
    await until(() => asked.includes('started'), `the start watch asked for a delivery (asked: ${asked.join(', ')})`);
  } finally {
    await h.done();
  }
});

test('the chat host installs into a Kubernetes workspace through delivery, once', async () => {
  const h = await harness();
  const pod = memoryPod(h.fake);
  try {
    const install = hostInstaller({ runtimeFor: (t: string) => (t === h.rt.target.id ? h.rt : undefined) } as unknown as Workspaces);
    await install(h.ws);
    assert.deepEqual(pod.files.get(CP_SESSION_PATH), { content: CP_SESSION, mode: 0o755, uid: 0, gid: 0 });
    assert.deepEqual(pod.execs.map((e) => `${e.kind} ${e.user}`), ['read root', 'put root', 'run root']);
    await install(h.ws);
    assert.equal(pod.execs.length, 4, 'the current host is only read');
  } finally {
    await h.done();
  }
});

const name = `kd-kdeliver-${randomBytes(3).toString('hex')}`;
const sh = (cmd: string) => execFileSync('docker', ['exec', '-u', '1000:1000', name, 'sh', '-c', cmd], { encoding: 'utf8' });

test('the real workspace image as the pod: sudo, owners, modes and the readable check (CLAUDEPILOT_DOCKER_TESTS=1)', { skip: docker ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 to run against Docker' }, async () => {
  // A throwaway container (never labelled as a workspace): the workspace image, running as uid 1000 as the pod does.
  execFileSync('docker', ['run', '-d', '--name', name, '--user', '1000:1000', '--label', 'kd.test=true', '--network', 'none', config.workspaces.dockerImage], { stdio: 'ignore' });
  const h = await harness();
  try {
    dockerPod(h.fake, name);
    assert.equal(sh('id -u').trim(), '1000');
    assert.match(sh('stat -c "%U %a" /etc/claude-code /etc/claude-code/managed-settings.d'), /^root 755\nroot 755\n$/);
    const m = await memoryServer(h.mcp);
    const set = h.pools.create('mcpset', { name: 'Team', content: { servers: [server(m, 'memory')] } });
    h.pools.setAssignments(h.ws, 'mcpset', [{ poolId: set.id }]);
    await until(() => h.row()?.status === 'synced' || h.row()?.status === 'failed', 'the first delivery', 60_000);
    assert.equal(h.row()!.status, 'synced', h.row()!.reason ?? '');
    assert.match(sh(`stat -c '%U:%G %a' ${MCP_DROPIN} ${MANIFEST_PATH} /etc/claudepilot/bin/mcp-launch /home/node/.claudepilot/outbox`), /^root:root 644\nroot:root 644\nroot:root 755\nnode:node 700\n$/);
    assert.deepEqual(JSON.parse(sh(`cat ${MCP_DROPIN}`)).enabledPlugins, { 'cpm-team@claudepilot': true });
    assert.equal((JSON.parse(sh(`cat ${MANIFEST_PATH}`)) as Manifest).pools[0]!.id, set.id);
    // The applied state reads back (hashes match): a second pass writes nothing.
    const gen = h.row()!.generation;
    await h.reconciler.request(h.ws, 'test');
    assert.deepEqual([h.row()!.status, h.row()!.generation], ['synced', gen]);
    h.pools.update(set.id, { content: { servers: [server(m, 'memory'), server(m, 'notes')] } });
    await until(() => h.row()?.status === 'synced' && h.row()!.generation > gen, 'the second revision', 60_000);
    assert.match(sh('cat /etc/claudepilot/marketplace/plugins/cpm-team/*/.mcp.json'), /"notes"/);
    assert.equal(await h.rt.delivery.read('kw', '/etc/claudepilot/nope'), null);
    assert.equal((await h.rt.delivery.run('kw', 'id -u')).stdout.trim(), '0', 'root through the image’s sudo');
    // The chat host, installed through delivery and run as the workspace user.
    await hostInstaller({ runtimeFor: () => h.rt } as unknown as Workspaces)(h.ws);
    assert.equal(sh(`stat -c '%U %a' ${CP_SESSION_PATH}`), 'root 755\n');
    assert.equal(sh(`cat ${CP_SESSION_PATH}`), CP_SESSION);
    // The workspace user swaps a folder delivery writes for a link to /etc: the root write is refused, /etc untouched.
    sh('rm -rf /home/node/.claudepilot/outbox && ln -s /etc/sudoers.d /home/node/.claudepilot/outbox');
    await assert.rejects(h.rt.delivery.put('kw', [{ path: '/home/node/.claudepilot/outbox/kd', type: 'file', content: 'x', mode: 0o644, uid: 0, gid: 0 }]), /refusing to write through the symbolic link \/home\/node\/\.claudepilot\/outbox/);
    assert.equal(sh('ls /etc/sudoers.d').includes('kd'), false);
  } finally {
    await h.done();
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
});
