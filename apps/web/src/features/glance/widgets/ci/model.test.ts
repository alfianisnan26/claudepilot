import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CiRunSummary, GlanceSnapshot } from '@portal/contracts';
import { ciCompact, ciView, holdsDeploy } from './model.js';

const run = (id: string, status: CiRunSummary['status'], jobs: CiRunSummary['jobs'] = []) => ({ id, status, jobs }) as CiRunSummary;
const glance = (ci: { ok: boolean; count: number }, deploys: { ok: boolean; count: number }) =>
  ({ attention: { ci: { ...ci, items: [] }, deploys: { ...deploys, items: [] } } }) as unknown as GlanceSnapshot;

test('a run holds a deploy when it runs with a job waiting for a person', () => {
  assert.equal(holdsDeploy(run('a', 'running', [{ id: 'release', status: 'waiting' }])), true);
  assert.equal(holdsDeploy(run('b', 'running', [{ id: 'test', status: 'running' }])), false);
  assert.equal(holdsDeploy(run('c', 'passed', [{ id: 'release', status: 'waiting' }])), false);
});

test('the last runs (five), the failures that stand and the deploys to approve; red while a deploy waits', () => {
  const list = { items: ['1', '2', '3', '4', '5', '6'].map((i) => run(i, 'passed')), active: 1 };
  const v = ciView(list, glance({ ok: true, count: 2 }, { ok: true, count: 1 }));
  assert.deepEqual([v.runs.map((r) => r.id), v.active, v.failing, v.deploys], [['1', '2', '3', '4', '5'], 1, 2, 1]);
  assert.deepEqual(ciCompact(v, false), { value: '2', level: 'critical', title: 'CI: 1 deploy to approve, 2 failing and 1 running' });
  assert.equal(ciCompact(ciView(list, glance({ ok: true, count: 1 }, { ok: true, count: 0 })), false).level, 'warn');
  assert.deepEqual(ciCompact(ciView({ items: [], active: 0 }, glance({ ok: true, count: 0 }, { ok: true, count: 0 })), false), { value: '0', level: 'idle', title: 'CI: nothing failing' });
});

test('failures the snapshot could not read are unavailable, never zero', () => {
  const v = ciView({ items: [], active: 0 }, glance({ ok: false, count: 0 }, { ok: false, count: 0 }));
  assert.deepEqual([v.failing, v.deploys], [null, null]);
  assert.deepEqual(ciCompact(v, false), { value: '-', level: 'unknown', title: 'CI: failures could not be read' });
  assert.deepEqual([ciView(null, null).failing, ciCompact(null, true).value], [null, '-']);
});
