// The program pause switch (T-259 slice 3): a pause of all, or of a chat's program, holds the chat: the sweep still looks (state, reports
// that clear) but sends no nudge, wake or answer, starts no new chat and raises no report; the "left down" clock counts from the resume; a
// resume looks again at once. Who may: a platform admin (a person, or an admin token after a confirmation); an agent, a token below admin and
// a user who is not an admin are answered NOT_FOUND. Every change is one audit row `keepgoing.pause`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOUNDING_USER_ID, KEEPGOING_API, type Actor, type KeepGoingList } from '@portal/contracts';
import type { Hono } from 'hono';
import { createApp } from '../app.js';
import { fakeOwner, freshStore } from '../notify/testkit.js';
import { createPlatform } from '../platform/index.js';
import { Portal } from '../portal.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { KEEPGOING_TOOL_POLICIES } from './authz.js';
import { registerKeepGoingTools } from './portalTools.js';
import { parsePause } from './routes.js';
import { KgChat, fakeClock, rig, settingsMap } from './testkit.js';

test('a program pause holds only that program’s chats; nothing is sent while paused; resume nudges at once', async () => {
  const r = await rig();
  r.chat.put('s_k');
  r.chat.put('s_o');
  r.on('s_k', { program: 'konfersi' });
  r.on('s_o', { program: 'orchestrator' });
  r.engine.setPause('konfersi', true, 'user:u_a', 'u_a', 'Focus on ClaudePilot');
  const v = r.engine.view('s_k')!;
  assert.equal(v.paused, true);
  assert.equal(v.pause?.program, 'konfersi');
  assert.equal(v.pause?.reason, 'Focus on ClaudePilot');
  assert.equal(r.engine.view('s_o')!.paused, false);
  for (let i = 0; i < 10; i++) await r.after(1);
  const to = (id: string) => r.chat.sent.filter((m) => m.id === id).length;
  assert.equal(to('s_k'), 0, 'a paused chat is never nudged');
  assert.ok(to('s_o') >= 1, 'another program goes on');
  assert.equal(r.engine.last.get('s_k')?.act, 'nudge', 'the look still happens: it would have nudged');
  const before = r.chat.sent.length;
  r.engine.setPause('konfersi', false, 'user:u_a', 'u_a', null);
  await r.engine.round();
  assert.equal(to('s_k'), 1, 'resume looks again at once');
  assert.ok(r.chat.sent.length > before);
  assert.equal(r.engine.view('s_k')!.paused, false);
  const rows = r.auditRows('keepgoing.pause');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.detail.paused).sort(), [false, true]);
  assert.equal(rows[0]!.subject, 'keepgoing:konfersi');
});

test('a pause of all holds every chat, with or without a program; an ended chat is not restarted nor reported, and is brought back at resume', async () => {
  const r = await rig();
  r.chat.put('s1', { ticketId: 'T-9' });
  r.chat.put('s2');
  r.on('s1');
  r.on('s2', { program: 'event' });
  r.engine.setPause(null, true, 'user:u_a', 'u_a', 'Owner away');
  assert.equal(r.engine.view('s1')!.pause?.program, null);
  assert.equal(r.engine.view('s2')!.pause?.program, null, 'all comes first');
  r.chat.patch('s1', { state: 'ended', process: 'gone', endedReason: 'the process exited (code 1)', endedFor: null });
  r.chat.patch('s2', { state: 'interrupted', process: 'gone' });
  for (let i = 0; i < 40; i++) await r.after(1);
  assert.equal(r.chat.started.length, 0, 'no new chat while paused');
  assert.equal(r.chat.resumed.length, 0, 'no wake while paused');
  assert.equal(r.chat.sent.length, 0);
  assert.equal(r.tickets.made.length, 0, 'no "left down" ticket after 40 minutes paused');
  assert.equal(r.emitted.length, 0, 'no push');
  assert.equal(r.engine.list(() => true).pauses?.length, 1);
  r.engine.setPause(null, false, 'user:u_a', 'u_a', null);
  await r.engine.round();
  assert.equal(r.chat.started.length, 1, 'the ended chat is continued at resume');
  assert.equal(r.chat.resumed.length, 1, 'the interrupted one is woken');
  assert.equal(r.tickets.made.length, 0, 'and not reported as left down: the clock counts from the resume');
  assert.equal(r.engine.view(r.chat.started[0]!.id)!.program ?? null, null);
});

test('the program is carried to a continuation chat; a pause that stands keeps its since; resume of nothing changes nothing', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1', { program: 'event' });
  r.chat.patch('s1', { state: 'ended', process: 'gone', endedReason: 'the process exited (code 1)', endedFor: null });
  await r.engine.round();
  const fresh = r.chat.started[0]!.id;
  assert.equal(r.engine.view(fresh)!.program, 'event');
  const a = r.engine.setPause('event', true, 'user:u_a', 'u_a', 'one');
  await r.after(5);
  const b = r.engine.setPause('event', true, 'user:u_a', 'u_a', 'two');
  assert.equal(b.pause!.since, a.pause!.since);
  assert.equal(b.pause!.reason, 'two');
  assert.equal(r.engine.setPause('konfersi', false, 'user:u_a', 'u_a', null).changed, false);
  assert.equal(r.auditRows('keepgoing.pause').length, 2);
});

test('parsePause: a program slug or null, a reason to pause, nothing else', () => {
  assert.deepEqual(parsePause({ program: null, paused: true, reason: ' Away ' }), { program: null, paused: true, reason: 'Away' });
  assert.deepEqual(parsePause({ program: 'event', paused: false }), { program: 'event', paused: false, reason: null });
  for (const bad of [{ program: 'Event', paused: true, reason: 'x' }, { program: '../x', paused: true, reason: 'x' }, { paused: true, reason: 'x' }, { program: null, paused: true }, { program: null, paused: 'yes' }, { program: null, paused: false, extra: 1 }, { program: null, paused: true, reason: 'a\nb' }]) {
    assert.throws(() => parsePause(bad as Record<string, unknown>), /./, JSON.stringify(bad));
  }
});

const CODE = '24681357';
const HOST = 'localhost:3237';

async function app() {
  const { store } = await freshStore();
  const chat = new KgChat(fakeClock(Date.now()));
  chat.put('s_a');
  const owner = fakeOwner({ 'session:s_a': 'u_a' }, { fallback: 'u_a' });
  let as: Actor | null = null;
  const realActorOf = owner.actorOf.bind(owner);
  owner.actorOf = ((c: never) => (as ? { actor: as, userId: 'u_a', admin: false, label: `${as.kind}:test` } : realActorOf(c))) as typeof owner.actorOf;
  const platform = createPlatform({ store, settings: settingsMap(), chat, uiUrl: null, pushContact: null, selfOrigin: `http://${HOST}`, owner, tools: false });
  platform.start();
  const portal = new Portal(CODE, 60_000);
  const stub: unknown = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : stub), apply: () => stub, construct: () => stub as object });
  const a = (createApp as unknown as (...x: unknown[]) => Hono)(portal, stub, store, stub, stub, stub, stub, chat, { serveWeb: false, poolService: stub, platform });
  const token = portal.signIn(CODE);
  const call = async (user: string, method: string, path: string, body?: unknown, actor: Actor | null = null) => {
    owner.caller = user;
    as = actor;
    const res = await a.request(`http://${HOST}${path}`, {
      method,
      headers: { Host: HOST, Cookie: `portal_session=${token}`, Origin: `http://${HOST}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string } } | null;
    return { status: res.status, data: json?.data, error: json?.error };
  };
  return { call, platform };
}

test('PUT /api/keepgoing/pauses: an admin pauses and resumes; GET lists the pause; a non-admin, an agent and a narrow token get 404', async () => {
  const b = await app();
  try {
    const p = await b.call('u_a', 'PUT', KEEPGOING_API.pauses, { program: 'konfersi', paused: true, reason: 'Focus' });
    assert.equal(p.status, 200, JSON.stringify(p.error));
    const list = (await b.call('u_a', 'GET', KEEPGOING_API.list)).data as KeepGoingList;
    assert.equal(list.pauses?.[0]?.program, 'konfersi');
    assert.equal(list.pauses?.[0]?.by, 'user:u_a');
    assert.equal((await b.call('u_b', 'PUT', KEEPGOING_API.pauses, { program: null, paused: true, reason: 'x' })).status, 404, 'not an admin');
    const agent: Actor = { kind: 'agent', userId: 'u_a' as never, tokenId: 't1', sessionId: 's_a', workspaceId: 'docker/x' };
    assert.equal((await b.call('u_a', 'PUT', KEEPGOING_API.pauses, { program: null, paused: true, reason: 'x' }, agent)).status, 404, 'an agent');
    const narrow: Actor = { kind: 'token', userId: 'u_a' as never, tokenId: 't2', scope: 'operate' as never };
    assert.equal((await b.call('u_a', 'PUT', KEEPGOING_API.pauses, { program: null, paused: true, reason: 'x' }, narrow)).status, 404, 'a token below admin');
    assert.equal((await b.call('u_a', 'PUT', KEEPGOING_API.pauses, { program: null, paused: true })).status, 422, 'a pause needs a reason');
    assert.equal((await b.call('u_a', 'PUT', KEEPGOING_API.pauses, { program: 'konfersi', paused: false })).status, 200);
    assert.deepEqual(((await b.call('u_a', 'GET', KEEPGOING_API.list)).data as KeepGoingList).pauses, []);
  } finally {
    b.platform.stop();
  }
});

test('keepgoing_pause_set: an admin token pauses after a confirmation; an agent and a narrow token are refused; a non-admin user NOT_FOUND', async () => {
  const owner = fakeOwner({}, { fallback: FOUNDING_USER_ID });
  owner.isAdmin = (u: string) => u === FOUNDING_USER_ID;
  const r = await rig({ owner });
  r.chat.put('s_a');
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  h.module.settings.update({ sessionControl: true });
  registerKeepGoingTools({ engine: r.engine, chat: r.chat, owner }, registry);
  try {
    const t = h.token('admin');
    const first = await h.call(t.secret, 'keepgoing_pause_set', { program: 'event', paused: true, reason: 'Owner paused Event' });
    assert.equal(first.result?.structuredContent.status, 'confirmation_required', JSON.stringify(first.raw));
    assert.match(first.result!.structuredContent.preview.changes, /PAUSE Keep going for event/);
    assert.equal(r.kg.pauses().length, 0, 'nothing before the confirmation');
    const ok = await h.call(t.secret, 'keepgoing_pause_set', { program: 'event', paused: true, reason: 'Owner paused Event', confirm_token: first.result!.structuredContent.confirm_token });
    assert.equal(ok.result?.isError, undefined, JSON.stringify(ok.raw));
    assert.equal(r.kg.pauses()[0]!.program, 'event');
    assert.equal(r.auditRows('keepgoing.pause')[0]!.actor, `portal-mcp:${t.id}`);
    const narrow = await h.call(h.token('operate').secret, 'keepgoing_pause_set', { program: null, paused: true, reason: 'x' });
    assert.ok(narrow.result?.isError === true || !!narrow.error, 'a token below admin');
    const agent = await h.agentToken('docker/api-dev', 's_a');
    const self = await h.call(agent.secret, 'keepgoing_pause_set', { program: null, paused: false });
    assert.ok(self.result?.isError === true || !!self.error, 'an agent');
    owner.isAdmin = () => false;
    const denied = await h.call(t.secret, 'keepgoing_pause_set', { program: 'event', paused: false });
    assert.equal(denied.result?.structuredContent?.error?.code ?? denied.error?.message, 'NOT_FOUND');
    assert.equal(r.kg.pauses().length, 1, 'still paused');
  } finally {
    h.done();
  }
});

test('the pause tool is declared through the seam: settings manage, confirmed, audited', () => {
  assert.deepEqual(KEEPGOING_TOOL_POLICIES.keepgoing_pause_set, { kind: 'platform', area: 'settings', verb: 'manage', confirm: true, audit: 'keepgoing.pause' });
});
