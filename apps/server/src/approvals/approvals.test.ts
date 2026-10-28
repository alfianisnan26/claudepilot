// Approvals (docs/prd/approvals.md, PILOT-1000 / T-2867): an agent asks, a person allows or denies, the portal runs the stored payload
// exactly once and tells the asking session. Deciding is a person's: a token or an agent gets the same NOT_FOUND as a missing request.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { BYPASS_NOT_CAPABLE, FOUNDING_USER_ID, isProtectedPool, type Actor, type ApprovalResult, type SecretEntryView } from '@portal/contracts';
import { ownerActor, systemActor } from '../authz/seam.js';
import { liveSession, ok, sleep, until, type Live } from '../chat/testkit.js';
import { PortalToolError, ToolRegistry } from '../portalmcp/registry.js';
import { registerSessionTools } from '../portalmcp/tools/sessions.js';
import { secretsHarness } from '../secrets/testkit.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { approvalAttentionSource } from './attention.js';
import { APPROVAL_KIND_DEFS, type ApprovalChat } from './kinds.js';
import { registerApprovalTools } from './portalTools.js';
import { Approvals } from './service.js';

const code = (p: Promise<unknown> | (() => unknown)) =>
  (typeof p === 'function' ? Promise.resolve().then(p) : p).then(
    () => 'ok',
    (e: unknown) => (isAppError(e) ? e.code : e instanceof PortalToolError ? e.code : String(e)),
  );

const person: Actor = ownerActor();
const agentOf = (sessionId: string): Actor => ({ kind: 'agent', userId: FOUNDING_USER_ID, tokenId: 'tk-agent', sessionId, workspaceId: 'docker/ws1' });
const tokenActor: Actor = { kind: 'token', userId: FOUNDING_USER_ID, tokenId: 'tk-admin', scope: 'admin' };

/** A chat the test controls: what was sent to which session. */
function fakeChat() {
  const sent: { sessionId: string; text: string; actor: string }[] = [];
  const chat: ApprovalChat = {
    enterBypass: () => Promise.reject(new Error('not in this test')),
    get: (id) => ({ id, title: `Agent ${id}`, workspaceId: 'docker/ws1', bypassCapable: false, mode: 'default', state: 'idle' }),
    send: async (sessionId, _uuid, text, opts) => {
      sent.push({ sessionId, text, actor: opts.actor });
    },
  };
  return { chat, sent };
}

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function harness() {
  const dir = tempDirectory('cp-approvals-');
  dirs.push(dir);
  const store = await Store.open({ dataDir: dir, secretKey: null });
  const clock = { now: Date.parse('2026-10-28T08:00:00.000Z') };
  const { chat, sent } = fakeChat();
  let changed = 0;
  const approvals = new Approvals({ db: () => store.db, chat, now: () => clock.now, changed: () => void changed++ });
  return { store, approvals, clock, sent, changes: () => changed };
}

test('migration 883: the approvals table exists on a fresh database, and an existing database that never ran 883 gets it', async () => {
  const dir = tempDirectory('cp-approvals-mig-');
  dirs.push(dir);
  const fresh = await Store.open({ dataDir: dir, secretKey: null });
  const cols = (fresh.db!.prepare(`SELECT name FROM pragma_table_info('approvals')`).all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols, ['id', 'kind', 'payload', 'requester_session', 'workspace', 'tier', 'reason', 'status', 'created_at', 'expires_at', 'decided_by', 'decided_at', 'result']);
  // As a portal from before this change left it: 883 not applied, no table.
  const db = fresh.db!;
  db.exec('DROP TABLE approvals');
  const applied = JSON.parse((db.prepare(`SELECT value FROM portal_meta WHERE key = 'migrations_applied'`).get() as { value: string }).value) as number[];
  assert.ok(applied.includes(883));
  db.prepare(`UPDATE portal_meta SET value = ? WHERE key = 'migrations_applied'`).run(JSON.stringify(applied.filter((v) => v !== 883)));
  fresh.close();
  const again = await Store.open({ dataDir: dir, secretKey: null });
  const table = again.db!.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'`).get();
  const idx = (again.db!.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approvals' AND name LIKE 'approvals_%' ORDER BY name`).all() as { name: string }[]).map((i) => i.name);
  again.close();
  assert.ok(table, 'an existing database gets the table from 883');
  assert.deepEqual(idx, ['approvals_requester', 'approvals_status_created']);
});

test('create, then allow: the stored payload runs exactly once (a second Allow, or two at once, is a conflict) and the asker is told the result', async () => {
  const h = await harness();
  const def = APPROVAL_KIND_DEFS['test.echo'];
  const original = def.run;
  const runs: Record<string, unknown>[] = [];
  def.run = async (p, ctx) => {
    runs.push(p);
    await sleep(10); // a slow run: the second click lands while the first is running
    return original(p, ctx);
  };
  try {
    const a = h.approvals.create({ kind: 'test.echo', payload: { text: 'hello' }, reason: 'a dry run' }, { sessionId: 's-ask', workspaceId: 'docker/ws1' });
    assert.equal(a.status, 'pending');
    assert.equal(a.tier, 'T2');
    assert.deepEqual([a.requesterSession, a.workspace, a.reason], ['s-ask', 'docker/ws1', 'a dry run']);
    assert.equal(a.expiresAt, '2026-10-29T08:00:00.000Z', 'a day by default');
    assert.ok(h.changes() >= 1, 'Needs you is told');

    const [one, two] = await Promise.allSettled([h.approvals.allow(person, a.id), h.approvals.allow(person, a.id)]);
    assert.equal(one.status, 'fulfilled');
    assert.equal(two.status, 'rejected');
    assert.equal(isAppError((two as PromiseRejectedResult).reason) && (two as PromiseRejectedResult).reason.code, 'CONFLICT');
    assert.equal(await code(h.approvals.allow(person, a.id)), 'CONFLICT', 'and again later');
    assert.deepEqual(runs, [{ text: 'hello' }], 'the executor ran once, on the stored payload');

    const done = h.approvals.getFor(person, a.id);
    assert.equal(done.status, 'allowed');
    assert.equal(done.decidedBy, 'ui');
    assert.deepEqual(done.result, { ok: true, message: 'Echoed.', output: { text: 'hello' } } satisfies ApprovalResult);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.sessionId, 's-ask');
    assert.equal(h.sent[0]!.actor, `portal:approval.${a.id}`);
    assert.match(h.sent[0]!.text, /Allowed: Echoed\./);
    assert.deepEqual(h.approvals.pending(person), [], 'out of the queue');
  } finally {
    def.run = original;
  }
});

test('deny: the reason is stored and the asking session is told; it never runs and can not be allowed after', async () => {
  const h = await harness();
  const def = APPROVAL_KIND_DEFS['test.echo'];
  const original = def.run;
  let runs = 0;
  def.run = async (p, ctx) => {
    runs++;
    return original(p, ctx);
  };
  try {
    const a = h.approvals.create({ kind: 'test.echo', payload: { text: 'x' }, reason: 'why' }, { sessionId: 's-ask', workspaceId: null });
    const denied = await h.approvals.deny(person, a.id, '  not   now  ');
    assert.equal(denied.status, 'denied');
    assert.deepEqual(denied.result, { ok: false, message: 'not now' });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.sessionId, 's-ask');
    assert.match(h.sent[0]!.text, /Denied: not now/);
    assert.equal(await code(h.approvals.allow(person, a.id)), 'CONFLICT');
    assert.equal(runs, 0);
    // The portal's own request (no asking session) is decided the same way and tells no one.
    const own = h.approvals.create({ kind: 'test.echo', payload: { text: 'p' } }, null);
    await h.approvals.deny(person, own.id);
    assert.equal(h.sent.length, 1);
    assert.equal(h.approvals.getFor(person, own.id).result?.message, 'Denied.');
  } finally {
    def.run = original;
  }
});

test('an expired request can not be allowed (or denied), and leaves the queue and Needs you', async () => {
  const h = await harness();
  const a = h.approvals.create({ kind: 'test.echo', payload: { text: 'late' }, ttlMinutes: 5 }, { sessionId: 's-ask', workspaceId: null });
  const source = approvalAttentionSource(h.approvals);
  assert.equal(source.list(person, h.clock.now).length, 1);
  h.clock.now += 5 * 60_000;
  assert.equal(await code(h.approvals.allow(person, a.id)), 'CONFLICT');
  assert.equal(await code(h.approvals.deny(person, a.id)), 'CONFLICT');
  assert.equal(h.approvals.getFor(person, a.id).status, 'expired');
  assert.deepEqual(h.approvals.pending(person), []);
  assert.deepEqual(source.list(person, h.clock.now), []);
  assert.equal(h.approvals.expire(), 1, 'marked expired in the table');
  assert.equal(h.sent.length, 0);
});

test('only a person decides: an agent (even the asker), a token of the owner, a job or the system get NOT_FOUND, as a missing request; no MCP tool decides', async () => {
  const h = await harness();
  const a = h.approvals.create({ kind: 'test.echo', payload: { text: 'x' } }, { sessionId: 's-ask', workspaceId: 'docker/ws1' });
  for (const actor of [agentOf('s-ask'), agentOf('s-other'), tokenActor, systemActor('test'), { kind: 'job', userId: FOUNDING_USER_ID, job: 'ci' } as Actor]) {
    assert.equal(await code(h.approvals.allow(actor, a.id)), 'NOT_FOUND', `${actor.kind} may not allow`);
    assert.equal(await code(h.approvals.deny(actor, a.id)), 'NOT_FOUND', `${actor.kind} may not deny`);
    assert.equal(await code(() => h.approvals.getFor(actor, a.id)), 'NOT_FOUND');
    assert.deepEqual(h.approvals.pending(actor), []);
  }
  assert.equal(await code(h.approvals.allow(person, 'apr-missing')), 'NOT_FOUND', 'the same answer as a missing one');
  assert.equal(h.approvals.getFor(person, a.id).status, 'pending', 'nothing was decided');
  // Needs you: listed to decide for a person only.
  assert.equal(approvalAttentionSource(h.approvals).list(agentOf('s-ask'), h.clock.now).length, 0);

  const registry = new ToolRegistry();
  registerApprovalTools(h.approvals, registry);
  assert.deepEqual(registry.list().map((t) => t.name).sort(), ['approval_get', 'approval_list', 'approval_request']);
  assert.ok(registry.list().every((t) => !/allow|deny|decide/.test(t.name)));
});

test('the MCP tools: an agent asks for itself and sees only its own requests; another session\'s is NOT_FOUND', async () => {
  const h = await harness();
  const registry = new ToolRegistry();
  registerApprovalTools(h.approvals, registry);
  const ctx = (sessionId: string | null, isAgent = true) =>
    ({
      isAgent,
      sessionId,
      workspaceId: 'docker/ws1',
      principal: { kind: isAgent ? 'agent' : 'user', userId: FOUNDING_USER_ID, tokenId: 'tk-test', scope: 'operate', workspaceId: 'docker/ws1', sessionId },
      untrusted: (t: string | null | undefined) => (t ? { untrusted_text: t } : null), affected: () => undefined }) as never;
  const call = (name: string, c: never, args: Record<string, unknown>) => Promise.resolve().then(() => registry.get(name)!.handler(c, registry.get(name)!.input.parse(args) as never));
  const mine = (await call('approval_request', ctx('s-a'), { kind: 'test.echo', payload: { text: 'hi' }, reason: 'please' })) as { approval: { id: string; status: string } };
  assert.equal(mine.approval.status, 'pending');
  await call('approval_request', ctx('s-b'), { kind: 'test.echo', payload: { text: 'other' }, reason: 'b' });
  const listed = (await call('approval_list', ctx('s-a'), {})) as { items: { id: string }[] };
  assert.deepEqual(listed.items.map((i) => i.id), [mine.approval.id]);
  assert.equal(await code(call('approval_get', ctx('s-b'), { id: mine.approval.id })), 'NOT_FOUND');
  assert.equal(await code(call('approval_request', ctx(null, false), { kind: 'test.echo', payload: { text: 'x' }, reason: 'r' })), 'FORBIDDEN', 'only an agent asks');
  // session.bypass: an agent asks for its own session only.
  assert.equal(await code(call('approval_request', ctx('s-a'), { kind: 'session.bypass', payload: { sessionId: 's-b' }, reason: 'r' })), 'NOT_FOUND');
});

test('a payload can not be changed: it is validated and stored once, a secret value or a secret-named key is refused, and Allow runs what was stored', async () => {
  const h = await harness();
  const asker = { sessionId: 's-ask', workspaceId: null };
  assert.equal(await code(() => h.approvals.create({ kind: 'test.echo', payload: { text: 'x', extra: 1 } }, asker)), 'VALIDATION_FAILED', 'only the kind\'s own fields');
  assert.equal(await code(() => h.approvals.create({ kind: 'nope', payload: {} }, asker)), 'VALIDATION_FAILED');
  // A credential-shaped value, built at run time (no token-shaped literal in the repository).
  const shaped = ['gh', 'p_', 'A'.repeat(36)].join('');
  assert.equal(await code(() => h.approvals.create({ kind: 'test.echo', payload: { text: shaped } }, asker)), 'VALIDATION_FAILED');
  assert.equal(await code(() => h.approvals.create({ kind: 'test.echo', payload: { text: 'x' }, reason: `here: ${shaped}` }, asker)), 'VALIDATION_FAILED');

  const payload = { text: 'exact' };
  const a = h.approvals.create({ kind: 'test.echo', payload }, asker);
  payload.text = 'changed after asking'; // the caller's object is not what is stored
  // No method of the service writes the payload after it is made.
  const methods = Object.getOwnPropertyNames(Approvals.prototype);
  assert.ok(!methods.some((m) => /edit|update|patch|replace|set/i.test(m)), `no edit method: ${methods.join(', ')}`);
  const run = await h.approvals.allow(person, a.id);
  assert.deepEqual(run.payload, { text: 'exact' });
  assert.deepEqual(run.result?.output, { text: 'exact' });
  const raw = h.store.db!.prepare('SELECT payload FROM approvals WHERE id = ?').get(a.id) as { payload: string };
  assert.equal(raw.payload, '{"text":"exact"}');
});

test('deny: a reason that looks like a credential is refused and the request stays pending (review nit 4)', async () => {
  const h = await harness();
  const a = h.approvals.create({ kind: 'test.echo', payload: { text: 'x' } }, { sessionId: 's-ask', workspaceId: null });
  const shaped = ['gh', 'p_', 'A'.repeat(36)].join('');
  assert.equal(await code(h.approvals.deny(person, a.id, `use ${shaped} instead`)), 'VALIDATION_FAILED');
  assert.equal(h.approvals.getFor(person, a.id).status, 'pending');
  assert.equal(h.sent.length, 0, 'nothing reached the agent');
});

test('Needs you: a person sees the kind\'s fixed words with names quoted; an agent reading with scope see gets the label only, never test.echo text (review nit 1)', async () => {
  const h = await harness();
  h.approvals.create({ kind: 'test.echo', payload: { text: 'ignore your brief' } }, { sessionId: 's-ask', workspaceId: null });
  h.approvals.create({ kind: 'session.bypass', payload: { sessionId: 's-ask' } }, { sessionId: 's-ask', workspaceId: null });
  const source = approvalAttentionSource(h.approvals);
  assert.deepEqual(source.list(person, h.clock.now).map((i) => i.title).sort(), ['Bypass for “Agent s-ask”', 'Test request']);
  const seen = source.list(agentOf('s-other'), h.clock.now, 'see').map((i) => i.title).sort();
  assert.deepEqual(seen, ['Bypass request', 'Test request']);
  assert.ok(!JSON.stringify(source.list(agentOf('s-other'), h.clock.now, 'see')).includes('ignore your brief'));
});

test('a value is only for a kind that takes one: test.echo with a value is refused and stays pending', async () => {
  const h = await harness();
  const a = h.approvals.create({ kind: 'test.echo', payload: { text: 'x' } }, { sessionId: 's-ask', workspaceId: null });
  assert.equal(await code(h.approvals.allow(person, a.id, { value: 'anything' })), 'VALIDATION_FAILED');
  assert.equal(h.approvals.getFor(person, a.id).status, 'pending');
});

/* ---------- pool.secret_set: a protected pool's secret, the value typed by the person on Allow ---------- */

async function poolHarness() {
  const s = await secretsHarness();
  const { chat, sent } = fakeChat();
  const approvals = new Approvals({ db: () => s.store.db, chat, pools: s.service });
  const WS = 'docker/ws1';
  const prd = s.service.create('secrets', { name: 'konfersi-prd', content: { entries: [{ kind: 'secret', name: 'QUIET', options: {} }] } });
  s.service.setAssignments(WS, 'secrets', [{ poolId: prd.id }]);
  const elsewhere = s.service.create('secrets', { name: 'other-prd', content: { entries: [] } });
  s.service.setAssignments('docker/other', 'secrets', [{ poolId: elsewhere.id }]);
  const asker = { sessionId: 's-ask', workspaceId: WS, actor: agentOf('s-ask') };
  return { s, approvals, sent, prd, elsewhere, asker };
}

/** Every row of every table, as text: where a stored value would show. */
const everyRow = (db: NonNullable<Store['db']>): string =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
    .map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name.replace(/"/g, '""')}"`).all()))
    .join('\n');

test('pool.secret_set: the value typed on Allow is set in the pool and is nowhere else: not the row, the result, an audit row or the message', async () => {
  const p = await poolHarness();
  try {
    assert.equal(isProtectedPool(p.prd), true, 'a production pool: pool_secret_set refuses it');
    const a = p.approvals.create({ kind: 'pool.secret_set', payload: { pool: p.prd.id, name: 'API_KEY', baseRevision: p.prd.latestRevision }, reason: 'the new key' }, p.asker);
    assert.equal(a.status, 'pending');
    // No value yet: refused before the request is used, so the person can type it and click again.
    assert.equal(await code(p.approvals.allow(person, a.id)), 'VALIDATION_FAILED');
    assert.equal(p.approvals.getFor(person, a.id).status, 'pending');

    const v = `v-${randomBytes(16).toString('hex')}`;
    const done = await p.approvals.allow(person, a.id, { value: v });
    assert.equal(done.status, 'allowed');
    assert.equal(done.result?.ok, true, done.result?.message);
    assert.deepEqual(done.result?.output, { pool: p.prd.id, name: 'API_KEY', revision: p.prd.latestRevision + 1, expose: true });
    const entry = ((p.s.service.get(p.prd.id).content as { entries: SecretEntryView[] }).entries).find((e) => e.name === 'API_KEY');
    assert.ok(entry?.secret?.fingerprint, 'the pool has the secret');

    assert.ok(!JSON.stringify(done).includes(v), 'not in what Allow returns');
    assert.ok(!p.sent.some((m) => m.text.includes(v)), 'not in the message to the agent');
    assert.match(p.sent[0]!.text, /Allowed: API_KEY set in konfersi-prd/);
    assert.ok(!everyRow(p.s.store.db!).includes(v), 'not in any row of any table (the request, its result, the audit, the revision note)');
    assert.ok(!everyRow(p.s.store.db!).includes(v.slice(-10)), 'nor its end');

    // An existing secret keeps its expose when the payload names none (QUIET is not exposed).
    const b = p.approvals.create({ kind: 'pool.secret_set', payload: { pool: p.prd.id, name: 'QUIET', baseRevision: p.s.service.get(p.prd.id).latestRevision } }, p.asker);
    assert.equal((await p.approvals.allow(person, b.id, { value: `v-${randomBytes(8).toString('hex')}` })).result?.output?.expose, false);
  } finally {
    p.s.done();
  }
});

test('pool.secret_set: an agent can not ask for a pool its workspace does not get (the same NOT_FOUND as a missing one), nor carry a value in the payload', async () => {
  const p = await poolHarness();
  try {
    const ask = (payload: Record<string, unknown>) => () => p.approvals.create({ kind: 'pool.secret_set', payload }, p.asker);
    assert.equal(await code(ask({ pool: p.elsewhere.id, name: 'API_KEY', baseRevision: 1 })), 'NOT_FOUND');
    assert.equal(await code(ask({ pool: 'pool-missing', name: 'API_KEY', baseRevision: 1 })), 'NOT_FOUND');
    assert.equal(await code(() => p.approvals.create({ kind: 'pool.secret_set', payload: { pool: p.prd.id, name: 'API_KEY', baseRevision: 1 } }, { sessionId: 's-x', workspaceId: 'docker/ws1' })), 'NOT_FOUND', 'an asker without a verified actor');
    assert.equal(await code(ask({ pool: p.prd.id, name: 'API_KEY', baseRevision: 1, value: 'x' })), 'VALIDATION_FAILED', 'the payload has no value field');
    assert.equal((p.s.store.db!.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n, 0);
    // The portal itself may ask for any pool (no requester).
    assert.equal(p.approvals.create({ kind: 'pool.secret_set', payload: { pool: p.elsewhere.id, name: 'API_KEY', baseRevision: 1 } }, null).status, 'pending');
  } finally {
    p.s.done();
  }
});

test('pool.secret_set: a pool that moved on since the agent read it is a conflict at Allow and the request stays pending', async () => {
  const p = await poolHarness();
  try {
    const a = p.approvals.create({ kind: 'pool.secret_set', payload: { pool: p.prd.id, name: 'API_KEY', baseRevision: p.prd.latestRevision } }, p.asker);
    p.s.service.update(p.prd.id, { content: { entries: [] }, baseRevision: p.prd.latestRevision });
    assert.equal(await code(p.approvals.allow(person, a.id, { value: `v-${randomBytes(8).toString('hex')}` })), 'CONFLICT');
    assert.equal(p.approvals.getFor(person, a.id).status, 'pending');
  } finally {
    p.s.done();
  }
});

/* ---------- session.bypass, through the chat's own gated path ---------- */

async function bypassHarness(s: Live) {
  const state = { fresh: true };
  s.controller.bypassAllowed = () => true;
  s.controller.reauth = { fresh: (token) => token === 'tok' && state.fresh };
  const approvals = new Approvals({ db: () => s.store.db, chat: s.controller });
  return { approvals, state };
}

async function capableSession(s: Live, optIn: boolean) {
  const before = s.ws.tails.length;
  const created = await s.controller.create({ workspaceId: 'docker/ws1' }, optIn ? { bypassOptIn: true } : {});
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  return { id: created.id, tail: s.ws.tails.at(-1)! };
}

test('session.bypass: Allow puts a bypass-capable session in Bypass through the gated path, audited bypass.entered by the person via the approval', async () => {
  const s = await liveSession();
  try {
    const { approvals, state } = await bypassHarness(s);
    const b = await capableSession(s, true);
    const a = approvals.create({ kind: 'session.bypass', payload: { sessionId: b.id }, reason: 'long unattended run' }, { sessionId: b.id, workspaceId: 'docker/ws1' });

    // No fresh server code: refused before the request is used, so the person can enter the code and click again.
    state.fresh = false;
    assert.equal(await code(approvals.allow(person, a.id, { sessionToken: 'tok' })), 'REAUTH_REQUIRED');
    assert.equal(approvals.getFor(person, a.id).status, 'pending');
    state.fresh = true;

    const allowing = approvals.allow(person, a.id, { sessionToken: 'tok' });
    const req = await s.take('set_permission_mode');
    b.tail.push(ok(req.id, { mode: 'bypassPermissions' }));
    const done = await allowing;
    assert.equal(done.status, 'allowed');
    assert.equal(done.result?.ok, true);
    assert.equal(s.controller.get(b.id)!.mode, 'bypassPermissions');
    const entered = s.controller.audit({ kind: 'bypass.entered' });
    assert.equal(entered.length, 1);
    assert.deepEqual([entered[0]!.sessionId, entered[0]!.actor, entered[0]!.severity], [b.id, 'ui', 'high']);
    assert.deepEqual(entered[0]!.detail, { claude: 'Default', policy: 'allowed', capable: true, acknowledged: true, reauth: 'fresh', via: 'approval', approvalId: a.id });
  } finally {
    await s.done();
  }
});

test('PILOT-1000: Bypass over MCP (session_configure) files a session.bypass card, takes no acknowledgement, and Allow goes through the enterBypass gate', async () => {
  const s = await liveSession();
  try {
    const { approvals, state } = await bypassHarness(s);
    const b = await capableSession(s, true);
    const plain = await capableSession(s, false);
    const registry = new ToolRegistry();
    registerSessionTools({ store: { writable: true } as never, chat: s.controller as never, approvals }, registry);
    const ctx = (scope: 'admin' | 'read') =>
      ({
        isAgent: false,
        sessionId: null,
        workspaceId: null,
        actor: 'portal-mcp:tk-admin',
        principal: { kind: 'user', userId: FOUNDING_USER_ID, tokenId: 'tk-admin', scope, workspaceId: null, sessionId: null },
        untrusted: (t: string | null | undefined) => (t ? { untrusted_text: t } : null),
        affected: () => undefined,
      }) as never;
    const tool = registry.get('session_configure')!;
    const call = (c: never, args: Record<string, unknown>) => Promise.resolve().then(() => tool.handler(c, tool.input.parse(args) as never)) as Promise<{ approval?: { id: string; status: string; page: string } }>;
    const sends = () => s.ws.sends.filter((x) => x.line.includes('set_permission_mode')).length;
    const before = sends();

    // An acknowledgement in the call is no input (the schema drops it): the call files a card and changes nothing.
    const asked = await call(ctx('admin'), { id: b.id, mode: 'bypassPermissions', reason: 'unattended release run', acknowledged: true });
    assert.equal(asked.approval?.status, 'pending');
    assert.match(asked.approval!.page, /approvals/);
    assert.equal(s.controller.get(b.id)!.mode, 'default');
    assert.equal(sends(), before, 'no set_permission_mode until a person allows it');
    const a = approvals.getFor(person, asked.approval!.id);
    assert.deepEqual([a.kind, a.payload, a.requesterSession, a.reason], ['session.bypass', { sessionId: b.id }, null, 'unattended release run']);

    // Bypass alone (the rest would not wait for the person); a token that may not operate the session gets the missing-session answer.
    assert.equal(await code(call(ctx('admin'), { id: b.id, mode: 'bypassPermissions', model: 'sonnet' })), 'VALIDATION_FAILED');
    assert.equal(await code(call(ctx('read'), { id: b.id, mode: 'bypassPermissions' })), 'NOT_FOUND');
    // A session not started bypass-capable still becomes a card (its Allow then says BYPASS_NOT_CAPABLE, tested below).
    assert.equal((await call(ctx('admin'), { id: plain.id, mode: 'bypassPermissions' })).approval?.status, 'pending');

    // Allow: without a fresh server code it stays pending; with one, the gated path turns Bypass on, audited via the approval.
    state.fresh = false;
    assert.equal(await code(approvals.allow(person, a.id, { sessionToken: 'tok' })), 'REAUTH_REQUIRED');
    assert.equal(approvals.getFor(person, a.id).status, 'pending');
    state.fresh = true;
    const allowing = approvals.allow(person, a.id, { sessionToken: 'tok' });
    const req = await s.take('set_permission_mode');
    b.tail.push(ok(req.id, { mode: 'bypassPermissions' }));
    assert.equal((await allowing).result?.ok, true);
    assert.equal(s.controller.get(b.id)!.mode, 'bypassPermissions');
    assert.deepEqual(s.controller.audit({ kind: 'bypass.entered' }).map((r) => r.detail.approvalId), [a.id]);
    // Already in Bypass: nothing more is asked.
    assert.equal((await call(ctx('admin'), { id: b.id, mode: 'bypassPermissions' })).approval, undefined);
  } finally {
    await s.done();
  }
});

test('session.bypass: a session that was not started bypass-capable never enters Bypass; the request is used and says why', async () => {
  const s = await liveSession();
  try {
    const { approvals } = await bypassHarness(s);
    const plain = await capableSession(s, false);
    const a = approvals.create({ kind: 'session.bypass', payload: { sessionId: plain.id } }, null);
    const sends = () => s.ws.sends.filter((x) => x.line.includes('set_permission_mode')).length;
    const before = sends();
    const done = await approvals.allow(person, a.id, { sessionToken: 'tok' });
    assert.equal(done.status, 'allowed');
    assert.deepEqual([done.result?.ok, done.result?.output?.code], [false, BYPASS_NOT_CAPABLE]);
    assert.equal(s.controller.get(plain.id)!.mode, 'default');
    assert.equal(sends(), before, 'not one set_permission_mode was written');
    assert.equal(s.controller.audit({ kind: 'bypass.entered' }).length, 0);
    assert.deepEqual(s.controller.audit({ kind: 'bypass.refused' }).map((r) => r.detail.why), ['not_capable']);
    // And an agent's token never reaches it at all.
    const again = approvals.create({ kind: 'session.bypass', payload: { sessionId: plain.id } }, null);
    assert.equal(await code(approvals.allow(agentOf(plain.id), again.id, { sessionToken: 'tok' })), 'NOT_FOUND');
  } finally {
    await s.done();
  }
});
