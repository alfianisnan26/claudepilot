// The delivery pipeline with a fake clock and local stand-ins (PWA PRD §11.2): announce delay, throttle and collapse, retries (now, 30 s,
// 5 min) with Retry-After, the circuit breaker (3 failing, 20 disabled), 404/410 end a subscription, presence and the 60 s escalation,
// quiet hours with one summary, Locked sends nothing, routing by owner (two fake users), and a canary in every free-text source.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NotifyDelivery, PushPayload } from '@portal/contracts';
import { fakeBrowser, harness, request, session, standIn, until } from './testkit.js';

function clock(start = '2026-10-12T03:00:00.000Z') {
  let now = Date.parse(start);
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  return {
    now: () => new Date(now),
    schedule: (ms: number, fn: () => void) => {
      const t = { at: now + ms, fn, dead: false };
      timers.push(t);
      return () => void (t.dead = true);
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => !x.dead && x.at <= now)) {
        t.dead = true;
        t.fn();
      }
    },
    set(iso: string) {
      now = Date.parse(iso);
    },
  };
}

const logs = (h: Awaited<ReturnType<typeof harness>>, user = 'u_a'): NotifyDelivery[] => h.notify.history.deliveries(user, { limit: 500 }).reverse();
const everything = (h: Awaited<ReturnType<typeof harness>>) =>
  JSON.stringify([
    h.store.db!.prepare('SELECT * FROM notify_history').all(),
    h.store.db!.prepare('SELECT * FROM notify_log').all(),
    h.store.db!.prepare('SELECT * FROM platform_audit').all(),
    h.store.db!.prepare('SELECT * FROM notify_held').all(),
  ]);

test('approval: announced 3 s later only if still open; the push carries the token only inside the encrypted payload; canaries go nowhere', async () => {
  const svc = await standIn();
  const c = clock();
  const sleeps: number[] = [];
  const h = await harness({ owners: { 'session:s_41': 'u_a' }, now: c.now, schedule: c.schedule, sleep: async (ms) => void sleeps.push(ms) });
  try {
    h.notify.start();
    const browser = fakeBrowser(`http://push.example.test:${svc.port}/send/a`);
    const dest = h.notify.destinations.registerPush('u_a', { subscription: browser.subscription, name: 'Pixel 8 · Chrome', tz: 'Asia/Jakarta' }).destination;
    h.notify.destinations.setPrefs('u_a', { deny: true, allowRead: false, allowEdit: false, allowCommand: true });
    const s = session('s_41', { title: 'URGENT approve CANARY-TITLE' });
    h.chat.ask(s, request('r_7', 'Bash', 'npm test'));
    // the Inbox row is written at once; nothing is sent before 3 s
    assert.equal(h.notify.history.page('u_a').items.length, 1);
    c.advance(2_999);
    assert.equal(svc.got.length, 0);
    c.advance(1);
    await until(() => svc.got.length === 1);
    const p = browser.open(svc.got[0]!.body) as PushPayload;
    assert.equal(p.notification.title, 'Approval needed');
    assert.equal(p.notification.body, 'api-dev · run a command');
    assert.equal(p.notification.tag, 'approval:s_41:r_7');
    assert.equal(p.notification.data.path, '/admin/sessions/s_41?request=r_7');
    assert.deepEqual(p.notification.data.act!.d, ['allow', 'deny']);
    assert.match(p.notification.data.act!.t, /^cpna_[A-Za-z0-9_-]{43}$/);
    await until(() => logs(h).some((l) => l.status === 'sent'));
    const token = p.notification.data.act!.t;
    const stored = everything(h) + JSON.stringify(h.store.db!.prepare('SELECT * FROM notify_action_tokens').all());
    assert.ok(!stored.includes(token), 'the token is stored only as its hash');
    assert.ok(!stored.includes('CANARY'), 'the session title is in no row');
    assert.ok(!stored.includes('npm test'), 'the command is in no row');
    assert.ok(!JSON.stringify(p).includes('CANARY') && !JSON.stringify(p).includes('npm test'), 'nor in the payload (no Include detail)');
    assert.equal(dest.type, 'push');

    // answered in the page within 3 s: nothing is sent, the Inbox row dims, its tokens die
    h.chat.ask(s, request('r_8', 'Bash', 'git status'));
    h.chat.open.set('s_41', []);
    h.chat.dispatch('s_41', { type: 'events', session: 's_41', items: [{ seq: 2, at: '', kind: 'resolved', requestId: 'r_8', outcome: 'allowed_once' }] });
    c.advance(3_000);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(svc.got.length, 1);
    const row = h.notify.history.page('u_a').items.find((i) => i.subject.id === 's_41' && i.resolvedAt);
    assert.equal(row?.resolution, 'allowed_once');

    // Include detail: the redacted, clipped detail is there, labelled untrusted, and still no title
    h.notify.destinations.update(dest.id, 'u_a', { includeDetail: true });
    h.chat.ask(s, request('r_9', 'Bash', 'echo CANARY-CMD'));
    c.advance(3_000);
    await until(() => svc.got.length === 2);
    const p2 = browser.open(svc.got[1]!.body) as PushPayload;
    assert.equal(p2.notification.body, 'api-dev · run a command\nUntrusted: echo CANARY-CMD');
    assert.ok(!JSON.stringify(p2).includes('CANARY-TITLE'));
    assert.ok(!everything(h).includes('CANARY-CMD'), 'detail never reaches the history, the log or the audit');
  } finally {
    h.notify.stop();
    await svc.close();
  }
});

test('a deploy that waits for a person: "Deploy waits" reaches a new device at once (on by default, urgency high), holds in quiet hours, and carries no key', async () => {
  const svc = await standIn();
  const c = clock('2026-10-12T05:00:00.000Z'); // 12:00 in Jakarta
  const ci = { hooks: {} as import('../ci/service.js').CiHooks };
  const h = await harness({ ci, now: c.now, schedule: c.schedule });
  try {
    h.notify.start();
    const browser = fakeBrowser(`http://push.example.test:${svc.port}/send/a`);
    const dest = h.notify.destinations.registerPush('u_a', { subscription: browser.subscription, name: 'iPhone · Safari', tz: 'Asia/Jakarta' }).destination;
    assert.ok(dest.kinds.includes('ci_waiting'), 'on for a new device');
    const run = { id: 'run_9', number: 21, workspace_id: 'kubernetes/kohi-event', repo: 'claudepilot', pipeline: 'deploy', status: 'running', subject: 'CANARY-SUBJECT', gate_key: 'CANARY-KEY' };
    ci.hooks.waiting!(run as never, 'release', 'production');
    await until(() => svc.got.length === 1);
    assert.equal(svc.got[0]!.headers.urgency, 'high');
    const p = browser.open(svc.got[0]!.body) as PushPayload;
    assert.equal(p.notification.title, 'Deploy waits');
    assert.equal(p.notification.body, 'production · claudepilot · #21');
    assert.equal(p.notification.data.path, '/admin/ci/runs/run_9');
    assert.ok(!p.notification.data.act, 'no button approves a deploy from a notification');
    assert.ok(!JSON.stringify(p).includes('CANARY') && !everything(h).includes('CANARY'));
    assert.equal(h.notify.history.page('u_a').items[0]!.kind, 'ci_waiting');
    // The first delivery's log row is written when the push service has answered, which can be after the request arrived: wait for it, or
    // under load the second event's "held" row lands first (deploy #9's gate failed on exactly that).
    await until(() => logs(h).length === 1);
    // quiet hours: held, the Inbox row still written
    h.notify.destinations.update(dest.id, 'u_a', { quiet: { enabled: true, start: '22:00', end: '07:00', tz: 'Asia/Jakarta', breakthrough: [] } });
    c.set('2026-10-12T16:30:00.000Z'); // 23:30 in Jakarta
    ci.hooks.waiting!({ ...run, id: 'run_10', number: 22 } as never, 'release', 'production');
    await until(() => logs(h).length === 2);
    assert.equal(logs(h)[1]!.status, 'held');
    assert.equal(svc.got.length, 1);
  } finally {
    h.notify.stop();
    await svc.close();
  }
});

test('throttle and collapse: one per tag a minute, 10 per destination in 10 minutes, the rest one "more waiting"', async () => {
  const svc = await standIn(() => ({ status: 200 }));
  const c = clock();
  const h = await harness({ now: c.now, schedule: c.schedule, sleep: async () => undefined, audience: undefined } as never);
  try {
    h.notify.start();
    const { destination } = h.notify.destinations.createChannel('u_a', { type: 'webhook', name: 'Ops', url: `http://hooks.example.test:${svc.port}/in` });
    const emit = (run: string) => h.bus.emit({ kind: 'ci_failed', subject: { type: 'ci_run', id: run, workspaceId: 'docker/api' }, facts: { repo: 'api', number: 1, pipeline: 'test' }, audience: ['u_a'] });
    emit('run_a');
    emit('run_a'); // same tag within the minute
    for (let i = 0; i < 11; i++) emit(`run_${i}`);
    await until(() => logs(h).length === 13);
    const l = logs(h);
    assert.equal(l.filter((x) => x.status === 'sent').length, 10);
    assert.equal(l.filter((x) => x.code === 'collapsed').length, 1);
    assert.equal(l.filter((x) => x.code === 'throttled').length, 2);
    c.advance(10 * 60_000);
    await h.notify.pipeline.tick();
    await until(() => svc.got.length === 11);
    const last = JSON.parse(svc.got[10]!.body.toString()) as { title: string; body: string };
    assert.deepEqual([last.title, last.body], ['More waiting', '2 more items need you']);
    assert.equal(destination.type, 'webhook');
  } finally {
    h.notify.stop();
    await svc.close();
  }
});

test('retries: now, 30 s, 5 min on a 5xx; Retry-After honoured; never on another 4xx; the breaker: 3 failing, 20 disabled', async () => {
  const answers = [503, 503, 200, 429, 200, 400];
  const svc = await standIn((_r, n) => (answers[n - 1] === 429 ? { status: 429, headers: { 'Retry-After': '7' } } : { status: answers[n - 1] ?? 500 }));
  const c = clock();
  const sleeps: number[] = [];
  const h = await harness({ now: c.now, schedule: c.schedule, sleep: async (ms) => void sleeps.push(ms) });
  try {
    h.notify.start();
    const { destination: d } = h.notify.destinations.createChannel('u_a', { type: 'webhook', name: 'Ops', url: `http://hooks.example.test:${svc.port}/in` });
    const emit = (run: string) => h.bus.emit({ kind: 'ci_failed', subject: { type: 'ci_run', id: run }, facts: {}, audience: ['u_a'] });
    emit('r1');
    await until(() => logs(h).length === 1);
    const waits = () => sleeps.filter((ms) => ms >= 5_000); // shorter waits are the channel's own pace (one message a second, on a clock that stands still here)
    assert.deepEqual(waits(), [30_000, 300_000]);
    assert.equal(logs(h)[0]!.attempts, 3);
    assert.equal(logs(h)[0]!.status, 'sent');
    emit('r2');
    await until(() => logs(h).length === 2);
    assert.deepEqual(waits().slice(2), [7_000]);
    emit('r3');
    await until(() => logs(h).length === 3);
    assert.equal(logs(h)[2]!.code, 'http_4xx');
    assert.equal(logs(h)[2]!.attempts, 1, 'a 400 is not retried');
    // three failures in a row: failing; the next event within the hour is not tried
    answers.length = 0;
    emit('r4');
    emit('r5');
    await until(() => logs(h).length === 5);
    assert.equal(h.notify.destinations.find(d.id)!.state, 'failing');
    emit('r6');
    await until(() => logs(h).length === 6);
    assert.equal(logs(h)[5]!.code, 'disabled');
    // after an hour one try; at 20 failures in a row it is disabled until a person turns it on
    h.store.db!.prepare('UPDATE notify_destinations SET failures = 19 WHERE id = ?').run(d.id);
    c.advance(3_600_001);
    emit('r7');
    await until(() => logs(h).length === 7);
    assert.equal(h.notify.destinations.find(d.id)!.state, 'disabled');
    const on = h.notify.destinations.update(d.id, 'u_a', { enabled: true });
    assert.equal(on.state, 'ok');
    assert.equal(on.failures, 0);
  } finally {
    h.notify.stop();
    await svc.close();
  }
});

test('a push service 404 or 410 ends the subscription and its pending tokens', async () => {
  for (const status of [404, 410]) {
    const svc = await standIn(() => ({ status }));
    const c = clock();
    const h = await harness({ owners: { 'session:s1': 'u_a' }, now: c.now, schedule: c.schedule });
    try {
      h.notify.start();
      const b = fakeBrowser(`http://push.example.test:${svc.port}/send/x`);
      const d = h.notify.destinations.registerPush('u_a', { subscription: b.subscription, tz: 'UTC' }).destination;
      h.notify.actions.issue({ ownerId: 'u_a', destinationId: d.id, eventId: 'evt_1', sessionId: 's1', requestId: 'r0', decisions: ['deny'], toolClass: 'command', request: { toolName: 'Bash', full: 'ls' } });
      h.bus.emit({ kind: 'session_failed', subject: { type: 'session', id: 's1' }, facts: { workspace: 'docker/a', reason: 'error' } });
      await until(() => logs(h).length === 1);
      const after = h.notify.destinations.find(d.id)!;
      assert.equal(after.state, 'disabled');
      assert.equal(after.lastError, 'gone');
      assert.equal(h.notify.actions.pending(), 0);
    } finally {
      h.notify.stop();
      await svc.close();
    }
  }
});

test('presence: the device in use gets a toast instead; others get nothing but cost_spike at once and an approval after 60 s', async () => {
  const svc = await standIn();
  const c = clock();
  const h = await harness({ owners: { 'session:s1': 'u_a', 'claude:c1': 'u_a' }, now: c.now, schedule: c.schedule });
  try {
    h.notify.start();
    const phone = fakeBrowser(`http://push.example.test:${svc.port}/send/phone`);
    const laptop = fakeBrowser(`http://push.example.test:${svc.port}/send/laptop`);
    const dPhone = h.notify.destinations.registerPush('u_a', { subscription: phone.subscription, tz: 'UTC' }).destination;
    const dLaptop = h.notify.destinations.registerPush('u_a', { subscription: laptop.subscription, tz: 'UTC' }).destination;
    h.notify.pipeline.setPresence({}, { userId: 'u_a', device: dLaptop.id, visible: true, active: true, session: null });
    h.bus.emit({ kind: 'ci_failed', subject: { type: 'ci_run', id: 'r1' }, facts: {}, audience: ['u_a'] });
    h.bus.emit({ kind: 'cost_spike', subject: { type: 'claude', id: 'c1' }, facts: { what: 'spike', spikeKind: 'rate' } });
    await until(() => logs(h).length === 4);
    const byDest = (id: string) => logs(h).filter((l) => l.destinationId === id);
    assert.deepEqual(byDest(dLaptop.id).map((l) => l.code), ['active_device', 'active_device']);
    assert.deepEqual(byDest(dPhone.id).map((l) => [l.kind, l.status, l.code]), [['ci_failed', 'suppressed', 'active_device'], ['cost_spike', 'sent', null]]);
    // an approval reaches the other device only if still open after 60 s
    h.chat.ask(session('s1'), request('r1', 'Bash', 'ls'));
    c.advance(59_999);
    assert.equal(svc.got.length, 1);
    c.advance(1);
    await until(() => svc.got.length === 2);
    assert.equal((phone.open(svc.got[1]!.body) as PushPayload).notification.title, 'Approval needed');
  } finally {
    h.notify.stop();
    await svc.close();
  }
});

test('quiet hours: held, then ONE summary at the end without what was dealt with; a break-through kind goes at once', async () => {
  const svc = await standIn(() => ({ status: 200 }));
  const c = clock('2026-10-12T16:30:00.000Z'); // 23:30 in Jakarta
  const h = await harness({ owners: { 'session:s1': 'u_a', 'claude:c1': 'u_a' }, now: c.now, schedule: c.schedule });
  try {
    h.notify.start();
    const { destination: d } = h.notify.destinations.createChannel('u_a', { type: 'slack', name: 'Ops', url: 'https://hooks.slack.com/services' + '/T0000000/B0000000/XXXXXXXXXXXXXXXXXXXXXXXX' });
    h.notify.destinations.update(d.id, 'u_a', { quiet: { enabled: true, start: '22:00', end: '07:00', tz: 'Asia/Jakarta', breakthrough: ['cost_spike'] } });
    // the slack URL is https: point this test's egress at the stand-in by name is not possible, so watch the log instead of the receiver
    h.bus.emit({ kind: 'ci_failed', subject: { type: 'ci_run', id: 'r1' }, facts: {}, audience: ['u_a'] });
    h.bus.emit({ kind: 'ci_failed', subject: { type: 'ci_run', id: 'r2' }, facts: {}, audience: ['u_a'] });
    h.bus.emit({ kind: 'human_request', subject: { type: 'ticket', id: 'T-3' }, facts: { ticket: 'T-3' }, audience: ['u_a'] });
    h.bus.emit({ kind: 'cost_spike', subject: { type: 'claude', id: 'c1' }, facts: { what: 'spike' } });
    await until(() => logs(h).length === 4);
    assert.deepEqual(logs(h).map((l) => l.status), ['held', 'held', 'held', 'failed']); // the break-through one was tried (and failed: no TLS stand-in)
    h.notify.pipeline.resolveTag('ticket:T-3', 'closed'); // dealt with meanwhile
    await h.notify.pipeline.tick(); // still quiet: nothing
    assert.equal(logs(h).length, 4);
    c.set('2026-10-13T00:00:00.000Z'); // 07:00 in Jakarta
    await h.notify.pipeline.tick();
    await until(() => logs(h).length === 5);
    assert.equal(h.store.db!.prepare('SELECT COUNT(*) AS n FROM notify_held').get()!.n, 0);
    await h.notify.pipeline.tick();
    assert.equal(logs(h).length, 5, 'one summary, once');
  } finally {
    h.notify.stop();
    await svc.close();
  }
});

test('the summary text: "2 items waited" (and only the two that were not dealt with)', async () => {
  const svc = await standIn(() => ({ status: 200 }));
  const c = clock('2026-10-12T16:30:00.000Z');
  const h = await harness({ now: c.now, schedule: c.schedule });
  try {
    h.notify.start();
    const { destination: d } = h.notify.destinations.createChannel('u_a', { type: 'webhook', name: 'Ops', url: `http://hooks.example.test:${svc.port}/in` });
    h.notify.destinations.update(d.id, 'u_a', { quiet: { enabled: true, start: '22:00', end: '07:00', tz: 'Asia/Jakarta', breakthrough: [] } });
    for (const id of ['r1', 'r2']) h.bus.emit({ kind: 'ci_failed', subject: { type: 'ci_run', id }, facts: {}, audience: ['u_a'] });
    h.bus.emit({ kind: 'human_request', subject: { type: 'ticket', id: 'T-3' }, facts: {}, audience: ['u_a'] });
    await until(() => logs(h).length === 3);
    h.notify.pipeline.resolveTag('ticket:T-3', 'closed');
    c.set('2026-10-13T00:00:00.000Z');
    await h.notify.pipeline.tick();
    await until(() => svc.got.length === 1);
    const b = JSON.parse(svc.got[0]!.body.toString()) as { title: string; body: string };
    assert.deepEqual([b.title, b.body], ['While quiet', '2 items waited']);
  } finally {
    h.notify.stop();
    await svc.close();
  }
});

test('Locked: nothing is sent and the log says locked; the Inbox is still written', async () => {
  const svc = await standIn();
  const h = await harness({ owners: { 'ci_run:r1': 'u_a' } });
  try {
    h.notify.start();
    h.notify.destinations.createChannel('u_a', { type: 'webhook', name: 'Ops', url: `http://hooks.example.test:${svc.port}/in` });
    // the key goes away: what the portal is after a restart without it
    (h.store as unknown as { lock?: () => void }).lock?.();
    Object.defineProperty(h.store, 'secrets', { get: () => null });
    assert.equal(h.notify.pipeline.state(), 'locked');
    h.bus.emit({ kind: 'ci_failed', subject: { type: 'ci_run', id: 'r1' }, facts: {} });
    await until(() => logs(h).length === 1);
    assert.deepEqual([logs(h)[0]!.status, logs(h)[0]!.code], ['failed', 'locked']);
    assert.equal(svc.got.length, 0);
    assert.equal(h.notify.history.page('u_a').items.length, 1);
  } finally {
    h.notify.stop();
    await svc.close();
  }
});

test('routing: an event about A reaches only A; B hears of it only when shared AND opted in; a disabled user hears nothing; near is history only', async () => {
  const svc = await standIn();
  const h = await harness({ owners: { 'session:s1': 'u_a', 'claude:c1': 'u_a' }, ownerOpts: { shares: { 'session:s1': ['u_b'] } } });
  try {
    h.notify.start();
    const url = `http://hooks.example.test:${svc.port}/in`;
    const a = h.notify.destinations.createChannel('u_a', { type: 'webhook', name: 'A', url: `${url}?a` }).destination;
    const b = h.notify.destinations.createChannel('u_b', { type: 'webhook', name: 'B', url: `${url}?b` }).destination;
    h.bus.emit({ kind: 'session_failed', subject: { type: 'session', id: 's1' }, facts: { workspace: 'docker/a', reason: 'error' } });
    await until(() => svc.got.length === 1);
    assert.equal(svc.got[0]!.path, '/in?a');
    assert.equal(h.notify.history.page('u_b').items.length, 0);
    h.notify.destinations.update(b.id, 'u_b', { includeShared: true });
    h.bus.emit({ kind: 'session_failed', subject: { type: 'session', id: 's1' }, facts: { workspace: 'docker/a', reason: 'crash' } });
    await until(() => svc.got.length === 2);
    assert.equal(svc.got[1]!.path, '/in?b'); // A's second one within the minute collapses into the first (one per tag a minute)
    // a quota at 80 % (near) is an Inbox row only
    h.bus.emit({ kind: 'quota_low', subject: { type: 'claude', id: 'c1' }, facts: { level: 'near', claude: 'Work', window: 'Session', leftPct: 20 } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(svc.got.length, 2);
    assert.equal(h.notify.history.page('u_a').items[0]!.kind, 'quota_low');
    assert.equal(a.type, 'webhook');
  } finally {
    h.notify.stop();
    await svc.close();
  }
  const h2 = await harness({ owners: { 'session:s1': 'u_a' }, ownerOpts: { disabled: ['u_a'] } });
  h2.notify.start();
  h2.bus.emit({ kind: 'session_failed', subject: { type: 'session', id: 's1' }, facts: {} });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h2.notify.history.page('u_a').items.length, 0);
  h2.notify.stop();
});

test('session_done: "Notify when done" sends when the session goes idle and stays so; otherwise only a 5-minute stretch where the kind is on', async () => {
  const svc = await standIn();
  let clock = Date.parse('2026-10-13T08:00:00.000Z');
  const h = await harness({ owners: { 'session:s1': 'u_a', 'session:s2': 'u_a' }, doneDebounceMs: 20, now: () => new Date(clock) });
  try {
    h.notify.start();
    h.notify.destinations.createChannel('u_a', { type: 'webhook', name: 'A', url: `http://hooks.example.test:${svc.port}/in` });
    h.notify.destinations.setSessionDone('s1', 'u_a', true);
    const state = (id: string, s: 'working' | 'idle', over: Record<string, unknown> = {}) => {
      const it = session(id, { state: s, ...over });
      h.chat.sessions.set(id, it);
      h.chat.dispatch(id, { type: 'session', session: it });
    };
    const result = (id: string, durationMs: number) => h.chat.dispatch(id, { type: 'events', session: id, items: [{ seq: 1, at: '', kind: 'result', durationMs }] });
    for (const id of ['s1', 's2']) state(id, 'idle');
    for (const id of ['s1', 's2']) state(id, 'working');
    result('s1', 60_000); // a result alone is not done: s1 still works through its sub-agents
    state('s1', 'working', { tasksOnly: true, agentsRunning: 1 });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(svc.got.length, 0, 'nothing while its tasks run');
    clock += 60_000;
    state('s1', 'idle');
    await until(() => svc.got.length === 1);
    clock += 9 * 60_000;
    state('s2', 'idle'); // a 10-minute stretch, but session_done is off by default: Inbox only... and not sent
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(svc.got.length, 1);
    assert.equal(JSON.parse(svc.got[0]!.body.toString()).body, 'api-dev · 1 min');
  } finally {
    h.notify.stop();
    await svc.close();
  }
});

test('btw (side questions) produce no notification: btw, btw_delta, side usage and the pinned card are not turns or failures', async () => {
  const svc = await standIn();
  const h = await harness({ owners: { 'session:s1': 'u_a' } });
  try {
    h.notify.start();
    h.notify.destinations.createChannel('u_a', { type: 'webhook', name: 'A', url: `http://hooks.example.test:${svc.port}/in`, kinds: ['session_done', 'session_failed', 'approval'] });
    h.chat.sessions.set('s1', session('s1', { state: 'idle' }));
    h.notify.destinations.setSessionDone('s1', 'u_a', true);
    h.chat.dispatch('s1', { type: 'btw', session: 's1', id: 'b1', text: 'what does this do?' } as never);
    h.chat.dispatch('s1', { type: 'btw_delta', session: 's1', id: 'b1', text: 'It reads' } as never);
    h.chat.dispatch('s1', { type: 'btw', session: 's1', id: 'b1', error: 'rate limit' } as never);
    h.chat.dispatch('s1', { type: 'events', session: 's1', items: [{ seq: 5, at: '', kind: 'system', text: 'side question', btw: { id: 'b1' } } as never] });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(svc.got.length, 0);
    assert.equal(h.notify.history.page('u_a').items.length, 0);
  } finally {
    h.notify.stop();
    await svc.close();
  }
});
