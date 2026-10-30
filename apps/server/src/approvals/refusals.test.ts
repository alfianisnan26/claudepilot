// T-3114 (PILOT-1091): refused calls stopped flooding Needs you. A guard.refusal card lives 30 minutes, a repeat of the same call in the
// same workspace is folded into the waiting card with a count, its session ending expires it, and Needs you puts it after the real asks in
// a group of its own. T-2889's one-time pass still works on a folded card.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { APPROVAL_TTL_DEFAULT_MIN, APPROVAL_TTL_REFUSAL_MIN, type AttentionItem, type ChatServerMessage } from '@portal/contracts';
import { ownerActor } from '../authz/seam.js';
import { attentionOrder } from '../attention/registry.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { approvalAttentionSource } from './attention.js';
import type { ApprovalChat } from './kinds.js';
import { expireRefusalsOnEnd, fileRefusalRequests, OUTBOX_PENDING_MAX } from './outbox.js';
import { passOf } from './pass.js';
import { Approvals } from './service.js';

const WS = 'docker/ws1';
const person = ownerActor();
const newId = () => `apr-${randomBytes(9).toString('hex')}`;
const MIN = 60_000;

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function harness() {
  const dir = tempDirectory('cp-apr-refusals-');
  dirs.push(dir);
  const store = await Store.open({ dataDir: dir, secretKey: null });
  after(() => store.close());
  const clock = { now: Date.parse('2026-10-30T08:00:00.000Z') };
  const sent: { sessionId: string; text: string }[] = [];
  const sessions: Record<string, string> = { 'chat-a': WS, 'chat-b': WS, 'chat-c': WS, 'chat-other': 'docker/ws2' };
  const chat: ApprovalChat = {
    enterBypass: () => Promise.reject(new Error('not in this test')),
    get: (id) => (sessions[id] ? { id, title: `Agent ${id}`, workspaceId: sessions[id]!, bypassCapable: false, mode: 'default', state: 'idle' } : null),
    send: async (sessionId, _uuid, text) => void sent.push({ sessionId, text }),
  };
  const delivered: string[] = [];
  let changes = 0;
  const approvals = new Approvals({ db: () => store.db, chat, delivery: { passesChanged: (ws) => void delivered.push(ws) }, now: () => clock.now, changed: () => void changes++ });
  return { store, approvals, clock, sent, delivered, changes: () => changes };
}

const call = (command: string) => ({ tool: 'Bash', input: { command, description: 'x' }, cwd: '/w/repo', form: 'settings' });
const ask = (session: string, ws = WS) => ({ sessionId: session, workspaceId: ws });
const refuse = (a: Approvals, session: string, payload: Record<string, unknown>, opts: { id?: string; ttlMinutes?: number; ws?: string } = {}) =>
  a.create({ kind: 'guard.refusal', payload, reason: 'the rule guard refused this call', ...(opts.ttlMinutes ? { ttlMinutes: opts.ttlMinutes } : {}) }, ask(session, opts.ws), opts.id ? { id: opts.id } : {});

test('migration 884: the repeats table and its indexes exist', async () => {
  const { store } = await harness();
  const cols = (store.db!.prepare(`SELECT name FROM pragma_table_info('approval_repeats')`).all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols, ['id', 'approval_id', 'requester_session', 'created_at']);
  const idx = (store.db!.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approval_repeats' AND name LIKE 'approval_repeats_%' ORDER BY name`).all() as { name: string }[]).map(
    (i) => i.name,
  );
  assert.deepEqual(idx, ['approval_repeats_approval', 'approval_repeats_session']);
});

test('a refused call waits 30 minutes by default and never longer; other kinds keep their day', async () => {
  const h = await harness();
  assert.equal(APPROVAL_TTL_REFUSAL_MIN, 30);
  const a = refuse(h.approvals, 'chat-a', call('echo 1 > .claude/settings.json'));
  assert.equal(Date.parse(a.expiresAt) - h.clock.now, 30 * MIN, 'the default is 30 minutes');
  const asked = refuse(h.approvals, 'chat-a', call('echo 2 > .claude/settings.json'), { ttlMinutes: 600 });
  assert.equal(Date.parse(asked.expiresAt) - h.clock.now, 30 * MIN, 'an asker cannot stretch it');
  const short = refuse(h.approvals, 'chat-a', call('echo 3 > .claude/settings.json'), { ttlMinutes: 5 });
  assert.equal(Date.parse(short.expiresAt) - h.clock.now, 5 * MIN, 'shorter is allowed');
  const echo = h.approvals.create({ kind: 'test.echo', payload: { text: 'x' } }, ask('chat-a'));
  assert.equal(Date.parse(echo.expiresAt) - h.clock.now, APPROVAL_TTL_DEFAULT_MIN * MIN, 'other kinds keep the default');
  // Past its 30 minutes: out of the queue and of Needs you, and it can not be allowed.
  h.clock.now += 30 * MIN;
  assert.deepEqual(h.approvals.pending(person).map((p) => p.kind), ['test.echo']);
  await assert.rejects(h.approvals.allow(person, a.id), /expired/);
});

test('the same refused call in the same workspace is one card with a count; each filed id still answers its own session', async () => {
  const h = await harness();
  const p = call('echo x > .claude/settings.json');
  const first = refuse(h.approvals, 'chat-a', p, { id: newId() });
  assert.equal(first.count, 1);
  // Again, ten minutes later, from the same session and from another session of the same workspace; key order does not matter.
  h.clock.now += 10 * MIN;
  const againId = newId();
  const again = refuse(h.approvals, 'chat-a', { form: p.form, cwd: p.cwd, input: { description: 'x', command: p.input.command }, tool: 'Bash' }, { id: againId });
  assert.equal(again.id, first.id, 'folded into the waiting card');
  const otherId = newId();
  const other = refuse(h.approvals, 'chat-b', p, { id: otherId });
  assert.equal(other.id, first.id);
  assert.equal(other.count, 3);
  assert.equal(Date.parse(other.expiresAt), h.clock.now + 30 * MIN, 'a repeat keeps the card alive another 30 minutes');
  assert.equal(h.approvals.pending(person).length, 1, 'one card in the queue');
  // The id the guard printed for a repeat answers its own session (approval_get), with the card; never another session.
  assert.equal(h.approvals.ownOne('chat-b', otherId).id, first.id);
  assert.equal(h.approvals.ownOne('chat-a', againId).id, first.id);
  assert.throws(() => h.approvals.ownOne('chat-c', otherId), /not found|No such/i);
  assert.throws(() => h.approvals.ownOne('chat-b', againId), /not found|No such/i);
  assert.deepEqual(h.approvals.listOwn('chat-b').map((x) => x.id), [first.id]);
  // A repeat id pulled again (a restart re-reading the file) is in use: nothing more is counted.
  assert.throws(() => refuse(h.approvals, 'chat-b', p, { id: otherId }), /in use/);
  assert.equal(h.approvals.getFor(person, first.id).count, 3);
  // Another call, or the same call in another workspace: their own cards.
  assert.notEqual(refuse(h.approvals, 'chat-a', call('echo y > .claude/settings.json')).id, first.id);
  assert.notEqual(refuse(h.approvals, 'chat-other', p, { ws: 'docker/ws2' }).id, first.id);
  // A decided card folds nothing: the same call after a Deny is a new card.
  await h.approvals.deny(person, first.id, 'no');
  const fresh = refuse(h.approvals, 'chat-a', p);
  assert.notEqual(fresh.id, first.id);
  assert.equal(fresh.count, 1);
});

test('the outbox: repeats of one call fold into one card and never hit the five-per-session cap', async () => {
  const h = await harness();
  const line = (command: string) => ({ id: newId(), type: 'request' as const, kind: 'guard.refusal', session: 'chat-a', payload: call(command) });
  // Twelve refusals of one call: one card counted 12, and the session can still file other calls.
  const same = Array.from({ length: 12 }, () => line('echo x > .claude/settings.json'));
  const ids = fileRefusalRequests(h.approvals, h.store, WS, same);
  assert.equal(new Set(ids).size, 1);
  assert.equal(h.approvals.getFor(person, ids[0]!).count, 12);
  const others = Array.from({ length: OUTBOX_PENDING_MAX }, (_, n) => line(`echo ${n} > .claude/x.json`));
  const logged: string[] = [];
  const made = fileRefusalRequests(h.approvals, h.store, WS, others, (what) => logged.push(what));
  assert.equal(made.length, OUTBOX_PENDING_MAX - 1, 'the cap still holds for distinct calls (the folded card is one of the five)');
  assert.deepEqual(logged, [], 'a capped line is dropped quietly');
  assert.equal(h.approvals.pendingRows(h.clock.now).length, OUTBOX_PENDING_MAX);
});

test('a session that ends, is archived or deleted expires the refused calls it filed, and only those', async () => {
  const h = await harness();
  const a = refuse(h.approvals, 'chat-a', call('echo a > .claude/settings.json'));
  const b = refuse(h.approvals, 'chat-b', call('echo b > .claude/settings.json'));
  const c = refuse(h.approvals, 'chat-c', call('echo c > .claude/settings.json'));
  const echo = h.approvals.create({ kind: 'test.echo', payload: { text: 'x' } }, ask('chat-a'));
  const session = (over: Record<string, unknown>) => ({ type: 'session', session: { id: 'x', state: 'idle', archivedAt: null, ...over } }) as unknown as ChatServerMessage;
  // Not an end: nothing.
  assert.equal(expireRefusalsOnEnd(h.approvals, 'chat-a', session({ state: 'working' })), 0);
  assert.equal(expireRefusalsOnEnd(h.approvals, 'chat-a', session({ state: 'idle' })), 0);
  assert.equal(h.approvals.pending(person).length, 4);
  const before = h.changes();
  assert.equal(expireRefusalsOnEnd(h.approvals, 'chat-a', session({ state: 'ended' })), 1);
  assert.ok(h.changes() > before, 'Needs you is told');
  const gone = h.approvals.getFor(person, a.id);
  assert.equal(gone.status, 'expired');
  assert.deepEqual(gone.result, { ok: false, message: 'The asking session ended.' });
  assert.equal(h.approvals.getFor(person, echo.id).status, 'pending', 'a real ask of that session stays');
  assert.equal(expireRefusalsOnEnd(h.approvals, 'chat-b', session({ state: 'idle', archivedAt: new Date(h.clock.now).toISOString() })), 1);
  assert.equal(h.approvals.getFor(person, b.id).status, 'expired');
  assert.equal(expireRefusalsOnEnd(h.approvals, 'chat-c', { type: 'removed', session: 'chat-c' } as ChatServerMessage), 1);
  assert.equal(h.approvals.getFor(person, c.id).status, 'expired');
  assert.deepEqual(h.approvals.pending(person).map((p) => p.id), [echo.id]);
  await assert.rejects(h.approvals.allow(person, a.id), /already expired/);
  // Again: nothing more to expire.
  assert.equal(expireRefusalsOnEnd(h.approvals, 'chat-a', session({ state: 'ended' })), 0);
  // A failing service is logged, never thrown into the chat's event loop.
  const logged: string[] = [];
  const broken = {
    expireForSession: (): number => {
      throw new Error('db gone');
    },
  };
  assert.equal(expireRefusalsOnEnd(broken, 'chat-a', session({ state: 'ended' }), (what) => logged.push(what)), 0);
  assert.equal(logged.length, 1);
});

test('T-2889 still: Allow on a folded card records its one-time pass, and every session that filed it is told', async () => {
  const h = await harness();
  const p = call('echo x > .claude/settings.json');
  const first = refuse(h.approvals, 'chat-a', p);
  const repeatId = newId();
  refuse(h.approvals, 'chat-b', p, { id: repeatId });
  refuse(h.approvals, 'chat-a', p);
  const allowed = await h.approvals.allow(person, first.id);
  assert.equal(allowed.result?.ok, true, allowed.result?.message);
  const pass = passOf('guard.refusal', p)!;
  assert.equal((allowed.result?.output as { pass: string }).pass, pass);
  assert.deepEqual(h.approvals.livePasses(WS).map((x) => x.pass), [pass]);
  assert.deepEqual(h.delivered, [WS]);
  // Each session once, under the id it was given.
  assert.deepEqual(h.sent.map((s) => s.sessionId).sort(), ['chat-a', 'chat-b']);
  assert.ok(h.sent.find((s) => s.sessionId === 'chat-a')!.text.includes(first.id));
  assert.ok(h.sent.find((s) => s.sessionId === 'chat-b')!.text.includes(repeatId));
  // The session's end after Allow touches nothing decided: the pass stays live.
  assert.equal(h.approvals.expireForSession('chat-a'), 0);
  assert.deepEqual(h.approvals.livePasses(WS).map((x) => x.pass), [pass]);
});

test('Needs you: a refused call is in the refusal group with its count, and sorts after every real ask', async () => {
  const h = await harness();
  const p = call('echo x > .claude/settings.json');
  const r = refuse(h.approvals, 'chat-a', p);
  h.clock.now += MIN;
  refuse(h.approvals, 'chat-a', p);
  refuse(h.approvals, 'chat-a', p);
  h.clock.now += MIN;
  const echo = h.approvals.create({ kind: 'test.echo', payload: { text: 'x' } }, ask('chat-b'));
  const items = approvalAttentionSource(h.approvals).list(person, h.clock.now, 'decide') as AttentionItem[];
  const refusal = items.find((i) => i.id === r.id)!;
  assert.equal(refusal.group, 'refusal');
  assert.equal(refusal.count, 3);
  assert.match(refusal.risk, /refused 3 times/);
  const real = items.find((i) => i.id === echo.id)!;
  assert.equal(real.group, undefined);
  assert.equal(real.count, undefined);
  // The refusal is older and its why ranks first, yet it sorts after the real ask.
  const bypassLike: AttentionItem = { ...real, why: 'question', since: new Date(h.clock.now).toISOString() };
  assert.deepEqual([refusal, bypassLike].sort(attentionOrder).map((i) => i.id), [echo.id, r.id]);
});
