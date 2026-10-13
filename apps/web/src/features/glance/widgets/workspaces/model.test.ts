import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workspace, WorkspaceUsage } from '@portal/contracts';
import { pctOf, workspacesCompact, workspacesView } from './model.js';

const ws = (name: string, status: Workspace['status'], over: Partial<Workspace> = {}): Workspace => ({ id: `docker/${name}`, name, target: 'docker', image: 'img', status, createdAt: '2026-10-01T00:00:00Z', ...over });

test('counts by state, failing first then changing, running and stopped; CPU and memory only where measured', () => {
  const list = [
    ws('web', 'stopped'),
    ws('api', 'running', { cpus: 2, memoryMb: 1024, claude: { pinned: '2.1.296', running: '2.1.300', flags: ['differs'] } }),
    ws('db', 'error', { detail: 'image pull failed' }),
    ws('ml', 'running', { claude: { pinned: '2.1.296', running: '2.1.296', flags: [] } }),
    ws('far', 'unreachable'),
    ws('new', 'starting'),
  ];
  // api: 50 % of one core over 2 cores = 25 %; 256 MiB of 1024 MiB = 25 %. ml: no measurement pushed yet. web is stopped: its old numbers are not shown.
  const usage: WorkspaceUsage[] = [
    { id: 'docker/api', cpuPercent: 50, memoryBytes: 256 * 1024 * 1024 },
    { id: 'docker/web', cpuPercent: 80, memoryBytes: 1, cores: 4, memoryTotalBytes: 10 },
  ];
  const v = workspacesView(list, usage);
  assert.deepEqual([v.total, v.running, v.stopped, v.failing, v.busy, v.drift], [6, 2, 1, 2, 1, 1]);
  assert.deepEqual(v.rows.map((r) => r.name), ['db', 'far', 'new', 'api', 'ml', 'web']);
  const api = v.rows.find((r) => r.name === 'api')!;
  assert.deepEqual([api.cpu, api.memory, api.running, api.pinned, api.differs], [0.25, 0.25, '2.1.300', '2.1.296', true]);
  const ml = v.rows.find((r) => r.name === 'ml')!;
  assert.deepEqual([ml.cpu, ml.memory, ml.differs], [null, null, false]);
  assert.deepEqual([v.rows.find((r) => r.name === 'web')!.cpu, pctOf(null), pctOf(0.254)], [null, '-', '25 %']);
  assert.equal(v.rows[0]!.detail, 'image pull failed');
  assert.deepEqual(workspacesCompact(v, false), { value: '2', level: 'critical', title: 'Workspaces: 2 running, 1 stopped, 2 failing and 1 changing' });
});

test('a version is compared only when both are known; empty, loading and failed are states, not zeros', () => {
  const v = workspacesView([ws('a', 'running', { claude: { pinned: null, running: '2.1.300', flags: [] } }), ws('b', 'stopped', { claude: null })], []);
  assert.deepEqual(v.rows.map((r) => r.differs), [false, false]);
  assert.deepEqual(workspacesCompact(workspacesView([], []), false), { value: '0', level: 'idle', title: 'Workspaces: none' });
  assert.deepEqual(workspacesCompact(null, false), { value: null, level: 'unknown', title: 'Workspaces: loading', loading: true });
  assert.deepEqual(workspacesCompact(null, true), { value: '-', level: 'unknown', title: 'Workspaces: not available', stale: true });
});
