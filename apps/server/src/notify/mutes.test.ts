// Mute rules, "Mute similar" (T-25): what a rule matches (kind, scope narrowest first, per destination), expiry, the never-mute guard
// (approvals and deploy waits only by a confirmed Settings rule), the history marking (stored, marked, filtered, never unread, logged
// `muted`), the push's Mute action, and the routes for two users with an audit row on create and delete.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NotifyEvent } from '@portal/contracts';
import { muteScopesOf } from './mutes.js';
import { pushPayload } from './push.js';
import { harness, standIn, until } from './testkit.js';

function clock(start = '2026-10-12T03:00:00.000Z') {
  let now = Date.parse(start);
  return { now: () => new Date(now), advance: (ms: number) => void (now += ms) };
}

const ciFailed = (run: string, facts: Record<string, string> = {}): Omit<NotifyEvent, 'id' | 'at'> => ({
  kind: 'ci_failed',
  subject: { type: 'ci_run', id: run, workspaceId: 'docker/api' },
  facts: { workspace: 'docker/api', repo: 'api', number: 1, pipeline: 'test', ...facts },
  audience: ['u_a'],
});

test('scopes of an event, narrowest first: CI names from the facts, the subject, then the workspace', () => {
  const ci = muteScopesOf({ subject: { type: 'ci_run', id: 'run_1', workspaceId: 'docker/api' }, facts: { repo: 'api', pipeline: 'deploy', environment: 'prod' } });
  assert.deepEqual(
    ci.map((s) => `${s.type}:${s.id}`),
    ['environment:api/prod', 'pipeline:api/deploy', 'repo:api', 'workspace:docker/api'],
  );
  assert.equal(ci[1]!.label, 'api · deploy');
  const s = muteScopesOf({ subject: { type: 'session', id: 's_41', workspaceId: 'docker/api' }, facts: {} });
  assert.deepEqual(s.map((x) => x.type), ['session', 'workspace']);
  assert.deepEqual(muteScopesOf({ subject: { type: 'ticket', id: 'T-9' }, facts: {} }).map((x) => x.id), ['T-9']);
  assert.deepEqual(muteScopesOf({ subject: { type: 'portal', id: 'summary' }, facts: {} }), []);
  // free text never becomes a scope: a fact that is not a short string is ignored
  assert.deepEqual(muteScopesOf({ subject: { type: 'ci_run', id: 'r' }, facts: { repo: 'x'.repeat(500) } }).map((x) => x.type), ['ci_run']);
});

test('matching and the history mark: a muted event is stored and marked, left out of the list and the count, and sent nowhere', async () => {
  const svc = await standIn();
  const c = clock();
  const h = await harness({ now: c.now });
  try {
    const { destination: d } = h.notify.destinations.createChannel('u_a', { type: 'webhook', name: 'Ops', url: `http://hooks.example.test:${svc.port}/in` });
    const offerRef = async (run: string, facts?: Record<string, string>) => {
      const e = h.bus.emit(ciFailed(run, facts))!;
      await h.notify.pipeline.handle(e);
      return e;
    };
    // a first one is delivered; "Mute similar" on it makes a rule for its pipeline
    const first = await offerRef('run_1');
    await until(() => svc.got.length === 1);
    const offer = h.notify.mutes.offer('u_a', first.id);
    assert.deepEqual(offer.scope, { type: 'pipeline', id: 'api/test', label: 'api · test' });
    assert.equal(offer.guarded, false);
    const rule = h.notify.mutes.create('u_a', { from: first.id, duration: '1h' });
    assert.equal(rule.kind, 'ci_failed');
    assert.equal(rule.expiresAt, '2026-10-12T04:00:00.000Z');

    // the same pipeline again: kept, marked, not delivered, logged as muted, counted on the rule
    const second = await offerRef('run_2');
    // another pipeline of the same repository: not matched
    await offerRef('run_3', { pipeline: 'lint' });
    await until(() => svc.got.length === 2);
    const page = h.notify.history.page('u_a');
    assert.deepEqual(page.items.map((i) => i.muted), [false, false], 'muted rows are filtered by default');
    assert.equal(page.unread, 2, 'and are not unread');
    const all = h.notify.history.page('u_a', { muted: true });
    assert.equal(all.items.length, 3);
    assert.equal(all.items.find((i) => i.muted)!.title, page.items[1]!.title);
    const log = h.notify.history.deliveries('u_a').find((l) => l.eventId === second.id)!;
    assert.deepEqual([log.status, log.code, log.destinationId], ['suppressed', 'muted', d.id]);
    assert.equal(h.notify.mutes.list('u_a')[0]!.hushed, 1);

    // expiry: after the hour the rule is gone from the list and matches nothing; the sweep removes the row
    c.advance(3600_000);
    assert.deepEqual(h.notify.mutes.list('u_a'), []);
    await offerRef('run_4');
    await until(() => svc.got.length === 3);
    h.notify.mutes.sweep();
    assert.equal((h.store.db!.prepare('SELECT COUNT(*) AS n FROM notify_mutes').get() as { n: number }).n, 0);

    // "all of this kind" matches every pipeline; a rule for one destination hushes only that one and leaves the Inbox row unmarked
    const wide = h.notify.mutes.create('u_a', { from: first.id, wide: true, duration: 'forever' });
    assert.equal(wide.scope, null);
    assert.equal(wide.expiresAt, null);
    await offerRef('run_5', { pipeline: 'other' });
    h.notify.mutes.remove('u_a', wide.id);
    h.notify.mutes.create('u_a', { kind: 'ci_failed', destinationId: d.id, duration: '1d' });
    await offerRef('run_6');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(svc.got.length, 3, 'neither reached the channel');
    const rows = h.notify.history.page('u_a', { muted: true }).items;
    assert.equal(rows[0]!.muted, false, 'per-destination: the Inbox row is not marked');
    assert.equal(rows[1]!.muted, true);
  } finally {
    await svc.close();
  }
});

test('the never-mute guard: approvals and deploy waits are not muted from a notification, only by a confirmed Settings rule', async () => {
  const svc = await standIn();
  const h = await harness();
  try {
    h.notify.destinations.createChannel('u_a', { type: 'webhook', name: 'Ops', url: `http://hooks.example.test:${svc.port}/in` });
    const waits = (run: string) => h.bus.emit({ ...ciFailed(run, { job: 'release', environment: 'prod' }), kind: 'ci_waiting' })!;
    const e = waits('run_1');
    await h.notify.pipeline.handle(e);
    assert.equal(h.notify.mutes.offer('u_a', e.id).guarded, true);
    assert.throws(() => h.notify.mutes.create('u_a', { from: e.id, duration: '1d' }), /muted only in Settings/);
    assert.throws(() => h.notify.mutes.create('u_a', { from: e.id, wide: true, duration: '1d' }), /muted only in Settings/);
    assert.throws(() => h.notify.mutes.create('u_a', { kind: 'approval', duration: '1d' }), (err: { code?: string }) => err.code === 'CONFIRMATION_REQUIRED');
    // a rule on a guarded kind that did not come through the confirmation (a row put there some other way) hushes nothing
    h.store.db!.prepare("INSERT INTO notify_mutes (id, owner_id, kind, created_at) VALUES ('mut_000000000001', 'u_a', 'ci_waiting', '2026-10-12T00:00:00.000Z')").run();
    await h.notify.pipeline.handle(waits('run_2'));
    await until(() => svc.got.length === 2);
    assert.equal(h.notify.history.page('u_a').items.filter((i) => i.muted).length, 0);
    // picked on purpose, confirmed: then it holds
    const rule = h.notify.mutes.create('u_a', { kind: 'ci_waiting', scope: { type: 'environment', id: 'api/prod' }, duration: '1h', confirm: true });
    assert.equal(rule.scope!.type, 'environment');
    await h.notify.pipeline.handle(waits('run_3'));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(svc.got.length, 2);
    assert.equal(h.notify.history.page('u_a', { muted: true }).items[0]!.muted, true);
  } finally {
    await svc.close();
  }
});

test('rules are the person’s own: another user’s rule, item or destination answers as unknown; bad input is refused', async () => {
  const h = await harness();
  const e = h.bus.emit(ciFailed('run_1'))!;
  await h.notify.pipeline.handle(e);
  const mine = h.notify.mutes.create('u_a', { from: e.id, duration: 'forever' });
  assert.throws(() => h.notify.mutes.offer('u_b', e.id), /No such notification/);
  assert.throws(() => h.notify.mutes.create('u_b', { from: e.id, duration: '1h' }), /No such notification/);
  assert.throws(() => h.notify.mutes.remove('u_b', mine.id), /No such rule/);
  assert.deepEqual(h.notify.mutes.list('u_b'), []);
  const theirs = h.notify.destinations.createChannel('u_b', { type: 'webhook', name: 'B', url: 'http://hooks.example.test/b' }).destination;
  assert.throws(() => h.notify.mutes.create('u_a', { kind: 'ci_failed', destinationId: theirs.id, duration: '1h' }));
  for (const bad of [{ kind: 'nope' }, { kind: 'test' }, { kind: 'ci_failed', duration: '2y' }, { kind: 'ci_failed', scope: { type: 'path', id: 'x' } }, { kind: 'ci_failed', scope: { type: 'repo', id: '' } }])
    assert.throws(() => h.notify.mutes.create('u_a', { duration: '1h', ...bad } as never), JSON.stringify(bad));
  assert.equal(h.notify.mutes.clear('u_a'), 1);
});

test('the push carries a Mute action, never on approvals', () => {
  const base = { eventId: 'evt_0123456789abcdef', title: 'CI failed', body: 'api', path: '/admin/ci/runs/r_1', tag: 'ci:r_1', renotify: false };
  const p = pushPayload({ ...base, kind: 'ci_failed', mute: true }, 'https://pilot.example.test');
  assert.deepEqual(p.notification.actions, [{ action: 'mute', title: 'Mute', navigate: 'https://pilot.example.test/admin/notifications?mute=evt_0123456789abcdef' }]);
  assert.equal(pushPayload({ ...base, kind: 'ci_failed' }, 'https://x.test').notification.actions, undefined);
  assert.deepEqual(pushPayload({ ...base, kind: 'approval', mute: true }, 'https://x.test').notification.actions!.map((a) => a.action), ['review']);
});
