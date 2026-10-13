import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpuMilli, memoryBytes, parseRequests, requestsFor } from './requests.js';

test('quantities: millicores and bytes, the Kubernetes spellings', () => {
  assert.equal(cpuMilli('250m'), 250);
  assert.equal(cpuMilli('2'), 2000);
  assert.equal(cpuMilli('0.5'), 500);
  assert.equal(cpuMilli('two'), null);
  assert.equal(memoryBytes('1Gi'), 1024 ** 3);
  assert.equal(memoryBytes('4096Mi'), 4096 * 1024 ** 2);
  assert.equal(memoryBytes('512M'), 512e6);
  assert.equal(memoryBytes('1 gig'), null);
});

test('unset, blank or "limit" means requests follow the limits as before', () => {
  assert.equal(parseRequests(undefined, undefined), undefined);
  assert.equal(parseRequests('', ' '), undefined);
  assert.equal(parseRequests('limit', 'limit'), undefined);
  assert.deepEqual(parseRequests('250m', undefined), { cpu: '250m' });
  assert.deepEqual(parseRequests('250m', '1Gi'), { cpu: '250m', memory: '1Gi' });
});

test('a value that is not a quantity stops the portal at start', () => {
  assert.throws(() => parseRequests('lots', undefined), /PORTAL_K8S_CPU_REQUEST is not usable/);
  assert.throws(() => parseRequests(undefined, '1 gig'), /PORTAL_K8S_MEMORY_REQUEST is not usable/);
  assert.throws(() => parseRequests('250m; rm -rf /', undefined), /not usable/);
});

test('the request is the smaller of the wanted value and the limit, and only where there is a limit', () => {
  const want = { cpu: '250m', memory: '1Gi' };
  assert.deepEqual(requestsFor({ cpu: '2', memory: '4096Mi' }, want), { cpu: '250m', memory: '1Gi' });
  assert.deepEqual(requestsFor({ cpu: '100m', memory: '512Mi' }, want), { cpu: '100m', memory: '512Mi' });
  assert.deepEqual(requestsFor({ memory: '4096Mi' }, want), { memory: '1Gi' });
  assert.deepEqual(requestsFor({ cpu: '1' }, { memory: '1Gi' }), undefined);
  assert.equal(requestsFor({}, want), undefined);
  assert.equal(requestsFor({ cpu: '2' }, undefined), undefined);
});
