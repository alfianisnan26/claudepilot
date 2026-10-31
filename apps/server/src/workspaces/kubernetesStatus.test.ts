// A Kubernetes workspace's status from its Deployment and pods (kubernetes.ts #status), on the in-process fake API server: finished pods
// (phase Succeeded or Failed, "Completed" 0/1 in kubectl) are not the workspace. kubernetes/memorid-project sat on "Stopping" for good
// with its Deployment at zero replicas and two such pods left behind (owner report 2026-10-31).
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import type { KubernetesRuntime } from './kubernetes.js';
import { kubeRuntimeOn } from './kubeTestkit.js';

type Pod = { metadata: { name: string; labels?: Record<string, string>; deletionTimestamp?: string }; status?: Record<string, unknown> };
type Deployment = { metadata: { name: string }; spec: { replicas?: number } };

let fake: FakeKube;
let rt: KubernetesRuntime;
before(async () => {
  fake = await FakeKube.start();
});
after(async () => {
  await fake.stop();
});
beforeEach(async () => {
  fake.pods.clear();
  fake.deployments.clear();
  fake.replicaSets.clear();
  rt = kubeRuntimeOn(fake);
  await rt.create({ name: 'memorid-project', runtimeName: 'ws-32d23daeb567' }, () => undefined);
});

const deployment = () => fake.deployments.get('ws-32d23daeb567') as unknown as Deployment;
const statusOf = async () => (await rt.list()).find((w) => w.name === 'memorid-project')?.status;
/** A pod of the workspace's Deployment, as the controller made it, in the phase given. */
function pod(suffix: string, phase: string, extra: { terminating?: boolean } = {}): Pod {
  const p = fake.podFor(deployment() as never) as unknown as Pod;
  p.metadata.name = `ws-32d23daeb567-${suffix}`;
  if (extra.terminating) p.metadata.deletionTimestamp = new Date().toISOString();
  const running = phase === 'Running';
  p.status = {
    phase,
    containerStatuses: [{ name: 'workspace', ready: running, state: running ? { running: {} } : { terminated: { exitCode: 0, reason: 'Completed' } } }],
  };
  fake.pods.set(p.metadata.name, p as never);
  return p;
}
/** Scaled to zero with no pod left by the fake's controller; the test then puts back the pods it wants. */
function scaledToZero() {
  deployment().spec.replicas = 0;
  fake.pods.clear();
}

test('scaled to zero with only Succeeded pods left: stopped, not stopping', async () => {
  scaledToZero();
  pod('57b94b5b9c-4k6bg', 'Succeeded');
  pod('57b94b5b9c-c89c9', 'Succeeded');
  assert.equal(await statusOf(), 'stopped');
});

test('scaled to zero with a Failed pod, or a finished pod being deleted: stopped', async () => {
  scaledToZero();
  pod('57b94b5b9c-aaaaa', 'Failed');
  pod('57b94b5b9c-bbbbb', 'Succeeded', { terminating: true });
  assert.equal(await statusOf(), 'stopped');
});

test('scaled to zero with no pod: stopped', async () => {
  scaledToZero();
  assert.equal(await statusOf(), 'stopped');
});

test('scaled to zero while a pod still runs or terminates: stopping', async () => {
  scaledToZero();
  pod('57b94b5b9c-running', 'Running');
  assert.equal(await statusOf(), 'stopping');
  scaledToZero();
  pod('57b94b5b9c-leaving', 'Running', { terminating: true });
  pod('57b94b5b9c-4k6bg', 'Succeeded');
  assert.equal(await statusOf(), 'stopping');
});

test('one replica: an old Succeeded pod listed first does not hide the running one', async () => {
  fake.pods.clear();
  pod('57b94b5b9c-4k6bg', 'Succeeded');
  pod('7d9f6c-live', 'Running');
  assert.equal(await statusOf(), 'running');
});

test('one replica with only a Failed pod: still an error, with its reason', async () => {
  fake.pods.clear();
  const p = pod('7d9f6c-dead', 'Failed');
  (p.status as { reason?: string }).reason = 'Evicted';
  const ws = (await rt.list()).find((w) => w.name === 'memorid-project');
  assert.equal(ws?.status, 'error');
  assert.equal(ws?.detail, 'Evicted');
});
