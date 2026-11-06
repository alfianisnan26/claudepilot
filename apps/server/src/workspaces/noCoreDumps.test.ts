// PILOT-1196 (T-3907): no core files from what the portal starts in a Kubernetes workspace (a node OOM left multi-GB core.<pid> files in
// memor.id worktrees). An exec takes the container runtime's limits, not PID 1's, so every session exec and terminal starts with RLIMIT_CORE
// 0, soft and hard; the delivery's root scripts keep their exact argv. The job-run and gate Job scripts set it too. Against the in-process
// fake API server (KUBERNETES SAFETY RULE): the exec's argv runs here (kubeTestkit.ts `localPod`).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import { NO_CORE_DUMPS, noCoreDumps, type KubernetesRuntime } from './kubernetes.js';
import { kubeRuntimeOn, localPod } from './kubeTestkit.js';

let fake: FakeKube;
let dir: string;
let rt: KubernetesRuntime;
const saved = process.env.KUBECONFIG;

before(() => {
  process.env.KUBECONFIG = '/nonexistent/nocore-kubeconfig';
});
after(() => {
  if (saved === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = saved;
});
beforeEach(async () => {
  fake = await FakeKube.start();
  dir = mkdtempSync(join(tmpdir(), 'nocore-'));
  rt = kubeRuntimeOn(fake, { roots: [dir], pollMs: 40 });
  await rt.create({ name: 'kw' }, () => undefined);
});
afterEach(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function output(argv: string[]): Promise<{ code: number | null; text: string }> {
  const e = await rt.exec('kw', argv);
  const chunks: Buffer[] = [];
  e.onData((b) => chunks.push(Buffer.from(b)));
  const code = await new Promise<number | null>((r) => e.onExit(r));
  return { code, text: Buffer.concat(chunks).toString('utf8') };
}

test('an exec in a Kubernetes workspace runs with no core files (soft and hard 0), its argv and exit code passed through', async () => {
  const pod = localPod(fake, dir);
  const r = await output(['sh', '-c', 'ulimit -S -c; ulimit -H -c; echo "$1 $2"; exit 3', 'x', 'a b', 'c']);
  assert.deepEqual(r, { code: 3, text: '0\n0\na b c\n' });
  assert.deepEqual(pod.execs.at(-1)!.slice(0, NO_CORE_DUMPS.length), [...NO_CORE_DUMPS], 'the limit comes first');
  assert.deepEqual(noCoreDumps(['true']), ['sh', '-c', 'ulimit -c 0 2>/dev/null; exec "$@"', 'sh', 'true']);
});

test('the delivery’s root scripts keep their exact argv (no wrapper)', async () => {
  const pod = localPod(fake, dir);
  await rt.delivery.run('kw', 'true');
  assert.equal(pod.execs.at(-1)![0] === 'sh' && pod.execs.at(-1)![2] === NO_CORE_DUMPS[2], false);
});

test('the job-run and gate Job scripts set no core files in each container', () => {
  for (const f of ['job-run.yaml', 'gate-job.yaml']) {
    const text = readFileSync(new URL(`../../../../deploy/k3s-build/${f}`, import.meta.url), 'utf8');
    const scripts = text.split('set -u\n').slice(1);
    assert.ok(scripts.length >= 2, f);
    for (const s of scripts) assert.match(s.split('\n')[0]!, /^\s*ulimit -c 0\b/, `${f}: right after set -u`);
  }
});
