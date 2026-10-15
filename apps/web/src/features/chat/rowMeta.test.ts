import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSession, ClaudeUsage, ClaudeUsageWindow, ListRow, PersonaIdentity } from '@portal/contracts';
import { modelShortName } from './modelName';
import { avatarsShown, barWidth, LINE_TWO_ORDER, lineTwo, listFacts, quotaMeter, quotaTone, roleShown, rowMeta, rowState, thirdLine, workspaceShown } from './rowMeta';

// Times are relative to the real clock (no fixed dates).
const NOW = Date.now();
const inMin = (m: number) => new Date(NOW + m * 60_000).toISOString();

let n = 0;
function s(over: Partial<ChatSession> = {}): ChatSession {
  n++;
  return {
    id: `s${n}`,
    workspaceId: 'kubernetes/ws',
    cwd: '/home/node',
    title: `S ${n}`,
    state: 'idle',
    origin: 'ui',
    model: 'claude-opus-5-5',
    mode: 'default',
    effort: 'high',
    ultracode: false,
    ultracodeAvailable: false,
    process: 'live',
    context: null,
    costUsd: 0,
    turns: 0,
    lastSeq: 0,
    waiting: 0,
    waitingFor: null,
    agentsRunning: 0,
    createdAt: inMin(-30),
    lastActivityAt: inMin(-2),
    endedReason: null,
    claudeId: 'c-satria',
    claudeName: 'satria',
    previousClaudes: [],
    parentId: null,
    ticketId: null,
    worktree: null,
    pinnedAt: null,
    archivedAt: null,
    ...over,
  } as ChatSession;
}

const win = (key: string, usedPct: number | null, resetsInMin: number | null, level: ClaudeUsageWindow['level'] = 'ok'): ClaudeUsageWindow => ({
  key,
  label: key === 'session' ? 'Session' : 'Week',
  usedPct,
  resetsAt: resetsInMin === null ? null : inMin(resetsInMin),
  level,
});

function usage(over: Partial<ClaudeUsage> = {}): ClaudeUsage {
  return {
    claudeId: 'c-satria',
    claudeName: 'satria',
    workspaceId: 'kubernetes/ws',
    workspaceName: 'ws',
    runsOn: 'plan',
    state: 'ok',
    plan: 'max',
    windows: [win('session', 62, 130), win('week', 40, 3 * 1440)],
    extra: null,
    checkedAt: inMin(-3),
    source: 'probe',
    stale: false,
    workspaceRunning: true,
    problem: null,
    unavailable: null,
    limitReport: null,
    snoozedUntil: null,
    projectionSnoozedUntil: null,
    slot: null,
    trend: null,
    ...over,
  } as ClaudeUsage;
}

const row = (session: ChatSession, over: Partial<ListRow> = {}): ListRow => ({
  session,
  children: [],
  rollup: null,
  earlier: false,
  workspaceGone: false,
  parentTitle: null,
  context: false,
  header: false,
  ...over,
});

test('model label: the short name of the id in effect, the alias as its family, an unknown id as reported, none before a report', () => {
  assert.equal(modelShortName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelShortName('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(modelShortName('claude-opus-4-6[1m]'), 'Opus 4.6');
  assert.equal(modelShortName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(modelShortName('claude-opus-4-20250514'), 'Opus 4', 'a date is not a minor version');
  assert.equal(modelShortName('us.anthropic.claude-haiku-4-5-20251001-v1:0'), 'Haiku 4.5');
  assert.equal(modelShortName('opus'), 'Opus');
  assert.equal(modelShortName('my-custom-model'), 'my-custom-model');
  assert.equal(modelShortName(null), null);
  assert.equal(modelShortName('  '), null);
});

test('row meta: the model with its effort in the tip; nothing when no model was reported', () => {
  const m = rowMeta({ session: s(), groupBy: 'none', showWorkspace: false, usage: usage(), nowMs: NOW });
  assert.deepEqual(m.model, { label: 'Opus 5.5', title: 'Model: claude-opus-5-5, effort high' });
  assert.equal(rowMeta({ session: s({ model: null }), groupBy: 'none', showWorkspace: false, usage: usage(), nowMs: NOW }).model, null);
});

test('quota: the 5-hour percent, its tone by 70 and 90, the week, resets and the reading age in the tip', () => {
  const q = quotaMeter('satria', usage(), NOW);
  assert.equal(q.kind, 'plan');
  assert.ok(q.kind === 'plan' && q.usedPct === 62 && q.tone === 'neutral');
  assert.match(q.title, /^Quota, satria: 5-hour 62 % used, resets .+ \(in 2 h 10 m\); week 40 % used, resets .+; read 3 m ago$/);
  assert.equal(quotaTone(69.9), 'neutral');
  assert.equal(quotaTone(70), 'warn');
  assert.equal(quotaTone(89), 'warn');
  assert.equal(quotaTone(90), 'critical');
  const high = quotaMeter('satria', usage({ windows: [win('session', 93, 30)] }), NOW);
  assert.ok(high.kind === 'plan' && high.tone === 'critical');
  assert.doesNotMatch(high.title, /week/, 'no week in the tip when there is no week reading');
  assert.equal(barWidth(140), 100);
  assert.equal(barWidth(-1), 0);
});

test('quota: unavailable (grey, no number) when the reading is missing, old, past its reset, or the portal says unknown; never a guess', () => {
  const kinds = [
    quotaMeter('satria', null, NOW),
    quotaMeter('satria', usage({ stale: true }), NOW),
    quotaMeter('satria', usage({ windows: [win('session', 62, -5)] }), NOW),
    quotaMeter('satria', usage({ windows: [win('session', null, 30)] }), NOW),
    quotaMeter('satria', usage({ windows: [win('week', 40, 3000)] }), NOW),
    quotaMeter('satria', usage({ unavailable: 'no_reset_time' }), NOW),
    quotaMeter('satria', usage({ runsOn: 'none' }), NOW),
  ];
  for (const q of kinds) {
    assert.equal(q.kind, 'unavailable', q.title);
    assert.match(q.title, /^Quota, satria: unavailable \(/);
    assert.doesNotMatch(q.title, /\d+ %/, 'no percent in an unavailable tip');
  }
  assert.match(kinds[0]!.title, /not read yet/);
  assert.match(kinds[1]!.title, /the reading is old, read 3 m ago/);
  assert.match(kinds[6]!.title, /not signed in/);
});

test('quota: a pool or an API key has no plan limits (no bar); a limit a chat reported is measured, used up', () => {
  assert.equal(quotaMeter('pool', usage({ runsOn: 'pool' }), NOW).kind, 'no_limits');
  assert.equal(quotaMeter('key', usage({ runsOn: 'key' }), NOW).kind, 'no_limits');
  const out = quotaMeter('satria', usage({ limitReport: { window: 'session', label: 'Session', at: inMin(-1), until: inMin(60), guessed: false, sessionId: null } }), NOW);
  assert.ok(out.kind === 'plan' && out.usedPct === 100 && out.tone === 'critical');
  assert.match(out.title, /used up \(Session\), back /);
});

test('row meta: the Claude is named with its bar; under a Claude heading only the bar; no Claude recorded, no item', () => {
  const m = rowMeta({ session: s(), groupBy: 'none', showWorkspace: false, usage: usage(), nowMs: NOW });
  assert.equal(m.claude?.name, 'satria');
  assert.equal(m.claude?.meter.kind, 'plan');
  assert.equal(rowMeta({ session: s(), groupBy: 'claude', showWorkspace: false, usage: usage(), nowMs: NOW }).claude?.name, null);
  assert.equal(rowMeta({ session: s({ claudeId: '', claudeName: null }), groupBy: 'none', showWorkspace: false, usage: null, nowMs: NOW }).claude, null);
});

test('row meta: a worker on its lead\'s Claude does not repeat it (the lead above says it); on another Claude it names it', () => {
  const worker = s();
  const same = { claudeId: worker.claudeId, claudeName: worker.claudeName };
  assert.equal(rowMeta({ session: worker, groupBy: 'none', showWorkspace: false, usage: usage(), nowMs: NOW, lead: same }).claude, null);
  assert.equal(rowMeta({ session: worker, groupBy: 'none', showWorkspace: false, usage: usage(), nowMs: NOW, lead: { claudeId: '', claudeName: worker.claudeName } }).claude, null, 'the same name, no id');
  const other = rowMeta({ session: worker, groupBy: 'none', showWorkspace: false, usage: usage(), nowMs: NOW, lead: { claudeId: 'claude-other', claudeName: 'Work' } });
  assert.equal(other.claude?.name, worker.claudeName);
  assert.equal(other.claude?.meter.kind, 'plan');
  assert.equal(rowMeta({ session: worker, groupBy: 'none', showWorkspace: false, usage: usage(), nowMs: NOW, lead: null }).claude?.name, worker.claudeName, 'no lead: its own');
});

test('row meta: the cost (an estimate while a turn runs), nothing at 0; branch and ticket unless the grouping says them', () => {
  assert.equal(rowMeta({ session: s(), groupBy: 'none', showWorkspace: false, usage: null, nowMs: NOW }).cost, null);
  assert.deepEqual(rowMeta({ session: s({ costUsd: 10, turnCostEstimateUsd: 0.39 }), groupBy: 'none', showWorkspace: false, usage: null, nowMs: NOW }).cost, { usd: 10.39, estimate: true });
  assert.deepEqual(rowMeta({ session: s({ costUsd: 2.39 }), groupBy: 'none', showWorkspace: false, usage: null, nowMs: NOW }).cost, { usd: 2.39, estimate: false });
  const wt = s({ worktree: { path: '/w/t-375', branch: 'ticket/T-375-rows' } as ChatSession['worktree'], ticketId: 'T-375' });
  const m = rowMeta({ session: wt, groupBy: 'none', showWorkspace: false, usage: null, nowMs: NOW });
  assert.deepEqual(m.branch, { label: 'ticket/T-375-rows', title: '/w/t-375' });
  assert.equal(m.ticket, 'T-375');
  assert.equal(rowMeta({ session: wt, groupBy: 'worktree', showWorkspace: false, usage: null, nowMs: NOW }).branch, null);
  assert.equal(rowMeta({ session: wt, groupBy: 'ticket', showWorkspace: false, usage: null, nowMs: NOW }).ticket, null);
});

test('line two: the items in priority order (state, quota, cost, model, workspace, Claude, branch, ticket); only those it has', () => {
  assert.deepEqual([...LINE_TWO_ORDER], ['state', 'quota', 'cost', 'model', 'workspace', 'claude', 'branch', 'ticket']);
  const full = s({ costUsd: 1.5, ticketId: 'T-1', worktree: { path: '/w/x', branch: 'ticket/T-1-x' } as ChatSession['worktree'] });
  assert.deepEqual(lineTwo(rowMeta({ session: full, groupBy: 'none', showWorkspace: true, usage: usage(), nowMs: NOW })), [...LINE_TWO_ORDER]);
  // The cost comes before the model and the Claude's name, so a short line keeps the number (the ux check of c84657f: the lead's cost gone).
  const lead = lineTwo(rowMeta({ session: s({ costUsd: 10.39 }), groupBy: 'none', showWorkspace: false, usage: usage(), nowMs: NOW }));
  assert.deepEqual(lead, ['state', 'quota', 'cost', 'model', 'claude']);
  // Under a Claude heading: the bar, not the name. A pool or a key: no bar, the name stays. A worker on its lead's Claude: neither.
  assert.deepEqual(lineTwo(rowMeta({ session: s(), groupBy: 'claude', showWorkspace: false, usage: usage(), nowMs: NOW })), ['state', 'quota', 'model']);
  assert.deepEqual(lineTwo(rowMeta({ session: s(), groupBy: 'none', showWorkspace: false, usage: usage({ runsOn: 'pool' }), nowMs: NOW })), ['state', 'model', 'claude']);
  const lead2 = s();
  assert.deepEqual(lineTwo(rowMeta({ session: s(), groupBy: 'none', showWorkspace: false, usage: usage(), nowMs: NOW, lead: lead2 })), ['state', 'model']);
  assert.deepEqual(lineTwo(rowMeta({ session: s({ model: null, claudeId: '', claudeName: null }), groupBy: 'none', showWorkspace: false, usage: null, nowMs: NOW })), ['state']);
});

test('line three: only the open request; a branch or ticket stays on line two (two lines)', () => {
  const ask = rowMeta({ session: s({ state: 'waiting', waiting: 1, waitingFor: 'Run a command: npm test', ticketId: 'T-1' }), groupBy: 'none', showWorkspace: false, usage: null, nowMs: NOW });
  assert.equal(ask.waitingFor, 'Run a command: npm test');
  assert.equal(thirdLine(ask), 'waiting');
  const where = rowMeta({ session: s({ ticketId: 'T-1', worktree: { path: '/w/x', branch: 'ticket/T-1-x' } as ChatSession['worktree'] }), groupBy: 'none', showWorkspace: false, usage: null, nowMs: NOW });
  assert.equal(where.ticket, 'T-1');
  assert.equal(thirdLine(where), null);
  assert.equal(thirdLine(rowMeta({ session: s(), groupBy: 'none', showWorkspace: false, usage: null, nowMs: NOW })), null);
  // A stale waitingFor on a session that no longer waits says nothing.
  assert.equal(rowMeta({ session: s({ waitingFor: 'old' }), groupBy: 'none', showWorkspace: false, usage: null, nowMs: NOW }).waitingFor, null);
});

test('workspace label: only when the rows span more than one workspace, never under a workspace heading', () => {
  const one = listFacts([row(s()), row(s(), { children: [row(s())] })], null);
  assert.equal(one.workspaces, 1);
  assert.equal(workspaceShown(one, 'none'), false);
  const two = listFacts([row(s()), row(s(), { children: [row(s({ workspaceId: 'docker/other' }))] })], null);
  assert.equal(two.workspaces, 2, 'nested rows count');
  assert.equal(workspaceShown(two, 'none'), true);
  assert.equal(workspaceShown(two, 'workspace'), false);
  const m = rowMeta({ session: s({ workspaceId: 'docker/other' }), groupBy: 'none', showWorkspace: true, usage: null, nowMs: NOW });
  assert.equal(m.workspace?.title, 'docker/other');
  assert.equal(rowMeta({ session: s(), groupBy: 'none', showWorkspace: false, usage: null, nowMs: NOW }).workspace, null);
});

test('persona avatar: only when the rows shown have more than one persona', () => {
  const pw: PersonaIdentity = { poolId: 'p-way', name: 'pilot-way', avatar: null };
  const ko: PersonaIdentity = { poolId: 'p-ko', name: 'konfersi', avatar: null };
  const rows = [row(s()), row(s({ workspaceId: 'docker/b' }))];
  assert.equal(avatarsShown(listFacts(rows, { 'kubernetes/ws': pw, 'docker/b': pw })), false, 'the same persona on every row tells nothing apart');
  assert.equal(avatarsShown(listFacts(rows, { 'kubernetes/ws': pw })), false, 'one persona and none');
  assert.equal(avatarsShown(listFacts(rows, { 'kubernetes/ws': pw, 'docker/b': ko })), true);
  assert.equal(avatarsShown(listFacts([row(s()), row(s({ workspaceId: 'docker/b' }), { workspaceGone: true })], { 'kubernetes/ws': pw, 'docker/b': ko })), false, 'a removed workspace has no persona');
});

test('role: hidden when the title already starts with it, shown otherwise, none when unset', () => {
  assert.equal(roleShown({ agent: 'konfersi-web', title: 'konfersi-web' }), null);
  assert.equal(roleShown({ agent: 'konfersi-web', title: 'Konfersi-Web: landing page' }), null);
  assert.equal(roleShown({ agent: 'qa-verifier', title: 'Verify T-369' }), 'qa-verifier');
  assert.equal(roleShown({ agent: null, title: 'x' }), null);
  assert.equal(roleShown({ agent: '  ', title: 'x' }), null);
});

test('state: one word and a tone; removed, safety and moving first; several open requests counted', () => {
  assert.deepEqual(rowState(s({ state: 'working', agentsRunning: 2 }), false, null), { word: 'Working', tone: 'busy', agents: 2 });
  assert.deepEqual(rowState(s({ state: 'idle', agentsRunning: 2 }), false, null), { word: 'Idle', tone: 'quiet', agents: 0 });
  assert.equal(rowState(s({ state: 'waiting', waiting: 1 }), false, null).word, 'Needs you');
  assert.deepEqual(rowState(s({ state: 'waiting', waiting: 3 }), false, null), { word: '3 waiting', tone: 'ask', agents: 0 });
  assert.equal(rowState(s({ state: 'interrupted' }), false, null).tone, 'ask');
  assert.equal(rowState(s({ state: 'working' }), true, null).word, 'Removed');
  assert.deepEqual(rowState(s({ state: 'ended' }), false, 'Ended for safety'), { word: 'Ended for safety', tone: 'danger', agents: 0 });
  assert.equal(rowState(s({ switching: { toClaude: 'x', step: 'handoff' } }), false, null).word, 'Moving');
});
