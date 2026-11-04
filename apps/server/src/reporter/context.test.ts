// Context (PILOT-1111): the panel's /me says the client address the portal sees, and a report filed through the widget stores that address
// on its evidence record (the page never sends it) and names it in the ticket's "Where" section. The address rule itself (trusted proxy vs
// direct, not spoofable) is clientAddress.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInternalIp, reporterIpText } from '@portal/contracts';
import { clientAddress, parseCidrs } from '../clientAddress.js';
import { releaseOf } from './routes.js';
import { build, capture, reporterHarness } from './testkit.js';

test('/me returns the client address and its family; a widget ticket stores it and its description names it', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const me = (await (await h.call('/reporter/v1/me', { token: t })).json()) as { data: { clientIp: string; clientIpFamily: number } };
    assert.equal(me.data.clientIp, '127.0.0.1', 'the testkit clientKey');
    assert.equal(me.data.clientIpFamily, 4);
    const r = await h.postJson('/reporter/v1/tickets', t, { summary: 'From here', captures: [capture()], build: build(), sdkVersion: '1', reporterIp: '6.6.6.6' });
    assert.equal(r.status, 201);
    const key = ((await r.json()) as { data: { key: string } }).data.key;
    const id = h.tickets.resolve({ kind: 'system' }, key)!;
    const ev = h.service.evidence(id)!;
    assert.equal(ev.reporterIp, '127.0.0.1', 'what the portal saw, not what the body claimed');
    const desc = (h.store.db!.prepare('SELECT description FROM tickets WHERE number = ?').get(Number(id.slice(2))) as { description: string }).description;
    assert.match(desc, /- Reporter IP: `127\.0\.0\.1` \(internal: behind the cluster proxy\)/, "a loopback or cluster address is labelled, not shown as the client's public IP");
  } finally {
    h.done();
  }
});

test('behind Cloudflare: the reporter IP is CF-Connecting-IP when the hop is the tunnel, never a header from a public peer (audit 2026-11-01)', async () => {
  // The app's visitorAddress: Traefik's hop from X-Forwarded-For (here fixed per request by a test header), Cloudflare trusted.
  const h = await reporterHarness({
    visitorIp: (c) =>
      clientAddress(c.req.header('x-test-hop'), '10.42.0.5', true, { connectingIp: c.req.header('cf-connecting-ip'), trusted: true, hops: parseCidrs('10.42.0.17').hops }),
  });
  try {
    const t = h.mint().token;
    const me = async (headers: Record<string, string>) =>
      ((await (await h.call('/reporter/v1/me', { token: t, headers })).json()) as { data: { clientIp: string } }).data.clientIp;
    assert.equal(await me({ 'x-test-hop': '10.42.0.17', 'cf-connecting-ip': '198.51.100.23' }), '198.51.100.23', 'through the tunnel');
    assert.equal(await me({ 'x-test-hop': '203.0.113.66', 'cf-connecting-ip': '198.51.100.1' }), '203.0.113.66', 'spoofed from a public peer: ignored');
    const r = await h.call('/reporter/v1/tickets', {
      method: 'POST',
      token: t,
      headers: { 'content-type': 'application/json', 'x-test-hop': '10.42.0.17', 'cf-connecting-ip': '198.51.100.23' },
      body: JSON.stringify({ summary: 'Via Cloudflare', captures: [capture()], build: build(), sdkVersion: '1' }),
    });
    assert.equal(r.status, 201);
    const key = ((await r.json()) as { data: { key: string } }).data.key;
    assert.equal(h.service.evidence(h.tickets.resolve({ kind: 'system' }, key)!)!.reporterIp, '198.51.100.23', 'the stored IP is the visitor’s');
  } finally {
    h.done();
  }
});

test('/me names the portal release when the image carries it, null when not (the panel then says unknown)', async () => {
  for (const [release, want] of [['2026.10.31-5', '2026.10.31-5'], [undefined, null]] as const) {
    const h = await reporterHarness(release ? { release } : {});
    try {
      const me = (await (await h.call('/reporter/v1/me', { token: h.mint().token })).json()) as { data: { portalRelease: string | null } };
      assert.equal(me.data.portalRelease, want);
    } finally {
      h.done();
    }
  }
  assert.equal(releaseOf('2026.10.31-5'), '2026.10.31-5');
  for (const bad of [undefined, '', 'a b', '<script>', 'x'.repeat(65)]) assert.equal(releaseOf(bad), null, String(bad));
});

test('isInternalIp: private, loopback and cluster ranges are internal (labelled); public addresses are not', () => {
  for (const ip of ['10.42.1.7', '127.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.2', '::1', 'fc00::1', 'fd12:3456::7', '::ffff:10.42.0.9'])
    assert.equal(isInternalIp(ip), true, ip);
  for (const ip of ['203.0.113.7', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '2001:db8::1', 'fe00::1', 'unknown', '', null])
    assert.equal(isInternalIp(ip), false, String(ip));
  assert.equal(reporterIpText('10.42.1.7'), '10.42.1.7 (internal: behind the cluster proxy)');
  assert.equal(reporterIpText('203.0.113.7'), '203.0.113.7');
});
