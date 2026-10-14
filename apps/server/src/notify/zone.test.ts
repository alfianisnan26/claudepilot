// T-126 item 5: every time in a notification is in the RECIPIENT's zone. A phone in Asia/Jakarta and one in UTC get the same quota
// alert in their own clocks; the Inbox row keeps instants (marks) for the reader's own zone; a webhook says its zone; a device that
// registered without a zone (or with UTC) is repaired from what it reports later; a zone the person picked stays. The clock is fake:
// Monday 2026-10-12 15:34 UTC (22:34 in Jakarta), the reset at 19:40 UTC is 02:40 TUESDAY in Jakarta (the day boundary).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillTimeMarks, zonedTime, zoneLabel, type PushPayload } from '@portal/contracts';
import { render } from './templates.js';
import { fakeBrowser, harness, standIn, until } from './testkit.js';

const NOW = Date.parse('2026-10-12T15:34:00.000Z');
const quota = { level: 'high', claude: 'fadlilah', window: 'Session', leftPct: 20, resetsAt: '2026-10-12T19:40:00.000Z' };
const projection = { ...quota, projection: true, etaAt: '2026-10-12T19:26:00.000Z' };

test('zonedTime: same day, within a week, further; the day is the zone’s own, across a DST change', () => {
  assert.equal(zonedTime('2026-10-12T19:40:00.000Z', NOW, 'UTC'), '19:40');
  assert.equal(zonedTime('2026-10-12T19:40:00.000Z', NOW, 'Asia/Jakarta'), 'Tue 02:40'); // 22:34 Mon now, 02:40 Tue then
  assert.equal(zonedTime('2026-10-12T16:00:00.000Z', NOW, 'Asia/Jakarta'), '23:00');
  assert.equal(zonedTime('2026-10-30T09:00:00.000Z', NOW, 'UTC'), '30 Oct 09:00');
  // New York springs forward at 02:00 on Sunday 8 March 2026: 23:00 EST Saturday is now; 07:30 UTC is 03:30 EDT on Sunday.
  const ny = Date.parse('2026-03-08T04:00:00.000Z');
  assert.equal(zonedTime('2026-03-08T04:59:00.000Z', ny, 'America/New_York'), '23:59');
  assert.equal(zonedTime('2026-03-08T07:30:00.000Z', ny, 'America/New_York'), 'Sun 03:30');
  assert.equal(zoneLabel('2026-03-08T06:59:00.000Z', 'America/New_York'), 'GMT-5');
  assert.equal(zoneLabel('2026-03-08T07:00:00.000Z', 'America/New_York'), 'GMT-4');
  assert.equal(zonedTime('not a time', NOW, 'UTC'), '');
  assert.equal(zonedTime('2026-10-12T19:40:00.000Z', NOW, 'Mars/Olympus'), '19:40', 'an unknown zone reads as UTC');
});

test('render: the recipient’s zone, the zone said only for a channel that is not a device, marks for the Inbox', () => {
  const e = { id: 'evt_1', kind: 'quota_low', at: new Date(NOW).toISOString(), subject: { type: 'claude', id: 'c1' }, facts: projection } as never;
  assert.equal(render(e, { tz: 'Asia/Jakarta', now: NOW }).body, 'fadlilah · Session · out by Tue 02:26 est. · resets Tue 02:40');
  assert.equal(render(e, { tz: 'UTC', now: NOW }).body, 'fadlilah · Session · out by 19:26 est. · resets 19:40');
  assert.equal(render(e, { tz: 'Asia/Jakarta', now: NOW, labelZone: true }).body, 'fadlilah · Session · out by Tue 02:26 GMT+7 est. · resets Tue 02:40 GMT+7');
  const marked = render(e, { marks: true }).body;
  assert.equal(fillTimeMarks(marked, (iso) => zonedTime(iso, NOW, 'Asia/Jakarta')), 'fadlilah · Session · out by Tue 02:26 est. · resets Tue 02:40');
  assert.ok(!/\d\d:\d\d/.test(marked.replace(/⟦t:[^⟧]+⟧/g, '')), 'no clock time is fixed in the stored text');
});

test('a quota alert to a phone in Asia/Jakarta and one in UTC: each in its own clock; the Inbox row keeps instants', async () => {
  const svc = await standIn();
  const h = await harness({ owners: { 'claude:c1': 'u_a' }, now: () => new Date(NOW) });
  try {
    h.notify.start();
    const jkt = fakeBrowser(`http://push.example.test:${svc.port}/send/jkt`);
    const utc = fakeBrowser(`http://push.example.test:${svc.port}/send/utc`);
    h.notify.destinations.registerPush('u_a', { subscription: jkt.subscription, tz: 'Asia/Jakarta' });
    h.notify.destinations.registerPush('u_a', { subscription: utc.subscription, tz: 'UTC' });
    h.bus.emit({ kind: 'quota_low', subject: { type: 'claude', id: 'c1' }, facts: quota });
    await until(() => svc.got.length === 2);
    const said = (b: ReturnType<typeof fakeBrowser>, path: string) => (b.open(svc.got.find((g) => g.path.endsWith(path))!.body) as PushPayload).notification.body;
    assert.equal(said(jkt, '/jkt'), 'fadlilah · Session · 20 % left · resets Tue 02:40');
    assert.equal(said(utc, '/utc'), 'fadlilah · Session · 20 % left · resets 19:40');
    const row = h.notify.history.page('u_a').items[0]!;
    assert.equal(row.body, 'fadlilah · Session · 20 % left · resets 19:40 UTC', 'a reader without a zone gets UTC, said as such');
    assert.equal(fillTimeMarks(row.bodyMarked!, (iso) => zonedTime(iso, NOW, 'Asia/Jakarta')), 'fadlilah · Session · 20 % left · resets Tue 02:40');
  } finally {
    h.notify.stop();
    await svc.close();
  }
});

test('a webhook says the zone it writes in', async () => {
  const svc = await standIn(() => ({ status: 200 }));
  const h = await harness({ owners: { 'claude:c1': 'u_a' }, now: () => new Date(NOW) });
  try {
    h.notify.start();
    const { destination } = h.notify.destinations.createChannel('u_a', { type: 'webhook', name: 'Ops', url: `http://hooks.example.test:${svc.port}/in` });
    h.notify.destinations.update(destination.id, 'u_a', { kinds: ['quota_low'], tz: 'Asia/Jakarta' });
    h.bus.emit({ kind: 'quota_low', subject: { type: 'claude', id: 'c1' }, facts: quota });
    await until(() => svc.got.length === 1);
    assert.equal((JSON.parse(svc.got[0]!.body.toString()) as { body: string }).body, 'fadlilah · Session · 20 % left · resets Tue 02:40 GMT+7');
  } finally {
    h.notify.stop();
    await svc.close();
  }
});

test('a device registered without a zone (or with UTC) is repaired from the zone it reports; one the person picked stays', async () => {
  const h = await harness({ now: () => new Date(NOW) });
  try {
    const b = fakeBrowser('https://push.example.test/send/a');
    const zone = () => h.notify.destinations.list('u_a')[0]!.quiet.tz;
    const d = h.notify.destinations.registerPush('u_a', { subscription: b.subscription }).destination;
    assert.equal(zone(), 'UTC');
    h.notify.destinations.registerPush('u_a', { subscription: b.subscription, tz: 'Asia/Jakarta' });
    assert.equal(zone(), 'Asia/Jakarta', 'repaired from the device');
    h.notify.destinations.registerPush('u_a', { subscription: b.subscription });
    assert.equal(zone(), 'Asia/Jakarta', 'a registration without a zone keeps the one it had');
    h.notify.destinations.update(d.id, 'u_a', { tz: 'Europe/London' });
    h.notify.destinations.registerPush('u_a', { subscription: b.subscription, tz: 'Asia/Jakarta' });
    assert.equal(zone(), 'Europe/London', 'a zone picked under Quiet hours is the person’s choice');
  } finally {
    h.notify.stop();
  }
});
