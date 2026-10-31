// Context (PILOT-1111): the panel's /me says the client address the portal sees, and a report filed through the widget stores that address
// on its evidence record (the page never sends it) and names it in the ticket's "Where" section. The address rule itself (trusted proxy vs
// direct, not spoofable) is clientAddress.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
    const desc = (h.store.db.prepare('SELECT description FROM tickets WHERE number = ?').get(Number(id.slice(2))) as { description: string }).description;
    assert.match(desc, /- Reporter IP: `127\.0\.0\.1` \(as the portal saw it\)/);
  } finally {
    h.done();
  }
});
