// The client address (PILOT-1111 context view, rate limits): the proxy's own X-Forwarded-For entry when the proxy is trusted, the socket
// otherwise; a header a client sets itself is never believed when trust is off, and only the proxy-appended last entry counts when it is on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAddress, ipFamily, isPrivateIp, plainIp } from './clientAddress.js';

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

test('clientAddress: behind Cloudflare and Traefik: CF-Connecting-IP when the hop is ours; a spoofed one from an untrusted peer is ignored', () => {
  const cf = (connectingIp: string | undefined, trusted = true) => ({ connectingIp, trusted });
  // Cloudflare's tunnel pod is the hop Traefik saw (a cluster address): the visitor is the header's address (v4 or v6).
  assert.equal(clientAddress('10.42.0.17', '10.42.0.5', true, cf('198.51.100.23')), '198.51.100.23');
  assert.equal(clientAddress('1.2.3.4, 10.42.0.17', '10.42.0.5', true, cf('2001:db8::7')), '2001:db8::7');
  assert.equal(clientAddress(undefined, '::ffff:10.42.0.5', true, cf('198.51.100.23')), '198.51.100.23', 'no X-Forwarded-For: the socket is the hop');
  // A request that reached Traefik from the internet: its hop is public, so a CF-Connecting-IP it carries is the client's own.
  assert.equal(clientAddress('203.0.113.66', '10.42.0.5', true, cf('198.51.100.1')), '203.0.113.66', 'spoofed header from a public peer');
  // Cloudflare not trusted, or the proxy not trusted: never read.
  assert.equal(clientAddress('10.42.0.17', '10.42.0.5', true, cf('198.51.100.23', false)), '10.42.0.17');
  assert.equal(clientAddress('10.42.0.17', '203.0.113.7', false, cf('198.51.100.23')), '203.0.113.7', 'trust off: the socket only');
  // Not an address (or missing): the hop as before.
  assert.equal(clientAddress('10.42.0.17', '10.42.0.5', true, cf('evil, 1.1.1.1')), '10.42.0.17');
  assert.equal(clientAddress('10.42.0.17', '10.42.0.5', true, cf(undefined)), '10.42.0.17');
});

test('isPrivateIp: our networks only', () => {
  for (const ip of ['10.42.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.2', '127.0.0.1', '100.64.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
    assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['203.0.113.7', '172.32.0.1', '8.8.8.8', '2001:db8::1', 'unknown', '100.128.0.1'])
    assert.equal(isPrivateIp(ip), false, ip);
});

test('ipFamily and plainIp', () => {
  assert.equal(ipFamily('203.0.113.7'), 4);
  assert.equal(ipFamily('::ffff:203.0.113.7'), 4);
  assert.equal(plainIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipFamily('2001:db8::1'), 6);
  assert.equal(ipFamily('unknown'), null);
});
