import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNodeSelector } from './nodeSelector.js';

test('unset or blank means no selector', () => {
  assert.equal(parseNodeSelector(undefined), undefined);
  assert.equal(parseNodeSelector(''), undefined);
  assert.equal(parseNodeSelector('  '), undefined);
});

test('one or several key=value pairs, with spaces tolerated', () => {
  assert.deepEqual(parseNodeSelector('kubernetes.io/hostname=k3s-node2'), { 'kubernetes.io/hostname': 'k3s-node2' });
  assert.deepEqual(parseNodeSelector(' disk=ssd , example.com/pool = workspaces '), { disk: 'ssd', 'example.com/pool': 'workspaces' });
  assert.deepEqual(parseNodeSelector('flag='), { flag: '' });
});

test('a malformed value stops the portal instead of being half understood', () => {
  for (const bad of ['k3s-node2', '=x', 'a=b=c', 'a=b,,c=d', 'a b=c', 'a=b c', '-a=b', 'a=-b', `${'k'.repeat(64)}=v`, 'a=b;rm -rf /', '/a=b']) {
    assert.throws(() => parseNodeSelector(bad), /PORTAL_K8S_NODE_SELECTOR is not usable/, bad);
  }
});
