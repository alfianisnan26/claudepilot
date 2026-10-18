import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backfillCount, canSave, formOf, settingOf } from './releaseReportForm';

test('a stored setting round-trips through the form, for each kind', () => {
  for (const s of [null, { pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' }, { kind: 'branch', branch: 'stg', vaultId: '98af7d16def1', folder: 'Releases' }] as const)
    assert.deepEqual(settingOf(formOf(s)), s);
});

test('off sends null; a kind sends only its own fields, trimmed; the defaults are deploy, stg and Releases', () => {
  const f = formOf(null);
  assert.deepEqual([f.kind, f.pipeline, f.branch, f.folder], ['off', 'deploy', 'stg', 'Releases']);
  assert.equal(settingOf({ ...f, vaultId: 'v1' }), null, 'off is null even with a vault typed');
  assert.deepEqual(settingOf({ ...f, kind: 'branch', vaultId: ' v1 ', folder: ' Releases ', branch: ' stg ' }), { kind: 'branch', branch: 'stg', vaultId: 'v1', folder: 'Releases' });
  assert.deepEqual(settingOf({ ...f, kind: 'pipeline', vaultId: 'v1' }), { pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' });
});

test('Save needs a vault, a folder and the kind name; a branch report needs an upstream; off can always be saved', () => {
  const f = { ...formOf(null), vaultId: 'v1' };
  assert.equal(canSave(f, false), true);
  assert.equal(canSave({ ...f, kind: 'branch' }, true), true);
  assert.equal(canSave({ ...f, kind: 'branch' }, false), false, 'no upstream');
  assert.equal(canSave({ ...f, kind: 'branch', branch: ' ' }, true), false);
  assert.equal(canSave({ ...f, kind: 'pipeline' }, false), true, 'a pipeline report needs no upstream');
  assert.equal(canSave({ ...f, kind: 'pipeline', pipeline: '' }, false), false);
  assert.equal(canSave({ ...f, kind: 'pipeline', vaultId: '' }, false), false);
  assert.equal(canSave({ ...f, kind: 'pipeline', folder: '' }, false), false);
});

test('the backfill count: empty is the default 5; 1 to 20; anything else is refused', () => {
  assert.equal(backfillCount(''), 5);
  assert.equal(backfillCount(' 1 '), 1);
  assert.equal(backfillCount('20'), 20);
  for (const bad of ['0', '21', '1.5', '-1', 'x', '100']) assert.equal(backfillCount(bad), null, bad);
});
