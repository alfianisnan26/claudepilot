// The decision of docs/prd/auto-transfer.md §9 over fixtures: scenarios S1 to S16, S18 and S19 of §14 (S17 and S20 need the engine and
// the routes: engine.test.ts, routes.test.ts). Every expected value is worked out by hand and written here: 92 % used is 8 % left, and so on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_BOUNDS,
  estimatedFigure,
  measuredFigure,
  parseModelFallback,
  unavailableFigure,
  type AutoTransferSettings,
  type ChatSwitchOptions,
  type ClaudeUsage,
  type ClaudeUsageWindow,
  type WindowPace,
} from '@portal/contracts';
import { recommendMove } from '../claudeusage/recommend.js';
import { decide, effectiveMode, leftFor, modelFamily, sourceReading, type DecideInput } from './decide.js';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const min = (n: number) => new Date(NOW + n * 60_000).toISOString();
const RESET = min(180); // the session window resets in 3 hours

function win(key: string, usedPct: number, over: Partial<ClaudeUsageWindow> = {}): ClaudeUsageWindow {
  const label = key === 'session' ? 'Session' : key === 'week' ? 'Week' : key === 'week_opus' ? 'Opus' : key === 'week_sonnet' ? 'Sonnet' : key;
  return { key, label, usedPct, resetsAt: RESET, level: usedPct >= 100 ? 'exhausted' : usedPct >= 90 ? 'high' : usedPct >= 75 ? 'near' : 'ok', ...over };
}

function pace(over: Partial<WindowPace> = {}): WindowPace {
  return {
    speed: estimatedFigure(0.17),
    projectedPct: estimatedFigure(130),
    etaAt: estimatedFigure(min(90)),
    status: estimatedFigure('over'),
    evenPct: unavailableFigure('window_length_unknown'),
    aheadPts: unavailableFigure('window_length_unknown'),
    readings: 6,
    spanMin: 60,
    method: 'least_squares',
    lowConfidence: false,
    ...over,
  };
}

function claude(id: string, name: string, windows: ClaudeUsageWindow[], over: Partial<ClaudeUsage> = {}): ClaudeUsage {
  return {
    claudeId: id,
    claudeName: name,
    workspaceId: 'docker/api-dev',
    workspaceName: 'api-dev',
    runsOn: 'plan',
    state: 'ok',
    plan: 'max',
    windows,
    extra: null,
    checkedAt: min(-5),
    source: null,
    stale: false,
    workspaceRunning: true,
    problem: null,
    snoozedUntil: null,
    projectionSnoozedUntil: null,
    slot: null,
    outlook: { status: unavailableFigure('no_reading'), window: null, etaAt: unavailableFigure('no_reading'), projectedPct: unavailableFigure('no_reading') },
    trend: null,
    ...over,
  };
}

const SETTINGS: AutoTransferSettings = {
  mode: 'auto',
  thresholdPct: AUTO_BOUNDS.thresholdPct.default, // 10
  useProjection: true,
  minPauseMin: 30,
  maxPerSessionPerDay: 2,
  maxPerDay: 6,
  maxPerDestination: 2,
  sameModelOnly: false,
  allowApiKey: false,
  allowBypass: false,
  modelFallback: [],
  keepModelFirst: true,
  dryRun: false,
};

function options(claudes: ClaudeUsage[], over: Partial<ChatSwitchOptions> = {}): ChatSwitchOptions {
  return {
    sessionId: 's1',
    via: 'own',
    options: claudes
      .filter((c) => c.claudeId !== 'work')
      .map((c) => ({ claude: { id: c.claudeId, workspaceId: c.workspaceId, name: c.claudeName } as never, ok: true, reason: null, fix: null })),
    folder: '/home/coder/project',
    worktree: null,
    handoff: { ok: true, reason: null },
    working: false,
    dropped: { approvals: 0, queued: 0, agents: 0 },
    ...over,
  };
}

const WORK_92 = () => claude('work', 'Work', [win('session', 92), win('week', 30)]);
const HOME_60 = () => claude('home', 'Home', [win('session', 60), win('week', 20)]);

function input(claudes: ClaudeUsage[], over: Partial<DecideInput> = {}): DecideInput {
  return {
    nowMs: NOW,
    mode: 'auto',
    settings: SETTINGS,
    claudeThresholdPct: null,
    destinations: [],
    session: { id: 's1', workspaceId: 'docker/api-dev', claudeId: 'work', model: 'claude-sonnet-4-5', state: 'idle', mode: 'default', switching: null },
    pooled: false,
    claudes,
    ownerOk: true,
    allow: () => true,
    options: options(claudes),
    load: () => 0,
    counters: { pausedUntilMs: null, lastMoveMs: null, movesSession24h: 0, movesOwner24h: 0, failures24h: 0, deferSinceMs: null, left: [] },
    recommend: recommendMove,
    ...over,
  };
}

test('S1: auto, Work 92 % used (8 % left) under 10, Home 60 % used (40 % left): moves to Home with a handoff', () => {
  const d = decide(input([WORK_92(), HOME_60()]));
  assert.equal(d.act, 'move');
  if (d.act !== 'move') return;
  assert.equal(d.reason, 'low');
  assert.deepEqual(d.to, { id: 'home', name: 'Home' });
  assert.equal(d.handoff, 'ask');
  assert.deepEqual(d.facts.leftPct, { value: 8, basis: 'measured' });
  assert.deepEqual(d.facts.destLeftPct, { value: 40, basis: 'measured' });
  assert.equal(d.facts.thresholdPct, 10);
  assert.deepEqual(d.facts.resetsAt, { value: RESET, basis: 'measured' });
});

test('S2: the same in ask: a suggestion, no move', () => {
  const d = decide(input([WORK_92(), HOME_60()], { mode: 'ask' }));
  assert.equal(d.act, 'suggest');
  if (d.act === 'suggest') {
    assert.equal(d.why, null);
    assert.equal(d.to.id, 'home');
  }
});

test('S3: Work 85 % used (15 % left) is above a threshold of 10: nothing', () => {
  const d = decide(input([claude('work', 'Work', [win('session', 85)]), HOME_60()]));
  assert.deepEqual([d.act, d.act === 'none' && d.code], ['none', 'above_threshold']);
});

test('S4: Work at 100 %: exhausted, the stored conversation carries (handoff skip)', () => {
  const d = decide(input([claude('work', 'Work', [win('session', 100)]), HOME_60()]));
  assert.equal(d.act, 'move');
  if (d.act !== 'move') return;
  assert.equal(d.reason, 'exhausted');
  assert.equal(d.handoff, 'skip');
  assert.equal(d.facts.leftPct.value, 0);
});

test('a source that cannot be asked for a handoff moves with skip', () => {
  const cs = [WORK_92(), HOME_60()];
  const d = decide(input(cs, { options: options(cs, { handoff: { ok: false, reason: 'An approval is waiting.' } }) }));
  assert.equal(d.act === 'move' && d.handoff, 'skip');
});

test('S5: 85 % used, pace over (130 % at reset), confident, run-out in 90 minutes: projection, moves (15 <= 30, 90 <= 120)', () => {
  const d = decide(input([claude('work', 'Work', [win('session', 85, { pace: pace() })]), HOME_60()]));
  assert.equal(d.act, 'move');
  if (d.act !== 'move') return;
  assert.equal(d.reason, 'projection');
  assert.deepEqual(d.facts.leftPct, { value: 15, basis: 'measured' });
  assert.deepEqual(d.facts.projectedPct, { value: 130, basis: 'estimate' });
  assert.deepEqual(d.facts.etaAt, { value: min(90), basis: 'estimate' });
  assert.equal(d.handoff, 'ask');
});

test('S6: the same with the run-out in 4 hours: nothing', () => {
  const d = decide(input([claude('work', 'Work', [win('session', 85, { pace: pace({ etaAt: estimatedFigure(min(240)) }) })]), HOME_60()]));
  assert.deepEqual([d.act, d.act === 'none' && d.code], ['none', 'above_threshold']);
});

test('S7: the same with low confidence: nothing', () => {
  const d = decide(input([claude('work', 'Work', [win('session', 85, { pace: pace({ lowConfidence: true }) })]), HOME_60()]));
  assert.deepEqual([d.act, d.act === 'none' && d.code], ['none', 'above_threshold']);
});

test('projection off, or 35 % left (above the 30 % bound): nothing', () => {
  const p = [claude('work', 'Work', [win('session', 85, { pace: pace() })]), HOME_60()];
  assert.equal(decide(input(p, { settings: { ...SETTINGS, useProjection: false } })).act, 'none');
  const d = decide(input([claude('work', 'Work', [win('session', 65, { pace: pace() })]), HOME_60()]));
  assert.deepEqual([d.act, d.act === 'none' && d.code], ['none', 'above_threshold']);
});

test('S8: a pooled workspace is inert', () => {
  const d = decide(input([WORK_92(), HOME_60()], { pooled: true }));
  assert.deepEqual([d.act, d.act === 'none' && d.code], ['none', 'pooled']);
});

test('a source on an API key, or with no reading: no_plan_reading; an old source reading: stale_reading', () => {
  assert.equal((decide(input([claude('work', 'Work', [], { runsOn: 'key' }), HOME_60()])) as { code: string }).code, 'no_plan_reading');
  assert.equal((decide(input([claude('work', 'Work', [], { checkedAt: null }), HOME_60()])) as { code: string }).code, 'no_plan_reading');
  // Read 16 minutes ago: older than 15.
  assert.equal((decide(input([claude('work', 'Work', [win('session', 92)], { checkedAt: min(-16) }), HOME_60()])) as { code: string }).code, 'stale_reading');
  assert.equal((decide(input([claude('work', 'Work', [win('session', 92)], { stale: true }), HOME_60()])) as { code: string }).code, 'stale_reading');
});

test('S9: Home read 20 minutes ago is excluded; with no other candidate: a no_destination warning', () => {
  const d = decide(input([WORK_92(), claude('home', 'Home', [win('session', 60)], { checkedAt: min(-20) })]));
  assert.deepEqual([d.act, d.act === 'warn' && d.code], ['warn', 'no_destination']);
  if (d.act === 'warn') assert.equal(d.period, `work|session|${RESET}`);
});

test('S10: Home already carries 2 sessions (max 2): Spare (30 % left... 70 % used) is chosen; both full: destination_busy', () => {
  const spare = claude('spare', 'Spare', [win('session', 70)]);
  const d = decide(input([WORK_92(), HOME_60(), spare], { load: (id) => (id === 'home' ? 2 : 0) }));
  assert.equal(d.act === 'move' && d.to.id, 'spare');
  const full = decide(input([WORK_92(), HOME_60(), spare], { load: () => 2 }));
  assert.deepEqual([full.act, full.act === 'warn' && full.code], ['warn', 'destination_busy']);
  // One under the cap is fine.
  assert.equal(decide(input([WORK_92(), HOME_60()], { load: () => 1 })).act, 'move');
});

test('S11: a move 10 minutes ago, pause 30: paused (the minimum pause), nothing moves; 31 minutes ago: moves', () => {
  const c = input([WORK_92(), HOME_60()]).counters;
  const d = decide(input([WORK_92(), HOME_60()], { counters: { ...c, lastMoveMs: NOW - 10 * 60_000 } }));
  assert.deepEqual([d.act, d.act === 'none' && d.code], ['none', 'paused']);
  assert.equal(decide(input([WORK_92(), HOME_60()], { counters: { ...c, lastMoveMs: NOW - 31 * 60_000 } })).act, 'move');
  // "Later" or an Undo: paused until a time.
  const later = decide(input([WORK_92(), HOME_60()], { counters: { ...c, pausedUntilMs: NOW + 60_000 } }));
  assert.equal(later.act === 'none' && later.code, 'paused');
});

test('S12: two moves for the chat in 24 hours: session_cap; six for the owner: day_cap', () => {
  const c = input([WORK_92(), HOME_60()]).counters;
  const d = decide(input([WORK_92(), HOME_60()], { counters: { ...c, movesSession24h: 2 } }));
  assert.equal(d.act === 'none' && d.code, 'session_cap');
  const day = decide(input([WORK_92(), HOME_60()], { counters: { ...c, movesSession24h: 1, movesOwner24h: 6 } }));
  assert.equal(day.act === 'none' && day.code, 'day_cap');
});

test('S13: a chat in Bypass, mode auto: only a card, never a move', () => {
  const base = input([WORK_92(), HOME_60()]);
  const d = decide({ ...base, session: { ...base.session, mode: 'bypassPermissions' } });
  assert.equal(d.act, 'suggest');
  assert.equal(d.act === 'suggest' && d.why, 'bypass');
});

test('S13b: with automove.allowBypass the chat in Bypass is moved like any other (the move itself keeps Bypass)', () => {
  const base = input([WORK_92(), HOME_60()], { settings: { ...SETTINGS, allowBypass: true } });
  const d = decide({ ...base, session: { ...base.session, mode: 'bypassPermissions' } });
  assert.equal(d.act, 'move');
  assert.equal(d.act === 'move' && d.to.id, 'home');
  // The setting is the platform's only: a user's prefs cannot turn it on (effectiveSettings copies the platform's value).
});

test('S14: an approval is open: busy (waits); after 30 minutes of waiting: a card that says it drops 1 approval', () => {
  const cs = [WORK_92(), HOME_60()];
  const dropped = { approvals: 1, queued: 0, agents: 0 };
  const base = input(cs, { options: options(cs, { dropped, handoff: { ok: false, reason: 'An approval is waiting.' } }) });
  const wait = decide({ ...base, counters: { ...base.counters, deferSinceMs: NOW - 10 * 60_000 } });
  assert.deepEqual([wait.act, wait.act === 'wait' && wait.code], ['wait', 'busy']);
  const card = decide({ ...base, counters: { ...base.counters, deferSinceMs: NOW - 30 * 60_000 } });
  assert.equal(card.act, 'suggest');
  if (card.act === 'suggest') {
    assert.equal(card.why, 'deferred');
    assert.deepEqual(card.dropped, dropped);
  }
  // A running turn (not at the boundary) waits too.
  const working = decide({ ...input(cs), session: { ...input(cs).session, state: 'working' } });
  assert.equal(working.act, 'wait');
});

test('S15: a chat on Opus with session 40 %, week 40 %, Opus week 95 % used: low (5 % left); the same on Sonnet: nothing', () => {
  const work = claude('work', 'Work', [win('session', 40), win('week', 40), win('week_opus', 95)]);
  const base = input([work, HOME_60()]);
  const opus = decide({ ...base, session: { ...base.session, model: 'claude-opus-4-1' } });
  assert.equal(opus.act, 'move');
  if (opus.act === 'move') {
    assert.equal(opus.reason, 'low');
    assert.equal(opus.facts.leftPct.value, 5);
  }
  const sonnet = decide({ ...base, session: { ...base.session, model: 'claude-sonnet-4-5' } });
  assert.equal(sonnet.act === 'none' && sonnet.code, 'above_threshold');
  assert.equal(sourceReading(work, 'claude-sonnet-4-5', 10, true, NOW)?.leftPct, 60);
});

test('S16: same model only; Home has its Opus week used up; the chat is on Opus: Home excluded', () => {
  const home = claude('home', 'Home', [win('session', 10), win('week_opus', 100)]);
  const spare = claude('spare', 'Spare', [win('session', 70)]);
  const base = input([WORK_92(), home, spare], { settings: { ...SETTINGS, sameModelOnly: true } });
  const opus = { ...base.session, model: 'claude-opus-4-1' };
  const d = decide({ ...base, session: opus });
  assert.equal(d.act === 'move' && d.to.id, 'spare');
  // Without Spare: nothing qualifies.
  const none = decide({ ...input([WORK_92(), home], { settings: { ...SETTINGS, sameModelOnly: true } }), session: opus });
  assert.equal(none.act === 'warn' && none.code, 'no_destination');
  // Since T-29 a destination is judged on what it has left for the chat's model: Home's Opus week at 100 % leaves nothing for an Opus
  // chat, so it is not listed even when same-model is off (it used to be offered as an alternative: a move that stops again at once).
  const off = decide({ ...input([WORK_92(), home, spare], { mode: 'ask' }), session: opus });
  assert.equal(off.act === 'suggest' && off.to.id, 'spare');
  assert.deepEqual(off.act === 'suggest' && off.alternatives, []);
  const on = decide({ ...input([WORK_92(), home, spare], { mode: 'ask', settings: { ...SETTINGS, sameModelOnly: true } }), session: opus });
  assert.deepEqual(on.act === 'suggest' && on.alternatives, []);
  // An unknown model with same-model-only: no destination can be vouched for.
  const unknown = decide({ ...input([WORK_92(), spare], { settings: { ...SETTINGS, sameModelOnly: true } }), session: { ...base.session, model: null } });
  assert.equal(unknown.act, 'warn');
});

test('S18: the only candidate is on a Console key: excluded unless allowApiKey; with it chosen, and after a room Claude', () => {
  const key = claude('key', 'Console', [], { runsOn: 'key', checkedAt: null });
  assert.equal(decide(input([WORK_92(), key])).act, 'warn');
  const allowed = decide(input([WORK_92(), key], { settings: { ...SETTINGS, allowApiKey: true } }));
  assert.equal(allowed.act === 'move' && allowed.to.id, 'key');
  if (allowed.act === 'move') assert.equal(allowed.facts.destLeftPct, undefined);
  const both = decide(input([WORK_92(), key, HOME_60()], { settings: { ...SETTINGS, allowApiKey: true } }));
  assert.equal(both.act === 'move' && both.to.id, 'home');
  if (both.act === 'move') assert.deepEqual(both.alternatives, [{ id: 'key', name: 'Console' }]);
});

test('S19: the owner may not use Home: Home excluded (no_destination); an owner who may not operate the chat: owner_denied', () => {
  const d = decide(input([WORK_92(), HOME_60()], { allow: (id) => id !== 'home' }));
  assert.equal(d.act === 'warn' && d.code, 'no_destination');
  const denied = decide(input([WORK_92(), HOME_60()], { ownerOk: false }));
  assert.equal(denied.act === 'none' && denied.code, 'owner_denied');
});

test('the destination list is an allowlist, in its own order', () => {
  const spare = claude('spare', 'Spare', [win('session', 70)]); // 30 % left: worse than Home's 40
  const d = decide(input([WORK_92(), HOME_60(), spare], { destinations: ['spare', 'home'] }));
  assert.equal(d.act === 'move' && d.to.id, 'spare');
  const only = decide(input([WORK_92(), HOME_60()], { destinations: ['spare'] }));
  assert.equal(only.act, 'warn');
});

test('a Claude threshold of 15 moves a chat with 12 % left (88 % used); the global 10 does not', () => {
  const work = claude('work', 'Work', [win('session', 88)]);
  assert.equal(decide(input([work, HOME_60()])).act, 'none');
  const d = decide(input([work, HOME_60()], { claudeThresholdPct: 15 }));
  assert.equal(d.act === 'move' && d.facts.thresholdPct, 15);
});

test('ask offers over-pace and lists tight Claudes as alternatives; auto takes only room', () => {
  const over = claude('home', 'Home', [win('session', 50)], { outlook: { status: estimatedFigure('over'), window: null, etaAt: estimatedFigure(min(60)), projectedPct: estimatedFigure(140) } });
  const tight = claude('tight', 'Tight', [win('session', 85)]); // 15 % left: under 20, tight
  const ask = decide(input([WORK_92(), over, tight], { mode: 'ask' }));
  assert.equal(ask.act, 'suggest');
  if (ask.act === 'suggest') {
    assert.equal(ask.to.id, 'home');
    assert.deepEqual(ask.alternatives, [{ id: 'tight', name: 'Tight' }]);
  }
  assert.equal(decide(input([WORK_92(), over, tight])).act, 'warn');
});

test('ping-pong: a Claude the chat left 60 minutes ago is skipped unless its window has reset since', () => {
  const c = input([WORK_92(), HOME_60()]).counters;
  const d = decide(input([WORK_92(), HOME_60()], { counters: { ...c, left: [{ claudeId: 'home', atMs: NOW - 60 * 60_000, resetsAtMs: NOW + 60_000 }] } }));
  assert.equal(d.act, 'warn');
  const reset = decide(input([WORK_92(), HOME_60()], { counters: { ...c, left: [{ claudeId: 'home', atMs: NOW - 60 * 60_000, resetsAtMs: NOW - 60_000 }] } }));
  assert.equal(reset.act, 'move');
  const old = decide(input([WORK_92(), HOME_60()], { counters: { ...c, left: [{ claudeId: 'home', atMs: NOW - 241 * 60_000, resetsAtMs: null }] } }));
  assert.equal(old.act, 'move');
});

test('two failed moves today: an auto chat gets only a card', () => {
  const c = input([WORK_92(), HOME_60()]).counters;
  const d = decide(input([WORK_92(), HOME_60()], { counters: { ...c, failures24h: 2 } }));
  assert.equal(d.act === 'suggest' && d.why, 'failed_today');
});

test('a Claude the Move flow refuses (signed out) is not a candidate', () => {
  const cs = [WORK_92(), HOME_60()];
  const o = options(cs);
  o.options = o.options.map((x) => ({ ...x, ok: false, reason: 'Sign in first.', fix: 'sign_in' }));
  assert.equal(decide(input(cs, { options: o })).act, 'warn');
  assert.equal(decide(input(cs, { options: null })).act, 'warn');
});

test('the effective mode: override, then user, then platform, never above the ceiling', () => {
  assert.equal(effectiveMode('off', 'auto', 'auto'), 'off');
  assert.equal(effectiveMode('ask', null, null), 'ask');
  assert.equal(effectiveMode('ask', 'auto', null), 'ask');
  assert.equal(effectiveMode('ask', null, 'auto'), 'ask');
  assert.equal(effectiveMode('auto', 'ask', null), 'ask');
  assert.equal(effectiveMode('auto', 'ask', 'auto'), 'auto');
  assert.equal(effectiveMode('auto', null, 'off'), 'off');
  assert.equal(effectiveMode('auto', null, null), 'auto');
  assert.equal(effectiveMode('off', null, null), 'off');
  assert.equal(decide(input([WORK_92(), HOME_60()], { mode: 'off' })).act, 'none');
});

test('model families', () => {
  assert.equal(modelFamily('claude-opus-4-1'), 'opus');
  assert.equal(modelFamily('sonnet[1m]'), 'sonnet');
  assert.equal(modelFamily(null), null);
  void measuredFigure;
});

// T-29 (owner, 2026-10-13): several limits per Claude, shared and per model; a model change on the same Claude is one of the options.
const OPUS = { session: { id: 's1', workspaceId: 'docker/api-dev', claudeId: 'work', model: 'claude-opus-4-1', state: 'idle' as const, mode: 'default' as const, switching: null } };
// Work: the Opus week is at 95 % (5 % left), the shared windows have room. Home: room on everything. Spare: plenty of shared room, Opus used up.
const WORK_OPUS_LOW = () => claude('work', 'Work', [win('session', 40), win('week', 50), win('week_opus', 95)]);
const HOME_ROOM = () => claude('home', 'Home', [win('session', 30), win('week', 40), win('week_opus', 20)]);
const SPARE_OPUS_OUT = () => claude('spare', 'Spare', [win('session', 5), win('week', 10), win('week_opus', 100)]);

test('T-29: which limit binds is said: the model-only Opus week, with the shared windows still roomy', () => {
  const r = sourceReading(WORK_OPUS_LOW(), 'claude-opus-4-1', 10, true, NOW)!;
  assert.deepEqual(r.limit, { key: 'week_opus', label: 'Opus', kind: 'model' });
  assert.equal(r.leftPct, 5);
  assert.equal(r.sharedLeftPct, 50);
  assert.equal(r.reason, 'low');
  assert.equal(leftFor(SPARE_OPUS_OUT(), 'opus', NOW), 0, 'no room left for an Opus chat, whatever the shared windows say');
  assert.equal(leftFor(SPARE_OPUS_OUT(), 'sonnet', NOW), 90);
});

test('T-29: a destination with shared room but its Opus week used up is not chosen for an Opus chat; one with room on Opus is', () => {
  const d = decide(input([WORK_OPUS_LOW(), SPARE_OPUS_OUT(), HOME_ROOM()], OPUS));
  assert.equal(d.act, 'move');
  if (d.act !== 'move') return;
  assert.deepEqual(d.to, { id: 'home', name: 'Home' });
  assert.deepEqual(d.facts.destLeftPct, { value: 60, basis: 'measured' }, 'the least left over the windows that stop an Opus chat at Home (week 40 % used)');
  assert.ok(!d.alternatives.some((a) => a.id === 'spare'));
});

test('T-29: keep the model first (the default) moves; "change model first" switches to Sonnet on the same Claude, no handoff', () => {
  const settings = { ...SETTINGS, modelFallback: ['sonnet'] };
  const keep = decide(input([WORK_OPUS_LOW(), HOME_ROOM()], { ...OPUS, settings }));
  assert.equal(keep.act === 'move' && keep.to.id, 'home');
  const here = decide(input([WORK_OPUS_LOW(), HOME_ROOM()], { ...OPUS, settings: { ...settings, keepModelFirst: false } }));
  assert.equal(here.act, 'move');
  if (here.act !== 'move') return;
  assert.deepEqual(here.to, { id: 'work', name: 'Work', model: 'sonnet' });
  assert.equal(here.handoff, 'skip');
  assert.deepEqual(here.dropped, { approvals: 0, queued: 0, agents: 0 });
  assert.deepEqual(here.facts.destLeftPct, { value: 50, basis: 'measured' }, 'Sonnet here has what the shared windows have (no Sonnet window on Work)');
  assert.deepEqual(here.alternatives.map((a) => a.id), ['home'], 'the move stays on offer');
});

test('T-29: no other Claude has room on Opus: the model changes here (fallback list set); with no list, a warning and nothing moves', () => {
  const settings = { ...SETTINGS, modelFallback: ['sonnet'] };
  const d = decide(input([WORK_OPUS_LOW(), SPARE_OPUS_OUT()], { ...OPUS, settings }));
  assert.equal(d.act === 'move' && JSON.stringify(d.to), JSON.stringify({ id: 'work', name: 'Work', model: 'sonnet' }));
  const none = decide(input([WORK_OPUS_LOW(), SPARE_OPUS_OUT()], OPUS));
  assert.equal(none.act, 'warn');
});

test('T-29: a shared limit binds (the session): changing model here would not help, so it moves; with no Claude on Opus it moves with Sonnet', () => {
  const settings = { ...SETTINGS, modelFallback: ['sonnet'], keepModelFirst: false };
  const workSessionLow = () => claude('work', 'Work', [win('session', 95), win('week', 50), win('week_opus', 30)]);
  const d = decide(input([workSessionLow(), HOME_ROOM()], { ...OPUS, settings }));
  assert.equal(d.act === 'move' && JSON.stringify(d.to), JSON.stringify({ id: 'home', name: 'Home' }), 'not in place: the session limit stops every model');
  const withSonnet = decide(input([workSessionLow(), SPARE_OPUS_OUT()], { ...OPUS, settings }));
  assert.equal(withSonnet.act, 'move');
  if (withSonnet.act !== 'move') return;
  assert.deepEqual(withSonnet.to, { id: 'spare', name: 'Spare', model: 'sonnet' });
  assert.deepEqual(withSonnet.facts.destLeftPct, { value: 90, basis: 'measured' });
  assert.equal(withSonnet.handoff, 'ask', 'a real move still writes its handoff');
});

test('T-29: a model change in place is not held back by Bypass (it does not touch the permission mode)', () => {
  const settings = { ...SETTINGS, modelFallback: ['sonnet'], keepModelFirst: false };
  const d = decide(input([WORK_OPUS_LOW(), HOME_ROOM()], { session: { ...OPUS.session, mode: 'bypassPermissions' }, settings }));
  assert.equal(d.act, 'move');
  assert.equal(d.act === 'move' && d.to.model, 'sonnet');
});

test('T-29: the fallback list is read from the setting: known families only, in order, no repeats', () => {
  assert.deepEqual(parseModelFallback('Sonnet, haiku sonnet gpt'), ['sonnet', 'haiku']);
  assert.deepEqual(parseModelFallback(''), []);
  assert.deepEqual(parseModelFallback(42), []);
});
