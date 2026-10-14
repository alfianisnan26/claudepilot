// T-126 items 1 and 2: a quota alert reaches a person only for a Claude a chat runs on (or one they watch), and it is ONE Inbox row per
// Claude, window and period that updates in place: a push only when it gets worse, never twice for one stage, Recovered once the window
// resets. The clock is fake (no real date is relied on).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeUsageAlert, NotifyEvent } from '@portal/contracts';
import { adaptUsage } from './adapters/usage.js';
import { createBus } from './bus.js';
import { render } from './templates.js';
import { fakeBrowser, harness, session, standIn, until } from './testkit.js';

const T0 = Date.parse('2026-10-12T15:34:00.000Z');
const RESET = new Date(T0 + 4 * 3_600_000).toISOString();
const NEXT_RESET = new Date(T0 + 9 * 3_600_000).toISOString();
const base = { claude: 'fadlilah', window: 'Session', resetsAt: RESET };
const near = { ...base, level: 'near', leftPct: 20, chats: 1 };
const proj = { ...base, level: 'projection', projection: true, leftPct: 20, etaAt: new Date(T0 + 3 * 3_600_000).toISOString(), chats: 1 };
const high = { ...base, level: 'high', leftPct: 5, chats: 1 };
const out = { ...base, level: 'exhausted', leftPct: 0, chats: 1 };

async function setup() {
  let now = T0;
  const svc = await standIn();
  const h = await harness({ now: () => new Date(now) });
  h.notify.start();
  const phone = fakeBrowser(`http://push.example.test:${svc.port}/send/a`);
  const dest = h.notify.destinations.registerPush('u_a', { subscription: phone.subscription, tz: 'Asia/Jakarta' }).destination;
  h.notify.destinations.update(dest.id, 'u_a', { kinds: ['quota_low'] });
  const emit = (facts: Record<string, string | number | boolean | null>) => h.bus.emit({ kind: 'quota_low', subject: { type: 'claude', id: 'c1' }, facts });
  const rows = () => h.store.db!.prepare("SELECT id, at, body, read_at, resolved_at, resolution, stage FROM notify_history WHERE kind = 'quota_low' ORDER BY at").all() as { id: string; at: string; body: string; read_at: string | null; resolved_at: string | null; resolution: string | null; stage: number }[];
  const status = () => h.notify.history.deliveries('u_a', { limit: 100 }).reverse().map((d) => (d.status === 'sent' ? 'sent' : `${d.status}:${d.code}`));
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 20));
    await until(() => svc.got.length === status().filter((s) => s === 'sent').length);
  };
  return { h, svc, emit, rows, status, settle, advance: (ms: number) => void (now += ms), close: async () => (h.notify.stop(), await svc.close()) };
}

test('relevance: no chat on the Claude and not watched is no row and no push; a chat, a watch, or not known is an alert', async () => {
  const s = await setup();
  try {
    s.emit({ ...high, chats: 0 });
    await s.settle();
    assert.equal(s.rows().length, 0, 'an idle Claude near its limit is information, not an Inbox row');
    assert.deepEqual(s.status(), [], 'and not a push');

    s.h.notify.history.setWatch('u_a', 'c1', true);
    assert.equal(s.h.notify.history.watches('u_a', 'c1'), true);
    s.emit({ ...high, chats: 0 });
    await s.settle();
    assert.equal(s.rows().length, 1, 'a watched Claude alerts when idle');
    assert.match(s.rows()[0]!.body, /· idle$/);
    assert.deepEqual(s.status(), ['sent']);

    s.h.notify.history.setWatch('u_a', 'c1', false);
    s.h.notify.history.clear('u_a');
    s.emit({ ...out });
    await s.settle();
    assert.equal(s.rows().length, 1, 'a Claude a chat runs on alerts');
    assert.match(s.rows()[0]!.body, /· 1 chat$/);

    s.h.notify.history.clear('u_a');
    const { chats: _gone, ...unknown } = high;
    s.emit(unknown);
    await s.settle();
    assert.equal(s.rows().length, 1, 'not known (no chat list): the alert goes as before');
  } finally {
    await s.close();
  }
});

test('one row that updates: near, projected, again, high, a milder projection, out: one row, one push per worsening; Recovered at the reset', async () => {
  const s = await setup();
  try {
    s.emit(near);
    await s.settle();
    assert.equal(s.rows().length, 1);
    assert.deepEqual(s.status(), [], 'near (80 %) is a row only');

    s.advance(60_000);
    s.emit(proj);
    await s.settle();
    assert.equal(s.rows().length, 1, 'the same row');
    assert.equal(s.rows()[0]!.stage, 1);
    assert.deepEqual(s.status(), ['sent'], 'worse: pushed');
    s.h.notify.history.markRead('u_a');

    s.advance(60_000);
    s.emit({ ...proj, etaAt: new Date(T0 + 2 * 3_600_000).toISOString() });
    await s.settle();
    assert.equal(s.rows().length, 1);
    assert.deepEqual(s.status(), ['sent', 'suppressed:collapsed'], 'the same stage is never pushed twice');
    assert.notEqual(s.rows()[0]!.read_at, null, 'and stays read');

    s.advance(60_000);
    const before = s.rows()[0]!.at;
    s.emit(high);
    await s.settle();
    const afterHigh = s.rows();
    assert.equal(afterHigh.length, 1);
    assert.equal(afterHigh[0]!.stage, 2);
    assert.match(afterHigh[0]!.body, /5\s?% left/);
    assert.equal(afterHigh[0]!.read_at, null, 'worse: unread again');
    assert.ok(afterHigh[0]!.at > before, 'and at the top (the time of the worse event)');
    assert.deepEqual(s.status(), ['sent', 'suppressed:collapsed', 'sent']);

    s.advance(60_000);
    s.emit(proj);
    await s.settle();
    assert.deepEqual(s.rows(), afterHigh, 'a milder stage leaves the row as it is');
    assert.deepEqual(s.status().at(-1), 'suppressed:collapsed');

    s.advance(60_000);
    s.emit({ ...out, resetsAt: new Date(Date.parse(RESET) + 20_000).toISOString() });
    await s.settle();
    assert.equal(s.rows().length, 1, 'a reset time a few seconds off is the same period');
    assert.equal(s.rows()[0]!.stage, 3);
    assert.deepEqual(s.status().filter((x) => x === 'sent').length, 3);

    // the window resets: the next tick closes the row as Recovered
    s.advance(4 * 3_600_000);
    await s.h.notify.pipeline.tick();
    assert.equal(s.rows()[0]!.resolution, 'Recovered');
    assert.notEqual(s.rows()[0]!.resolved_at, null);

    // the next period opens a new row
    s.emit({ ...near, resetsAt: NEXT_RESET });
    await s.settle();
    assert.equal(s.rows().length, 2);
    assert.equal(s.rows()[1]!.resolved_at, null);
  } finally {
    await s.close();
  }
});

test('an open row of an earlier period is closed as Recovered when the next period alerts', async () => {
  const s = await setup();
  try {
    s.emit(high);
    await s.settle();
    s.advance(60_000); // no tick ran across the reset
    s.emit({ ...high, resetsAt: NEXT_RESET });
    await s.settle();
    const r = s.rows();
    assert.equal(r.length, 2);
    assert.equal(r[0]!.resolution, 'Recovered');
    assert.equal(r[1]!.resolved_at, null);
    assert.deepEqual(s.status(), ['sent', 'sent'], 'a new period is a new alert');
  } finally {
    await s.close();
  }
});

test('the usage adapter counts the chats on the Claude (not ended, a number only: no title in facts)', () => {
  const bus = createBus();
  const got: NotifyEvent[] = [];
  bus.on('*', (e) => void got.push(e));
  let fire: (a: ClaudeUsageAlert) => void = () => undefined;
  const usage = { onAlert: (fn: (a: ClaudeUsageAlert) => void) => ((fire = fn), () => undefined) };
  const chats = [session('s_1', { claudeId: 'c1', state: 'working', title: 'CANARY-TITLE' }), session('s_2', { claudeId: 'c1', state: 'ended' }), session('s_3', { claudeId: 'c2', state: 'idle' })];
  adaptUsage(usage, bus, (id) => chats.filter((c) => c.claudeId === id && c.state !== 'ended').length);
  const alert = (claudeId: string): ClaudeUsageAlert => ({ id: `${claudeId}|session|high|1`, claudeId, claudeName: 'fadlilah', workspaceName: 'kohi-event', window: 'session', label: 'Session', level: 'high', usedPct: 95, resetsAt: RESET, at: new Date(T0).toISOString() });
  fire(alert('c1'));
  fire(alert('c3'));
  assert.equal(got[0]!.facts.chats, 1);
  assert.equal(got[1]!.facts.chats, 0);
  assert.doesNotMatch(JSON.stringify(got), /CANARY-TITLE/);

  const plain = createBus();
  const seen: NotifyEvent[] = [];
  plain.on('*', (e) => void seen.push(e));
  adaptUsage(usage, plain, () => {
    throw new Error('chat list down');
  });
  fire(alert('c1'));
  assert.equal('chats' in seen[0]!.facts, false, 'a chat list that fails: not known, the alert goes as before');
});

test('the quota text names who it concerns: chats on the Claude, idle when watched, nothing when not known', () => {
  const e = (facts: Record<string, string | number | boolean | null>) => ({ id: 'evt_1', kind: 'quota_low', at: new Date(T0).toISOString(), subject: { type: 'claude', id: 'c1' }, facts }) as NotifyEvent;
  assert.match(render(e({ ...high, chats: 3 }), { tz: 'UTC', now: T0 }).body, /fadlilah · Session · 5\s?% left · resets 19:34 · 3 chats$/);
  assert.match(render(e({ ...proj, chats: 0 }), { tz: 'UTC', now: T0 }).body, /· idle$/);
  const { chats: _c, ...unknown } = high;
  assert.match(render(e(unknown), { tz: 'UTC', now: T0 }).body, /resets 19:34$/);
});
