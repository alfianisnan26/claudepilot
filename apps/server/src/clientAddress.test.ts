// The client address (PILOT-1111 context view, rate limits): the proxy's own X-Forwarded-For entry when the proxy is trusted, the socket
// otherwise; a header a client sets itself is never believed when trust is off, and only the proxy-appended last entry counts when it is on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAddress, ipFamily, plainIp } from './clientAddress.js';

test('clientAddress: direct connection, trust off: the socket address; a client-set X-Forwarded-For is ignored', () => {
  assert.equal(clientAddress(undefined, '203.0.113.7', false), '203.0.113.7');
  assert.equal(clientAddress('1.2.3.4', '203.0.113.7', false), '203.0.113.7', 'not spoofable');
});

test('clientAddress: behind a trusted proxy: the last entry (the one the proxy appended), not what the client prepended', () => {
  assert.equal(clientAddress('198.51.100.9', '10.42.0.5', true), '198.51.100.9');
  assert.equal(clientAddress('1.2.3.4, 198.51.100.9', '10.42.0.5', true), '198.51.100.9', 'a forged first entry is skipped');
  assert.equal(clientAddress(undefined, '10.42.0.5', true), '10.42.0.5', 'no header: the socket');
  assert.equal(clientAddress(undefined, undefined, false), 'unknown');
});

test('ipFamily and plainIp', () => {
  assert.equal(ipFamily('203.0.113.7'), 4);
  assert.equal(ipFamily('::ffff:203.0.113.7'), 4);
  assert.equal(plainIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipFamily('2001:db8::1'), 6);
  assert.equal(ipFamily('unknown'), null);
});
