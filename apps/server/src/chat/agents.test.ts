// Sessions starting and messaging sessions: the limits (depth, running workers, an hour's spawns and messages), both transcripts
// saying so, who may message whom (parent, workers, crew), ending a parent and what becomes of its workers, the Claude a worker runs
// on (T-294), and the MCP tools a session's token opens.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { ChatSession, MoveCandidate, MoveRecommendation } from '@portal/contracts';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { MessageRate, pickSpawnClaude, spawnProblem, type AgentCaps } from './agents.js';
import { SESSION_CAP } from './caps.js';
import { registerChatTools, type ChatToolHost } from './portalTools.js';
import { liveSession, until, type Live } from './testkit.js';

const CAPS: AgentCaps = { maxDepth: 1, maxChildren: 2, spawnsPerHour: 3, messagesPerHour: 3 };
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (isAppError(e) ? `${e.code}:${(e.details as { scope?: string } | undefined)?.scope ?? ''}` : String(e)));

/** A child session of `parent`, started the way the controller is asked to by a session (its actor, its parent). */
async function child(s: Live, parentId: string, title = 'Worker') {
  const before = s.ws.tails.length;
  const made = await s.controller.create({ workspaceId: 'docker/ws1', title }, { actor: `session:${parentId}`, parentId });
  await until(() => s.ws.tails.length === before + 1);
  return made;
}

/** A Move ranking's candidate as `recommendMove` makes it: ranked when it can take a chat, measured unless over its pace or unknown. */
const cand = (claudeId: string, reason: MoveCandidate['reason'], o: Partial<MoveCandidate> = {}) =>
  ({
    claudeId,
    name: claudeId,
    workspaceId: 'docker/ws1',
    rank: ['room', 'over_pace', 'no_limits', 'tight'].includes(reason) ? 1 : null,
    recommended: false,
    reason,
    basis: reason === 'over_pace' ? 'estimate' : reason === 'unknown' ? 'unavailable' : 'measured',
    stale: false,
    ...o,
  }) as MoveCandidate;
const ranking = (...candidates: MoveCandidate[]) => ({ now: '', workspaceId: 'docker/ws1', from: null, recommended: null, none: null, candidates }) as MoveRecommendation;
const CLAUDES = [
  { id: 'p', name: 'Default', removedAt: null },
  { id: 'a', name: 'Sekar', removedAt: null },
  { id: 'b', name: 'Hasyim', removedAt: null },
  { id: 'gone', name: 'Old', removedAt: '2026-01-01T00:00:00.000Z' },
];

test('pickSpawnClaude (T-294): the parent’s by default, a named one, or on auto the first with measured room; never billed per use, tight, over pace, stale, unknown or removed', () => {
  assert.deepEqual(pickSpawnClaude(undefined, 'p', CLAUDES, null), { claudeId: 'p', why: 'parent' });
  assert.deepEqual(pickSpawnClaude(' same ', 'p', CLAUDES, null), { claudeId: 'p', why: 'parent' });
  assert.deepEqual(pickSpawnClaude('hasyim', 'p', CLAUDES, null), { claudeId: 'b', why: 'named' }, 'by name, any case');
  assert.deepEqual(pickSpawnClaude('a', 'p', CLAUDES, null), { claudeId: 'a', why: 'named' }, 'by id');
  assert.deepEqual(pickSpawnClaude('Default', 'p', CLAUDES, null), { claudeId: 'p', why: 'parent' }, 'naming its own is its own');
  assert.throws(() => pickSpawnClaude('Old', 'p', CLAUDES, null), /No Claude “Old” on this workspace\. Use same, auto or one of: Default, Sekar, Hasyim\./, 'a removed Claude is none');
  assert.throws(() => pickSpawnClaude('nobody', 'p', CLAUDES, null), (e: unknown) => isAppError(e) && e.code === 'VALIDATION_FAILED');

  assert.deepEqual(pickSpawnClaude('auto', 'p', CLAUDES, null), { claudeId: 'p', why: 'usage_unknown' }, 'no ranking: stays');
  assert.deepEqual(pickSpawnClaude('auto', 'p', CLAUDES, ranking(cand('b', 'room'), cand('a', 'room'), cand('p', 'tight'))), { claudeId: 'b', why: 'most_room' }, 'the ranking’s first with room');
  assert.deepEqual(pickSpawnClaude('AUTO', 'p', CLAUDES, ranking(cand('p', 'room'), cand('a', 'room'))), { claudeId: 'p', why: 'parent' }, 'its own when that has the most room');
  const none = ranking(
    cand('a', 'over_pace'),
    cand('pool', 'no_limits'),
    cand('b', 'room', { stale: true }),
    cand('gone', 'room'),
    cand('p', 'tight'),
    cand('a', 'exhausted'),
    cand('b', 'unknown'),
    cand('a', 'room', { basis: 'estimate' }),
  );
  assert.deepEqual(pickSpawnClaude('auto', 'p', CLAUDES, none), { claudeId: 'p', why: 'no_room' });
});

test('spawnProblem: depth, running workers and spawns an hour, each with its own words', () => {
  const kids = (...states: [string, number][]) => states.map(([state, minutesAgo]) => ({ state, createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() }));
  assert.equal(spawnProblem(CAPS, { id: 'p', depth: 0 }, []), null);
  assert.match(spawnProblem(CAPS, { id: 'w', depth: 1 }, [])!.message, /1 level deep/);
  assert.match(spawnProblem({ ...CAPS, maxDepth: 0 }, { id: 'p', depth: 0 }, [])!.message, /may not start sessions/);
  assert.match(spawnProblem(CAPS, { id: 'p', depth: 0 }, kids(['working', 5], ['idle', 5]))!.message, /already has 2 workers running/);
  assert.equal(spawnProblem(CAPS, { id: 'p', depth: 0 }, kids(['ended', 5], ['idle', 5])), null, 'an ended worker is not running');
  assert.match(spawnProblem(CAPS, { id: 'p', depth: 0 }, kids(['ended', 5], ['ended', 10], ['ended', 20]))!.message, /3 workers in the last hour/);
  assert.equal(spawnProblem(CAPS, { id: 'p', depth: 0 }, kids(['ended', 5], ['ended', 10], ['ended', 90])), null, 'older than an hour does not count');
  const rate = new MessageRate();
  const t = Date.now();
  assert.deepEqual([1, 2, 3, 4].map(() => rate.allow('a', 3, t)), [true, true, true, false]);
  assert.equal(rate.allow('b', 3, t), true, 'per sender');
  assert.equal(rate.allow('a', 3, t + 3_700_000), true, 'an hour later');
});

test('a session starts workers within the limits; both transcripts say so; the worker is the parent’s', async () => {
  const s = await liveSession();
  try {
    s.controller.agentCaps = () => CAPS;
    const a = await child(s, s.id, 'Fix the login redirect');
    assert.equal(a.parentId, s.id);
    assert.equal(a.startedBy, `session:${s.id}`);
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'system' && e.text === 'Started “Fix the login redirect”.'), 'the parent’s transcript');
    assert.deepEqual(s.controller.audit({ kind: 'agent.spawned' }).map((x) => [x.sessionId, x.actor, x.detail.parent]), [[a.id, `session:${s.id}`, s.id]]);
    assert.deepEqual(s.controller.children(s.id).map((c) => c.id), [a.id]);
    assert.equal(a.bypassCapable, false, 'a worker is never bypass-capable');

    // Depth: a worker may not start workers at depth 1.
    assert.equal(await code(s.controller.create({ workspaceId: 'docker/ws1' }, { actor: `session:${a.id}`, parentId: a.id })), `${SESSION_CAP}:depth`);
    // Running workers: the second is fine, the third refused; one ending frees a place.
    const b = await child(s, s.id, 'Second');
    assert.equal(await code(s.controller.create({ workspaceId: 'docker/ws1' }, { actor: `session:${s.id}`, parentId: s.id })), `${SESSION_CAP}:children`);
    await s.controller.end(b.id);
    await child(s, s.id, 'Third');
    // An hour's spawns: 3 made, the fourth refused even with none running.
    for (const c of s.controller.children(s.id)) await s.controller.end(c.id);
    assert.equal(await code(s.controller.create({ workspaceId: 'docker/ws1' }, { actor: `session:${s.id}`, parentId: s.id })), `${SESSION_CAP}:rate`);
    assert.ok(s.controller.audit({ kind: 'agent.refused' }).length >= 3, 'refusals are on the record');
    // No caps installed: no limits.
    s.controller.agentCaps = undefined;
    await child(s, s.id, 'Unlimited');
  } finally {
    await s.done();
  }
});

test('a session messages its parent, its workers and its crew (T-294), nobody else, a few an hour; the other transcript shows who it is from', async () => {
  const s = await liveSession();
  try {
    s.controller.agentCaps = () => ({ ...CAPS, maxChildren: 5, spawnsPerHour: 10 });
    const w1 = await child(s, s.id, 'One');
    const w2 = await child(s, s.id, 'Two');
    await s.controller.messageFamily(s.id, w1.id, 'Start on the router.');
    const card = s.controller.history(w1.id).find((e) => e.kind === 'user' && e.actor === `session:${s.id}`)!;
    assert.equal(card.text, 'Start on the router.');
    assert.equal(card.actorLabel, s.controller.get(s.id)!.title, 'labelled with the sender’s title as it was then');
    await s.controller.messageFamily(w1.id, s.id, 'Done: the router is split.'); // up to its parent
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'user' && e.actor === `session:${w1.id}`));
    // Its crew (another worker of its parent, T-294): yes, framed as from it.
    await s.controller.messageFamily(w1.id, w2.id, 'I take the router, you take the tests.');
    const crewCard = s.controller.history(w2.id).find((e) => e.kind === 'user' && e.actor === `session:${w1.id}`)!;
    assert.equal(crewCard.text, 'I take the router, you take the tests.');
    // Strangers, and the workers of another parent: no.
    const stranger = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Stranger' });
    assert.equal(await code(s.controller.messageFamily(s.id, stranger.id, 'hi')), 'FORBIDDEN:');
    assert.equal(await code(s.controller.messageFamily(stranger.id, s.id, 'hi')), 'FORBIDDEN:');
    await until(() => s.controller.get(stranger.id)?.state === 'idle');
    const theirs = await child(s, stranger.id, 'Theirs');
    assert.equal(await code(s.controller.messageFamily(w1.id, theirs.id, 'hi')), 'FORBIDDEN:', 'not its crew');
    assert.equal(await code(s.controller.messageFamily(theirs.id, w2.id, 'hi')), 'FORBIDDEN:', 'not its crew either way');
    // An hour's messages: three sent by w1's parent so far (one to w1... counting), the limit is 3.
    await s.controller.messageFamily(s.id, w1.id, 'again');
    await s.controller.messageFamily(s.id, w1.id, 'and again');
    assert.equal(await code(s.controller.messageFamily(s.id, w1.id, 'once more')), `${SESSION_CAP}:messages`);
    await s.controller.end(w2.id);
    assert.equal(await code(s.controller.messageFamily(w1.id, w2.id, 'x')), 'CONFLICT:', 'an ended crew member is not messaged');
    assert.equal(await code(s.controller.messageFamily(s.id, w2.id, 'to an ended worker')), 'CONFLICT:');
  } finally {
    await s.done();
  }
});

test('ending a parent asks what becomes of its workers: left running by default, ended deepest first when told', async () => {
  const s = await liveSession();
  try {
    const a = await child(s, s.id, 'A');
    const b = await child(s, a.id, 'B'); // a grandchild
    const c = await child(s, s.id, 'C');
    await s.controller.end(s.id);
    assert.deepEqual([a, b, c].map((x) => s.controller.get(x.id)!.state === 'ended'), [false, false, false], 'default: they carry on');
    const order: string[] = [];
    const off = s.controller.onEvent((id, m) => m.type === 'session' && m.session.state === 'ended' && order.push(id));
    await s.controller.end(s.id, { children: 'end' });
    off();
    assert.deepEqual([a, b, c].map((x) => s.controller.get(x.id)!.state), ['ended', 'ended', 'ended']);
    assert.ok(order.indexOf(b.id) < order.indexOf(a.id), 'the grandchild first');
    assert.deepEqual(s.controller.audit({ kind: 'agent.ended_children' }).map((x) => x.detail.count), [3]);
  } finally {
    await s.done();
  }
});

test('T-294: a worker’s Claude is its parent’s, a named one, or on auto the one with the most room (a failing ranking keeps the parent’s); its crew is its parent’s other workers', async () => {
  const s = await liveSession();
  try {
    s.controller.agentCaps = () => ({ ...CAPS, maxChildren: 5, spawnsPerHour: 10 });
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const mine = s.controller.get(s.id)!.claudeId;
    assert.deepEqual(await s.controller.spawnClaude(s.id), { claudeId: mine, name: 'Default', why: 'parent' });
    assert.deepEqual(await s.controller.spawnClaude(s.id, 'work'), { claudeId: work.id, name: 'Work', why: 'named' });
    assert.equal((await s.controller.spawnClaude(s.id, 'auto')).why, 'usage_unknown', 'no ranking installed');
    s.controller.claudeRanking = async () => ranking(cand(work.id, 'room'), cand(mine, 'room'));
    assert.deepEqual(await s.controller.spawnClaude(s.id, 'auto'), { claudeId: work.id, name: 'Work', why: 'most_room' });
    s.controller.claudeRanking = async () => {
      throw new Error('usage is down');
    };
    assert.deepEqual(await s.controller.spawnClaude(s.id, 'auto'), { claudeId: mine, name: 'Default', why: 'usage_unknown' });
    await assert.rejects(s.controller.spawnClaude(s.id, 'nobody'), /No Claude “nobody”/);

    const a = await child(s, s.id, 'A');
    const b = await child(s, s.id, 'B');
    assert.deepEqual(s.controller.crew(a.id).map((c) => c.id), [b.id]);
    assert.deepEqual(s.controller.crew(s.id), [], 'a session no session started has no crew');
  } finally {
    await s.done();
  }
});

async function rig() {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const s = await liveSession();
  s.controller.agentCaps = () => ({ ...CAPS, maxChildren: 3, spawnsPerHour: 10 });
  registerChatTools(s.controller, registry);
  h.alive.add(s.id);
  const stranger = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Stranger' });
  await until(() => s.ws.tails.length === 2);
  h.alive.add(stranger.id);
  return { h, s, stranger, done: async () => (h.done(), s.done()) };
}

test('over MCP a session starts a worker in its own workspace, on its own Claude, with a first instruction and optionally a worktree, and sees it and stops it', async () => {
  const r = await rig();
  try {
    const a = await r.h.agentToken('docker/ws1', r.s.id);
    const before = r.s.ws.tails.length;
    const started = await r.h.call(a.secret, 'session_spawn', { prompt: 'Split the router into two files.', title: 'Router split', worktree: true });
    assert.equal(started.result?.isError, undefined, JSON.stringify(started.raw));
    const worker = started.result!.structuredContent.session as { id: string; branch: string };
    await until(() => r.s.ws.tails.length === before + 1);
    const made = r.s.controller.get(worker.id)!;
    assert.deepEqual([made.parentId, made.startedBy, made.claudeId, made.bypassCapable], [r.s.id, `session:${r.s.id}`, r.s.controller.get(r.s.id)!.claudeId, false]);
    assert.match(worker.branch, /^session\/router-split-[0-9a-f]{6}$/);
    assert.equal(made.cwd.endsWith(worker.branch.replace(/\//g, '-')), true, 'it works in its own worktree');
    const opening = r.s.controller.history(worker.id).find((e) => e.kind === 'user')!;
    assert.deepEqual([opening.actor, opening.text], [`session:${r.s.id}`, 'Split the router into two files.']);

    const seen = (await r.h.call(a.secret, 'session_family', {})).result!;
    const family = seen.structuredContent;
    assert.equal(family.workers.length, 1);
    assert.equal(family.workers[0].id, worker.id);
    assert.deepEqual(family.workers[0].title, { untrusted_text: 'Router split', source: 'agent' });
    // T-282: the short form leaves out the folder; full brings it back.
    assert.equal(family.workers[0].folder, undefined);
    assert.ok('folder' in (await r.h.call(a.secret, 'session_family', { full: true })).result!.structuredContent.workers[0]);
    assert.match(seen.content![0]!.text, /^1 worker: 1 (starting|idle|working)/);

    assert.equal((await r.h.call(a.secret, 'session_message', { session_id: worker.id, text: 'Also add a test.' })).result?.isError, undefined);
    assert.equal((await r.h.call(a.secret, 'session_message', { session_id: r.stranger.id, text: 'hi' })).result?.isError, true, 'not its family');
    assert.equal((await r.h.call(a.secret, 'session_message', { session_id: worker.id, text: '/compact' })).result?.isError, true, 'no slash commands');
    assert.equal((await r.h.call(a.secret, 'session_stop_worker', { session_id: r.stranger.id, action: 'end' })).result?.isError, true, 'only its own workers');
    assert.equal((await r.h.call(a.secret, 'session_stop_worker', { session_id: worker.id, action: 'end' })).result?.isError, undefined);
    assert.equal(r.s.controller.get(worker.id)!.state, 'ended');

    // The worker itself (its own token) is at depth 1: it can message its parent but not start workers.
    const wtoken = await r.h.agentToken('docker/ws1', worker.id);
    assert.equal((await r.h.call(wtoken.secret, 'session_spawn', { prompt: 'more' })).result?.structuredContent.error.code, SESSION_CAP);
    // An admin's token is not a session: it has session_start for that.
    const admin = r.h.token('admin');
    assert.equal((await r.h.call(admin.secret, 'session_spawn', { prompt: 'x' })).result?.isError, true);
    assert.equal((await r.h.call(admin.secret, 'session_family', {})).result?.isError, true);
  } finally {
    await r.done();
  }
});

test('T-294 over MCP: a worker on auto runs on the Claude with the most room, works by its role, and its crew sees and messages each other; a refused model is said, not fatal', async () => {
  const r = await rig();
  try {
    r.s.controller.controlTimeoutMs = 150;
    const work = await r.s.controller.createClaude('docker/ws1', 'Work');
    const mine = r.s.controller.get(r.s.id)!.claudeId;
    r.s.controller.claudeRanking = async () => ranking(cand(work.id, 'room'), cand(mine, 'tight'));
    const a = await r.h.agentToken('docker/ws1', r.s.id);
    const before = r.s.ws.tails.length;
    const started = await r.h.call(a.secret, 'session_spawn', { prompt: 'Verify T-7 against its done criteria.', title: 'Verify T-7', claude: 'auto', role: 'qa-verifier' });
    assert.equal(started.result?.isError, undefined, JSON.stringify(started.raw));
    const out = started.result!.structuredContent.session as { id: string; claude: { id: string; name: string; why: string }; role: string; applied: string[]; refused: string[] };
    assert.deepEqual(out.claude, { id: work.id, name: 'Work', why: 'most_room' });
    assert.equal(out.role, 'qa-verifier');
    assert.match(started.result!.content![0]!.text, /^Started worker \S+ on Work, the Claude with the most room\./);
    await until(() => r.s.ws.tails.length === before + 1);
    const worker = r.s.controller.get(out.id)!;
    assert.deepEqual([worker.claudeId, worker.parentId, worker.bypassCapable], [work.id, r.s.id, false]);
    const opening = r.s.controller.history(worker.id).find((e) => e.kind === 'user')!;
    assert.equal(opening.text, 'You work as the qa-verifier role: read .claude/agents/qa-verifier.md in your folder first and follow it.\n\nVerify T-7 against its done criteria.');

    // A second worker on its parent's Claude by name, with a model the process never confirms: started anyway, the refusal said.
    const second = await r.h.call(a.secret, 'session_spawn', { prompt: 'Review the diff of T-7.', title: 'Review T-7', claude: 'same', model: 'sonnet' });
    assert.equal(second.result?.isError, undefined, JSON.stringify(second.raw));
    const s2 = second.result!.structuredContent.session as { id: string; claude: { why: string }; applied: string[]; refused: string[] };
    assert.equal(s2.claude.why, 'parent');
    assert.deepEqual(s2.applied, []);
    assert.match(s2.refused.join(' '), /^model sonnet: /);
    assert.match(second.result!.content![0]!.text, /Not applied: model sonnet: /);
    assert.ok(r.s.controller.history(s2.id).some((e) => e.kind === 'user' && e.text === 'Review the diff of T-7.'), 'its first instruction went in');

    // Unknown Claude: refused before anything starts; a bad role name: refused by the input check.
    const count = r.s.controller.children(r.s.id).length;
    assert.equal((await r.h.call(a.secret, 'session_spawn', { prompt: 'x', claude: 'nobody' })).result?.isError, true);
    assert.equal((await r.h.call(a.secret, 'session_spawn', { prompt: 'x', role: '../etc' })).result?.isError, true);
    assert.equal(r.s.controller.children(r.s.id).length, count, 'nothing started');

    // The crew: each worker sees the other with its Claude, and messages it.
    const w1 = await r.h.agentToken('docker/ws1', out.id);
    const fam = (await r.h.call(w1.secret, 'session_family', {})).result!;
    assert.deepEqual(fam.structuredContent.crew.map((c: { id: string; claude: string }) => [c.id, c.claude]), [[s2.id, 'Default']]);
    assert.match(fam.content![0]!.text, /Crew: 1 \(/);
    assert.equal((await r.h.call(w1.secret, 'session_message', { session_id: s2.id, text: 'I found a gap in criterion 2.' })).result?.isError, undefined);
    assert.ok(r.s.controller.history(s2.id).some((e) => e.kind === 'user' && e.actor === `session:${out.id}` && e.text === 'I found a gap in criterion 2.'));
    assert.equal((await r.h.call(w1.secret, 'session_message', { session_id: r.stranger.id, text: 'hi' })).result?.isError, true, 'a stranger is not crew');
    // The parent sees its workers with their Claudes.
    const parentView = (await r.h.call(a.secret, 'session_family', {})).result!.structuredContent;
    assert.deepEqual(new Set(parentView.workers.map((w: { claude: string }) => w.claude)), new Set(['Work', 'Default']));
  } finally {
    await r.done();
  }
});
