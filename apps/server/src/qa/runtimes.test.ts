// QA-029 / QA-032: whatever calls a runtime, a name that is not plain is refused by the runtime itself, before a Docker URL, a Kubernetes
// label selector or a command is built from it. (The API refuses them earlier; the delivery engine, the chat host, the Portal MCP and
// anything added later reach the runtimes without passing the API.)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { Workspace } from '@portal/contracts';
import type Docker from 'dockerode';
import type { JsonFile } from '../jsonFile.js';
import { DockerRuntime } from '../workspaces/docker.js';
import { KubernetesRuntime } from '../workspaces/kubernetes.js';
import { Workspaces } from '../workspaces/manager.js';
import type { Runtime } from '../workspaces/runtime.js';

const HOSTILE = ['x/../../containers', '..%2f..%2fetc', 'x?force=true', 'a b', 'a\nb', "x'--", 'x,y!=z', '', 'x'.repeat(64), '../x', '-x'];

/** A Docker client that remembers every call (a property read alone asks Docker nothing), so "nothing was asked of Docker" can be asserted. */
const touched: string[] = [];
const spy: object = new Proxy(function () {}, {
  get: (_t, p) => (p === 'then' ? undefined : spy),
  apply: (_t, _this, args) => (touched.push(`call(${args.map((a) => JSON.stringify(a)).join(', ')})`), spy),
});

const refused = async (what: string, call: () => unknown) => {
  await assert.rejects(
    async () => call(),
    (e: unknown) => isAppError(e) && e.status === 404,
    `${what} should be refused as "no such workspace"`,
  );
};

test('the Docker runtime refuses a name that is not plain, for every call that takes one, without asking Docker', async () => {
  const docker = new DockerRuntime({ id: 'docker', label: 'Docker', socket: '/nonexistent.sock' }, 'img:latest', '/nonexistent', () => null, spy as unknown as Docker);
  for (const bad of HOSTILE) {
    touched.length = 0;
    const label = JSON.stringify(bad).slice(0, 30);
    await refused(`start ${label}`, () => docker.start(bad));
    await refused(`stop ${label}`, () => docker.stop(bad));
    await refused(`remove ${label}`, () => docker.remove(bad));
    await refused(`shell ${label}`, () => docker.shell(bad, { cols: 80, rows: 24 }));
    await refused(`exec ${label}`, () => docker.exec(bad, ['true']));
    await refused(`delivery.state ${label}`, () => docker.delivery!.state(bad));
    assert.deepEqual(touched, [], `Docker was asked something for ${label}: ${touched.join(', ')}`);
  }
  // usage() answers "unknown" for such a name rather than failing the whole list.
  const [u] = await docker.usage(['x/../../containers']);
  assert.equal(u?.cpuPercent, null);
  // A plain name goes through to Docker (the guard does not block the real thing).
  touched.length = 0;
  await docker.start('qa-ws1');
  assert.ok(touched.some((t) => t.includes('claudepilot-qa-ws1')), 'a plain name reaches Docker');
});

test('the Kubernetes runtime refuses a name that is not plain before any API call or label selector', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-kube-'));
  const file = join(dir, 'config');
  writeFileSync(file, 'apiVersion: v1\nkind: Config\nclusters: [{name: c, cluster: {server: "http://127.0.0.1:1"}}]\nusers: [{name: u, user: {token: t}}]\ncontexts: [{name: x, context: {cluster: c, user: u}}]\ncurrent-context: x\n');
  const before = process.env.KUBECONFIG;
  process.env.KUBECONFIG = file;
  try {
    const k8s = new KubernetesRuntime({ namespace: 'ns', image: 'img', storage: '1Gi' });
    for (const bad of HOSTILE) {
      await refused(`start ${JSON.stringify(bad)}`, () => k8s.start(bad));
      await refused(`stop ${JSON.stringify(bad)}`, () => k8s.stop(bad));
      await refused(`remove ${JSON.stringify(bad)}`, () => k8s.remove(bad));
      await refused(`exec ${JSON.stringify(bad)}`, () => k8s.exec(bad, ['true']));
      await refused(`shell ${JSON.stringify(bad)}`, () => k8s.shell(bad, { cols: 80, rows: 24 }));
    }
  } finally {
    if (before === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = before;
  }
});

test('Workspaces.exists asks only the one runtime, and says yes when that runtime cannot answer', async () => {
  const asked: string[] = [];
  const ws = (id: string, name: string) => ({ id: `${id}/${name}`, name, target: id }) as Workspace;
  const runtime = (id: string, list: () => Promise<Workspace[]>) => ({ target: { id, label: id, kind: 'docker', where: id, available: true }, check: async () => undefined, list: async () => (asked.push(id), list()) }) as unknown as Runtime;
  const saved = { read: () => [] as Workspace[], write: () => undefined } as unknown as JsonFile<Workspace[]>;
  const w = new Workspaces([runtime('docker', async () => [ws('docker', 'ws-1')]), runtime('down', async () => Promise.reject(new Error('socket closed')))], saved);
  assert.equal(await w.exists('docker', 'ws-1'), true);
  assert.equal(await w.exists('docker', 'ws-2'), false);
  assert.deepEqual(asked, ['docker', 'docker'], 'only the named target was asked');
  assert.equal(await w.exists('nowhere', 'ws-1'), false);
  assert.equal(await w.exists('docker', 'x/../../containers'), false);
  assert.equal(await w.exists('down', 'anything'), true, 'a target that cannot answer is not "no such workspace"');
});
