// QA regression (QA-003): the private-address guard for custom hosts must not be bypassed by another spelling of the address.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertReachableHost, embeddedIPv4, isPrivateAddress, normalizeBaseUrl } from '../accounts/check.js';

/** What `new URL` makes of the host, which is what the guard really sees. */
const hostOf = (url: string) => new URL(normalizeBaseUrl(url)).hostname.replace(/^\[|\]$/g, '');

test('IPv6 spellings of private IPv4 addresses are private (IPv4-mapped, compatible, NAT64, 6to4)', () => {
  const spellings = [
    'http://[::ffff:127.0.0.1]:4599', // URL parser rewrites it to ::ffff:7f00:1
    'http://[::ffff:7f00:1]',
    'http://[0:0:0:0:0:ffff:127.0.0.1]',
    'http://[::ffff:169.254.169.254]', // cloud metadata
    'http://[::ffff:a9fe:a9fe]',
    'http://[::ffff:192.168.0.1]',
    'http://[::ffff:10.1.2.3]',
    'http://[::127.0.0.1]', // IPv4-compatible
    'http://[::7f00:1]',
    'http://[::ffff:0:127.0.0.1]', // IPv4-translated (SIIT)
    'http://[64:ff9b::7f00:1]', // NAT64 of 127.0.0.1
    'http://[64:ff9b::a9fe:a9fe]', // NAT64 of the metadata address
    'http://[2002:7f00:1::1]', // 6to4 of 127.0.0.1
    'http://[2002:c0a8:1::]', // 6to4 of 192.168.0.1
  ];
  for (const url of spellings) assert.equal(isPrivateAddress(hostOf(url)), true, `${url} -> ${hostOf(url)}`);
});

test('IPv6 special-use ranges are private', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', '2001::1', '2001:db8::1', '100::1', '64:ff9b:1::1'])
    assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress('not an ip'), true, 'anything that is not an address is refused');
});

test('public addresses stay public, in every spelling', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '160.79.104.10', '2606:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:1.1.1.1', '::ffff:101:101', '64:ff9b::808:808', '2002:808:808::1', '2001:4860:4860::8888'])
    assert.equal(isPrivateAddress(ip), false, ip);
});

test('IPv4 special-use ranges are private', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['172.15.0.1', '172.32.0.1', '192.0.3.1', '100.63.0.1', '198.20.0.1', '203.0.114.1']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('embeddedIPv4 reads the IPv4 an IPv6 address carries', () => {
  assert.equal(embeddedIPv4('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(embeddedIPv4('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(embeddedIPv4('64:ff9b::a9fe:a9fe'), '169.254.169.254');
  assert.equal(embeddedIPv4('2002:c0a8:1::'), '192.168.0.1');
  assert.equal(embeddedIPv4('2606:4700::1111'), null);
  assert.equal(embeddedIPv4('127.0.0.1'), null, 'an IPv4 address carries nothing');
});

test('a custom host on a private address is refused unless the endpoint allows it', async () => {
  for (const url of ['http://127.0.0.1:4599', 'http://[::ffff:127.0.0.1]:4599', 'http://[::ffff:169.254.169.254]', 'http://[64:ff9b::7f00:1]', 'http://[::1]'])
    await assert.rejects(() => assertReachableHost(normalizeBaseUrl(url), false), /private address/, url);
  for (const url of ['http://127.0.0.1:4599', 'http://[::ffff:127.0.0.1]:4599']) await assertReachableHost(normalizeBaseUrl(url), true);
  await assertReachableHost('https://[2606:4700::1111]', false);
});
