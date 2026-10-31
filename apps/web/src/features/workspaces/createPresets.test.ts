import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpuLabel, memoryLabel, presetFor, withValue } from './createPresets';

test('the preset is the target’s defaults (PORTAL_K8S_TARGETS), else 2 CPUs and 4 GB', () => {
  assert.deepEqual(presetFor(undefined), { cpus: '2', memory: '4096' });
  assert.deepEqual(presetFor({}), { cpus: '2', memory: '4096' });
  assert.deepEqual(presetFor({ defaults: { cpus: 4, memoryMb: 12288 } }), { cpus: '4', memory: '12288' });
  assert.deepEqual(presetFor({ defaults: { memoryMb: 6144 } }), { cpus: '2', memory: '6144' });
});

test('a default outside the fixed choices is added in order; one inside them adds nothing', () => {
  const mem = [{ value: '', label: 'No limit' }, { value: '4096', label: '4 GB' }, { value: '8192', label: '8 GB' }];
  assert.deepEqual(withValue(mem, '6144', memoryLabel).map((o) => o.label), ['No limit', '4 GB', '6 GB', '8 GB']);
  assert.deepEqual(withValue(mem, '12288', memoryLabel).map((o) => o.label), ['No limit', '4 GB', '8 GB', '12 GB']);
  assert.equal(withValue(mem, '8192', memoryLabel).length, 3);
  assert.equal(withValue(mem, '', memoryLabel).length, 3);
  assert.equal(cpuLabel(1), '1 CPU');
  assert.equal(cpuLabel(3), '3 CPUs');
});
