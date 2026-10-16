// T-255: unknown usage never wins. On 2026-10-13 a chat was moved to a Claude whose usage read 0 % with no reset time (the probe could not
// tell) and that was already at its limit; the chat answered "You've hit your session limit" and stayed stuck. Here: a destination whose
// usage is unknown (no reading, no reset time, stale) ranks below every measured one and is chosen only when no measured one qualifies;
// the decision row and the log say "unknown usage"; after such a move a limit answer (the report the usage module keeps) moves the chat on
// at once, pause or not. Fake clock and fixtures only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_SETTING_KEYS as K, measuredFigure, usageUnavailable, type ClaudeUsage, type ClaudeUsageWindow, type ChatSwitchOptions } from '@portal/contracts';
import { fakeOwner, freshStore } from '../notify/testkit.js';
import { recommendMove } from '../claudeusage/recommend.js';
import { decide, unknownUsage, type DecideInput } from './decide.js';
import { AutoTransferEngine, decisionLine } from './engine.js';
import { AutoStore } from './store.js';
import { platformSettings } from './settings.js';
import { MoveChat, T0, at, chatSession, fakeClock, fakeUsage, settingsMap, usage, win } from './testkit.js';

/** What the probe gave for one.claude on 2026-10-13: the session window at 0 % with no reset time. */
const blind = (key = 'session'): ClaudeUsageWindow => ({ key, label: key === 'session' ? 'Session' : 'Week', usedPct: 0, resetsAt: null, level: 'ok' });

const names: Record<string, string> = { work: 'Work', home: 'Home', spare: 'Spare', one: 'One' };

function options(ids: string[]): ChatSwitchOptions {
  return {
    sessionId: 's1',
    via: 'own',
    options: ids.map((id) => ({ claude: { id, name: names[id] ?? id, workspaceId: 'docker/api-dev' } as never, ok: true, reason: null, fix: null })),
    folder: '/home/coder/project',
    worktree: null,
    handoff: { ok: true, reason: null },
    working: false,
    dropped: { approvals: 0, queued: 0, agents: 0 },
  };
}

function input(claudes: ClaudeUsage[], over: Partial<DecideInput> = {}): DecideInput {
  return {
    nowMs: T0,
    mode: 'auto',
    settings: { ...platformSettings(null), mode: 'auto' },
    claudeThresholdPct: null,
    destinations: [],
    session: { id: 's1', workspaceId: 'docker/api-dev', claudeId: 'work', model: 'claude-sonnet-4-5', state: 'idle', mode: 'default', switching: null },
    pooled: false,
    claudes,
    ownerOk: true,
    allow: () => true,
    options: options(claudes.map((c) => c.claudeId).filter((id) => id !== 'work')),
    load: () => 0,
    counters: { pausedUntilMs: null, lastMoveMs: null, movesSession24h: 0, movesOwner24h: 0, failures24h: 0, deferSinceMs: null, left: [] },
    recommend: recommendMove,
    ...over,
  };
}

const WORK_OUT = () => usage('work', 'Work', [win('session', 100), win('week', 40)]);
const ONE_BLIND = () => usage('one', 'One', [blind(), blind('week')]);

test('unknown usage: a Claude reading 0 % with no reset time is UNKNOWN (no_reset_time), never "100 % left"', () => {
  assert.equal(unknownUsage(ONE_BLIND(), 'sonnet', T0), 'no_reset_time');
  assert.equal(unknownUsage(usage('x', 'X', [win('session', 0)]), 'sonnet', T0), null, 'a measured 0 % with a reset time is measured');
  assert.equal(unknownUsage(usage('x', 'X', [win('session', 10)], { checkedAt: null }), 'sonnet', T0), 'no_reading');
  assert.equal(unknownUsage(usage('x', 'X', [win('session', 10)], { checkedAt: at(-40) }), 'sonnet', T0), 'stale', 'read 40 minutes ago');
  assert.equal(unknownUsage(usage('x', 'X', [], { runsOn: 'none' }), 'sonnet', T0), 'signed_out');
  assert.equal(unknownUsage(usage('x', 'X', [], { problem: 'unavailable' }), 'sonnet', T0), 'no_usage_endpoint');
  assert.equal(unknownUsage(undefined, 'sonnet', T0), 'no_reading');
});

test('unknown usage is never preferred: Work used up, One unknown (0 %, no reset), Home measured at 70 % used: moves to Home', () => {
  const d = decide(input([WORK_OUT(), ONE_BLIND(), usage('home', 'Home', [win('session', 70), win('week', 50)])]));
  assert.equal(d.act, 'move');
  if (d.act !== 'move') return;
  assert.deepEqual(d.to, { id: 'home', name: 'Home' });
  assert.deepEqual(d.facts.destLeftPct, measuredFigure(30));
  assert.deepEqual(d.alternatives.map((a) => a.id), ['one'], 'the unknown one is only listed after it');
});

test('unknown usage is never preferred, even first on the allowlist, even with a stale reading that says 0 %', () => {
  const claudes = [WORK_OUT(), ONE_BLIND(), usage('spare', 'Spare', [win('session', 0), win('week', 0)], { checkedAt: at(-60) }), usage('home', 'Home', [win('session', 80), win('week', 10)])];
  const d = decide(input(claudes, { destinations: ['one', 'spare', 'home'] }));
  assert.equal(d.act, 'move');
  if (d.act !== 'move') return;
  assert.equal(d.to.id, 'home');
  assert.deepEqual(d.alternatives.map((a) => a.id), ['one', 'spare'], 'unknowns after every measured one, in the allowlist order');
});

test('only unknown candidates: the chat moves (it would stay stuck otherwise); the row and the log say "unknown usage"', () => {
  const d = decide(input([WORK_OUT(), ONE_BLIND()]));
  assert.equal(d.act, 'move');
  if (d.act !== 'move') return;
  assert.deepEqual(d.to, { id: 'one', name: 'One' });
  assert.deepEqual(d.facts.destLeftPct, { value: null, basis: 'unavailable', reason: 'no_reset_time' });
  const line = decisionLine({ kind: 'moved', sessionId: 's1-abcdef', reason: d.reason, from: { id: 'work', name: 'Work' }, to: d.to, facts: d.facts, code: null });
  assert.match(line, / to=One reason=exhausted code=- dest=unknown usage \(no_reset_time\)$/);
});

test('a chat that is only low (8 % left) does not gamble on an unknown Claude: it waits for a measured one (no_destination)', () => {
  const d = decide(input([usage('work', 'Work', [win('session', 92), win('week', 40)]), ONE_BLIND()]));
  assert.deepEqual([d.act, d.act === 'warn' && d.code], ['warn', 'no_destination']);
});

test('a Claude never read at all is a last resort too, after a measured one; a measured tight one is not taken in auto, so the unknown is', () => {
  const never = usage('one', 'One', [], { checkedAt: null, runsOn: 'unknown' });
  const tight = usage('home', 'Home', [win('session', 85), win('week', 10)]);
  const d = decide(input([WORK_OUT(), never, tight]));
  assert.equal(d.act, 'move');
  if (d.act !== 'move') return;
  assert.equal(d.to.id, 'one');
  assert.deepEqual(d.facts.destLeftPct, { value: null, basis: 'unavailable', reason: 'no_reading' });
});

/* ---------- the engine: watched after a move to an unknown Claude ---------- */

test('watched: moved to an unknown Claude, the first turn answers with the limit message: moves on at once to a measured Claude, no pause', async () => {
  const { store } = await freshStore();
  const clock = fakeClock();
  const chat = new MoveChat();
  chat.names.set('one', 'One');
  chat.names.delete('home');
  chat.sessions.set('s1', chatSession('s1'));
  const read = () => new Date(clock.now() - 60_000).toISOString();
  // Spare is out too at first; One reads 0 % with no reset time.
  let spareUsed = 100;
  let oneReport = false;
  const claudes = (): ClaudeUsage[] => [
    { ...usage('work', 'Work', [win('session', 100)]), checkedAt: read() },
    { ...usage('spare', 'Spare', [win('session', spareUsed)]), checkedAt: read() },
    // After the limit answer the usage module lays the report over the probe's reading: the session used up until the stated reset.
    oneReport
      ? { ...usage('one', 'One', [{ ...win('session', 100), resetsAt: at(300) }]), checkedAt: read(), state: 'exhausted', limitReport: { window: 'session', label: 'Session', at: read(), until: at(300), guessed: false, sessionId: 's1' } }
      : { ...usage('one', 'One', [blind()]), checkedAt: read() },
  ];
  const u = fakeUsage(claudes);
  const auto = new AutoStore(store, () => new Date(clock.now()));
  const engine = new AutoTransferEngine({ chat, usage: u, owner: fakeOwner({}, { fallback: 'u_a' }), clock, store: auto, settings: settingsMap({ [K.enabled]: true, [K.automatic]: true }), bus: null, audit: null, publish: () => {} });
  engine.start();
  chat.turnEnds('s1');
  await engine.settled();
  assert.deepEqual(chat.moves, [{ id: 's1', to: 'one', handoff: 'skip' }], 'only One could take it: moved there, unknown');
  const first = auto.events('u_a', { session: 's1', limit: 20 }).find((e) => e.kind === 'moved')!;
  assert.deepEqual(first.facts?.destLeftPct, { value: null, basis: 'unavailable', reason: 'no_reset_time' });

  // Spare frees up; the first turn on One answers with the limit message (the report), one minute after the move: inside the pause.
  spareUsed = 20;
  oneReport = true;
  clock.advance(1);
  chat.turnEnds('s1');
  await engine.settled();
  assert.deepEqual(chat.moves.map((m) => m.to), ['one', 'spare'], 'moved on at once, pause or not, to the measured Claude');
  assert.equal(chat.get('s1')!.claudeId, 'spare');
  engine.stop();
});

test('T-251 S2: a limit answer in the MIDDLE of a turn (no turn boundary): the reading event triggers a tick, the chat is steered once and not moved mid-turn; at the boundary it moves at once, skip, no pause', async () => {
  const { store } = await freshStore();
  const clock = fakeClock();
  const chat = new MoveChat();
  chat.names.set('one', 'One');
  // The chat works on One (it was moved there while One's usage was unknown); Spare is measured with room.
  chat.sessions.set('s1', chatSession('s1', { state: 'working', claudeId: 'one', claudeName: 'One' }));
  const read = () => new Date(clock.now() - 60_000).toISOString();
  let oneReport = false;
  const claudes = (): ClaudeUsage[] => [
    { ...usage('spare', 'Spare', [win('session', 20)]), checkedAt: read() },
    oneReport
      ? { ...usage('one', 'One', [{ ...win('session', 100), resetsAt: at(300) }]), checkedAt: read(), state: 'exhausted', limitReport: { window: 'session', label: 'Session', at: read(), until: at(300), guessed: false, sessionId: 's1' } }
      : { ...usage('one', 'One', [blind()]), checkedAt: read() },
  ];
  const u = fakeUsage(claudes);
  const auto = new AutoStore(store, () => new Date(clock.now()));
  const engine = new AutoTransferEngine({ chat, usage: u, owner: fakeOwner({}, { fallback: 'u_a' }), clock, store: auto, settings: settingsMap({ [K.enabled]: true, [K.automatic]: true }), bus: null, audit: null, publish: () => {} });
  engine.start();

  // Before the report: One reads 0 % with no reset time (unknown): no reason to move, nothing happens.
  clock.advance(1);
  await new Promise((r) => setImmediate(r));
  await engine.settled();
  assert.equal(chat.moves.length, 0);
  assert.equal(chat.sent.length, 0);

  // The limit answer arrives mid-turn: the usage module has a new reading (`onReading`), no turn ended.
  oneReport = true;
  u.reading();
  clock.advance(1); // the debounce (5 s) passes: the tick runs
  await new Promise((r) => setImmediate(r));
  await engine.settled();
  assert.equal(chat.get('s1')!.state, 'working', 'still mid-turn');
  assert.equal(chat.moves.length, 0, 'never moved mid-turn (FR10a)');
  assert.equal(chat.sent.length, 1, 'told once to finish the step and stop');
  assert.equal(chat.sent[0]!.actor, 'portal:autotransfer');
  assert.equal((await engine.state('s1', 'u_a')).pendingMove?.to.id, 'spare', 'the move to the measured Claude is announced');

  // The boundary: moved at once (the source is used up), handoff skipped, then the continuation.
  chat.turnEnds('s1');
  await engine.settled();
  assert.deepEqual(chat.moves, [{ id: 's1', to: 'spare', handoff: 'skip' }]);
  assert.equal(chat.get('s1')!.claudeId, 'spare');
  assert.equal(chat.sent.length, 2);
  engine.stop();
});

test('T-251 S2: usageUnavailable trusts a standing limit report on its own (no reading or windows yet), and not an expired one', () => {
  const report = (untilMin: number) => ({ window: 'session', label: 'Session', at: at(-1), until: at(untilMin), guessed: false, sessionId: 's1' });
  const never = (limitReport: ClaudeUsage['limitReport']) => ({ runsOn: 'plan' as const, windows: [], checkedAt: null, problem: null, limitReport });
  assert.equal(usageUnavailable(never(null), T0), 'no_reading');
  assert.equal(usageUnavailable(never(report(300)), T0), null, 'a limit reported until later is measured: the Claude is used up');
  assert.equal(usageUnavailable(never(report(-1)), T0), 'no_reading', 'a report whose reset passed says nothing');
});
