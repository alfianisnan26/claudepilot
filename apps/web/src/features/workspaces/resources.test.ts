import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftOf, parseDraft, requestsSummary, resourcesSummary } from './resources';

test('the draft starts from the wanted values, else from what the Deployment has', () => {
  assert.deepEqual(draftOf(null, { cpus: 4, memoryMb: 8192, cpuRequest: 0.25, memoryRequestMb: 1024 }), { cpus: '4', memoryMb: '8192', cpuRequest: '0.25', memoryRequestMb: '1024' });
  assert.deepEqual(draftOf({ cpus: 6, memoryMb: 12288, cpuRequest: 1, memoryRequestMb: 2048 }, { cpus: 4 }), { cpus: '6', memoryMb: '12288', cpuRequest: '1', memoryRequestMb: '2048' });
  assert.deepEqual(draftOf(null, {}), { cpus: '', memoryMb: '', cpuRequest: '', memoryRequestMb: '' });
});

test('parsing: numbers (a comma is a decimal point), the server’s bounds, a request never above its limit', () => {
  assert.deepEqual(parseDraft({ cpus: '4', memoryMb: '8192', cpuRequest: '0,5', memoryRequestMb: '1024' }).values, { cpus: 4, memoryMb: 8192, cpuRequest: 0.5, memoryRequestMb: 1024 });
  const bad = parseDraft({ cpus: '2', memoryMb: '', cpuRequest: '3', memoryRequestMb: 'lots' });
  assert.equal(bad.values, null);
  assert.deepEqual(Object.keys(bad.problems ?? {}).sort(), ['cpuRequest', 'memoryMb', 'memoryRequestMb']);
  assert.equal(bad.problems?.cpuRequest, 'Not above the CPU limit.');
});

test('the row says the limits and what is reserved; a value not set is a dash, never a guess', () => {
  assert.equal(resourcesSummary({ cpus: 4, memoryMb: 8192 }), '4 CPU · 8 GiB');
  assert.equal(resourcesSummary({ memoryMb: 1500 }), '– · 1500 MiB');
  assert.equal(requestsSummary({ cpuRequest: 0.25, memoryRequestMb: 1024 }), 'reserves 0.25 CPU · 1 GiB');
});
