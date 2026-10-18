// scripts/sched-lib.sh (T-961): the pure functions job-run.sh and gate-job.sh use to read a preemption and to count CPU requests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const call = (fn: string, ...args: string[]) => {
  const r = spawnSync('bash', ['-c', `. scripts/sched-lib.sh; ${fn} "$@"`, 'x', ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim() };
};
const pods = (...items: unknown[]) => JSON.stringify({ items });
const preemptedPod = { status: { phase: 'Failed', conditions: [{ type: 'DisruptionTarget', status: 'True', reason: 'PreemptionByScheduler', message: 'preempted by pod x' }] } };

test('sched_preempted: a pod disrupted by the scheduler is preempted; an ordinary failure, an eviction and garbage are not', () => {
  assert.equal(call('sched_preempted', pods(preemptedPod)).out, 'yes');
  assert.equal(call('sched_preempted', pods({ status: { reason: 'Preempted' } })).out, 'yes');
  assert.equal(call('sched_preempted', pods({ status: { phase: 'Failed', reason: 'Evicted' } })).out, 'no');
  assert.equal(call('sched_preempted', pods({ status: { phase: 'Failed', conditions: [{ type: 'DisruptionTarget', status: 'True', reason: 'EvictionByEvictionAPI' }] } })).out, 'no');
  assert.equal(call('sched_preempted', pods({ status: { conditions: [{ type: 'DisruptionTarget', status: 'False', reason: 'PreemptionByScheduler' }] } })).out, 'no');
  assert.equal(call('sched_preempted', pods()).out, 'no');
  assert.equal(call('sched_preempted', 'not json').out, 'no');
  assert.equal(call('sched_preempted', '').out, 'no');
});

const nodes = JSON.stringify({ items: [{ metadata: { name: 'n2' }, status: { allocatable: { cpu: '4', memory: '8Gi' } } }, { metadata: { name: 'n3' }, status: { allocatable: { cpu: '3950m' } } }] });
const p = (nodeName: string, cpu: string | undefined, extra: Record<string, unknown> = {}, phase = 'Running') => ({
  spec: { nodeName, containers: [{ resources: { requests: cpu ? { cpu } : {} } }, { resources: {} }], ...extra },
  status: { phase },
});

test('sched_cpu_free_m: allocatable minus the requests of the node\'s unfinished pods, in millicores (whole CPUs and m, init containers as the scheduler counts them)', () => {
  assert.equal(call('sched_cpu_free_m', nodes, pods(), 'n2').out, '4000');
  assert.equal(call('sched_cpu_free_m', nodes, pods(p('n2', '500m'), p('n2', '1'), p('n3', '2')), 'n2').out, '2500', 'only this node\'s pods; "1" is 1000m');
  assert.equal(call('sched_cpu_free_m', nodes, pods(p('n3', '500m')), 'n3').out, '3450');
  assert.equal(call('sched_cpu_free_m', nodes, pods(p('n2', '500m', {}, 'Succeeded'), p('n2', '500m', {}, 'Failed')), 'n2').out, '4000', 'finished pods hold nothing');
  assert.equal(call('sched_cpu_free_m', nodes, pods(p('n2', '500m', { initContainers: [{ resources: { requests: { cpu: '2' } } }] })), 'n2').out, '2000', 'an init container above the sum counts');
  assert.equal(call('sched_cpu_free_m', nodes, pods(p('n2', undefined)), 'n2').out, '4000', 'no request counts as 0');
  assert.equal(call('sched_cpu_free_m', nodes, pods(), 'gone').out, 'unknown');
  assert.equal(call('sched_cpu_free_m', '', '', 'n2').out, 'unknown');
});

test('sched_cpu_short: short only when a number is below the need; unknown never blocks (headroom for the portal: 500m + a Job\'s 500m)', () => {
  assert.equal(call('sched_cpu_short', '999', '1000').code, 0);
  assert.equal(call('sched_cpu_short', '1000', '1000').code, 1);
  assert.equal(call('sched_cpu_short', '-200', '1000').code, 0, 'overcommitted by requests');
  assert.equal(call('sched_cpu_short', 'unknown', '1000').code, 1);
  assert.equal(call('sched_cpu_short', '', '1000').code, 1);
});

const fit = (podList: unknown[], cpu = '100', mem = '384') => call('sched_fit', nodes, pods(...podList), 'n2', cpu, mem).out;
const q = (nodeName: string, cpu: string, memory: string, extra: Record<string, unknown> = {}, labels: Record<string, string> = {}) => ({
  metadata: { labels }, spec: { nodeName, containers: [{ resources: { requests: { cpu, memory } } }], ...extra }, status: { phase: 'Running' },
});

test('sched_fit: fits, fits by preempting claudepilot-jobs, or no; the old portal pod never counts; memory counts as well as CPU', () => {
  assert.equal(fit([]), 'fits');
  assert.equal(fit([q('n2', '3900m', '1Gi')]), 'fits', '100m is exactly what is left');
  assert.equal(fit([q('n2', '3950m', '1Gi')]), 'no', '50m left, and the pod is no Job');
  assert.equal(fit([q('n2', '3950m', '1Gi', { priorityClassName: 'claudepilot-jobs' })]), 'preempt');
  assert.equal(fit([q('n2', '3950m', '1Gi', {}, { app: 'claudepilot-portal' })]), 'fits', 'the portal being replaced is gone when the new one starts');
  assert.equal(fit([q('n2', '1', '7900Mi')]), 'no', 'memory: 292Mi left of 384Mi');
  assert.equal(fit([q('n2', '1', '7900Mi', { priorityClassName: 'claudepilot-jobs' })]), 'preempt');
  // 50m of a Job and 3950m of a workspace: 0 free, 50m free once the Job is gone, 100m needed. (A fixture over the node's 4000m would be no real node.)
  assert.equal(fit([q('n2', '50m', '1Gi', { priorityClassName: 'claudepilot-jobs' }), q('n2', '3950m', '1Gi')]), 'no', 'a workspace is not room');
  assert.equal(fit([q('n2', '3950m', '1Gi', { priorityClassName: 'claudepilot-jobs' }), q('n2', '50m', '1Gi')]), 'preempt', 'the Job is the big one: its room is enough');
  assert.equal(fit([q('n3', '3950m', '9Gi')]), 'fits', 'another node\'s pods do not count');
  assert.equal(call('sched_fit', nodes, pods(), 'gone', '100', '384').out, 'no');
  assert.equal(call('sched_fit', '', '', 'n2', '100', '384').out, 'no');
  assert.equal(fit([q('n2', '1', '1048576Ki')]), 'fits', 'Ki units');
});
