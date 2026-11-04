// The client address (PILOT-1111 context view, rate limits): the proxy's own X-Forwarded-For entry when the proxy is trusted, the socket
// otherwise; a header a client sets itself is never believed when trust is off, and only the proxy-appended last entry counts when it is on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAddress, cloudflareTrustWarnings, inCidrs, ipFamily, isPrivateIp, parseCidrs, plainIp } from './clientAddress.js';

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
  const tunnel = parseCidrs('10.42.0.17, 10.42.0.5').hops;
  const cf = (connectingIp: string | undefined, trusted = true, hops = tunnel) => ({ connectingIp, trusted, hops });
  // Cloudflare's tunnel pod is the hop Traefik saw (a cluster address on the list): the visitor is the header's address (v4 or v6).
  assert.equal(clientAddress('10.42.0.17', '10.42.0.5', true, cf('198.51.100.23')), '198.51.100.23');
  assert.equal(clientAddress('1.2.3.4, 10.42.0.17', '10.42.0.5', true, cf('2001:db8::7')), '2001:db8::7');
  assert.equal(clientAddress(undefined, '::ffff:10.42.0.5', true, cf('198.51.100.23')), '198.51.100.23', 'no X-Forwarded-For: the socket is the hop');
  // PILOT-1179: a private hop NOT on the list (a workspace pod) is not the tunnel: its header is ignored, the hop is the address.
  assert.equal(clientAddress('10.42.1.53', '10.42.0.5', true, cf('198.51.100.23')), '10.42.1.53', 'a private hop off the list');
  assert.equal(clientAddress('192.168.1.9', '10.42.0.5', true, cf('198.51.100.23')), '192.168.1.9');
  // An empty list (the default) trusts no hop at all, even with Cloudflare trusted.
  assert.equal(clientAddress('10.42.0.17', '10.42.0.5', true, cf('198.51.100.23', true, [])), '10.42.0.17', 'empty list: never read');
  // A range on the list covers its addresses only.
  const range = parseCidrs('10.43.7.0/24').hops;
  assert.equal(clientAddress('10.43.7.200', '10.42.0.5', true, cf('198.51.100.23', true, range)), '198.51.100.23', 'in the /24');
  assert.equal(clientAddress('10.43.8.1', '10.42.0.5', true, cf('198.51.100.23', true, range)), '10.43.8.1', 'outside the /24');
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

test('parseCidrs and inCidrs: addresses and ranges, v4 and v6; a typo is dropped and named, never widened', () => {
  const { hops, dropped } = parseCidrs(' 10.42.0.17 , 10.43.7.0/24, fd00::/8, 2001:db8::5, 10.0.0.0/33, 300.1.1.1, nonsense, 10.1.0.0/16/1, ');
  assert.deepEqual(dropped, ['10.0.0.0/33', '300.1.1.1', 'nonsense', '10.1.0.0/16/1']);
  assert.equal(hops.length, 4);
  for (const ip of ['10.42.0.17', '::ffff:10.42.0.17', '10.43.7.0', '10.43.7.255', 'fd12:3456::1', '2001:db8::5', '2001:0db8:0:0:0:0:0:5']) assert.equal(inCidrs(ip, hops), true, ip);
  for (const ip of ['10.42.0.18', '10.43.6.255', '10.43.8.0', 'fe80::1', '2001:db8::6', 'unknown', '', '1:2:3:4:5:6:7:8:9']) assert.equal(inCidrs(ip, hops), false, ip);
  assert.deepEqual(parseCidrs(undefined), { hops: [], dropped: [] });
  assert.equal(inCidrs('203.0.113.7', parseCidrs('0.0.0.0/0').hops), true, 'a /0 is everything (the operator said so)');
  assert.equal(inCidrs('2001:db8::1', parseCidrs('0.0.0.0/0').hops), false, 'but never the other family');
});

test('cloudflareTrustWarnings: the boot log names an empty hop list, a dropped entry, and Cloudflare without the proxy', () => {
  const none = { hops: [], dropped: [] };
  assert.deepEqual(cloudflareTrustWarnings({ trustProxy: true, trustCloudflare: false, cloudflareHops: none }), [], 'Cloudflare off: nothing to say');
  assert.deepEqual(cloudflareTrustWarnings({ trustProxy: true, trustCloudflare: true, cloudflareHops: parseCidrs('10.42.0.17') }), []);
  assert.match(cloudflareTrustWarnings({ trustProxy: true, trustCloudflare: true, cloudflareHops: none }).join('\n'), /lists no hop.*shares its address/);
  assert.match(cloudflareTrustWarnings({ trustProxy: false, trustCloudflare: true, cloudflareHops: parseCidrs('10.42.0.17') }).join('\n'), /PORTAL_TRUST_PROXY is off/);
  assert.match(cloudflareTrustWarnings({ trustProxy: true, trustCloudflare: true, cloudflareHops: parseCidrs('10.42.0.17, 10.1/8') }).join('\n'), /ignored: 10\.1\/8/);
});

test('ipFamily and plainIp', () => {
  assert.equal(ipFamily('203.0.113.7'), 4);
  assert.equal(ipFamily('::ffff:203.0.113.7'), 4);
  assert.equal(plainIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipFamily('2001:db8::1'), 6);
  assert.equal(ipFamily('unknown'), null);
});
