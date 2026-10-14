// The adapters over the existing seams: CI (chain-wrapped hook, failed after not-failed), plan usage (near is history only; projection is
// an estimate), spend (spikes and budgets at high/exhausted, routed to the alert's owner), tickets (assigned to a person by an agent), and
// the chat (failures, crash, no title or error text in facts). Free text is checked with canaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeUsageAlert, NotifyEvent, SpendAlert } from '@portal/contracts';
import { FOLDER_CHANGED } from '../chat/trust.js';
import { createBus } from './bus.js';
import { adaptChat, errorReason, requestAction } from './adapters/chat.js';
import { adaptCi } from './adapters/ci.js';
import { adaptSpend } from './adapters/spend.js';
import { adaptTickets, type TicketEventLike } from './adapters/tickets.js';
import { adaptUsage } from './adapters/usage.js';
import { render } from './templates.js';
import { FakeChat, request, session } from './testkit.js';

const collect = () => {
  const bus = createBus();
  const got: NotifyEvent[] = [];
  bus.on('*', (e) => got.push(e));
  return { bus, got };
};

test('CI: keeps the hook already set, notifies a failed run once (not cancelled, not failed again), names only', () => {
  const { bus, got } = collect();
  const seen: string[] = [];
  const ci = { hooks: { changed: (run: { id: string }) => void seen.push(run.id) } } as never as { hooks: { changed?: (run: never, prev: never) => void } };
  const off = adaptCi(ci as never, bus);
  const run = (status: string) => ({ id: 'run_1', number: 14, workspace_id: 'docker/api-dev', repo: 'api', pipeline: 'test', status, subject: 'CANARY commit message' });
  (ci.hooks.changed as (r: unknown, p: unknown) => void)(run('failed'), 'running');
  (ci.hooks.changed as (r: unknown, p: unknown) => void)(run('failed'), 'failed');
  (ci.hooks.changed as (r: unknown, p: unknown) => void)(run('cancelled'), 'running');
  assert.deepEqual(seen, ['run_1', 'run_1', 'run_1'], 'the earlier hook still runs');
  assert.equal(got.length, 1);
  assert.deepEqual(render(got[0]!), { title: 'CI failed', body: 'api · #14 · test', path: '/admin/ci/runs/run_1', tag: 'ci:run_1', renotify: false, severity: 'attention' });
  assert.ok(!JSON.stringify(got).includes('CANARY'));
  off();
});

test('CI: a deployment job that starts waiting for a person is one "Deploy waits" with the environment and the run number, linking to the run; the gate key never travels', () => {
  const { bus, got } = collect();
  const seen: string[] = [];
  const ci = { hooks: { waiting: (run: { id: string }) => void seen.push(run.id) } } as never as { hooks: { waiting?: (run: never, job: string, env: string) => void } };
  const off = adaptCi(ci as never, bus);
  const run = { id: 'run_2', number: 15, workspace_id: 'kubernetes/kohi-event', repo: 'claudepilot', pipeline: 'deploy', status: 'running', subject: 'CANARY commit message', inputs: '{"CANARY":1}', gate_key: 'CANARY-KEY' };
  (ci.hooks.waiting as (r: unknown, j: string, e: string) => void)(run, 'release', 'production');
  assert.deepEqual(seen, ['run_2'], 'the earlier hook still runs');
  assert.equal(got.length, 1);
  assert.equal(got[0]!.kind, 'ci_waiting');
  assert.deepEqual(got[0]!.subject, { type: 'ci_run', id: 'run_2', workspaceId: 'kubernetes/kohi-event' });
  assert.deepEqual(render(got[0]!), { title: 'Deploy waits', body: 'production · claudepilot · #15', path: '/admin/ci/runs/run_2', tag: 'deploy:run_2:release', renotify: false, severity: 'attention' });
  assert.ok(!JSON.stringify(got).includes('CANARY'));
  off();
  assert.equal(typeof ci.hooks.waiting, 'function', 'the earlier hook is put back');
  (ci.hooks.waiting as (r: unknown, j: string, e: string) => void)(run, 'release', 'production');
  assert.equal(got.length, 1, 'after off() the adapter is gone');
});

test('plan usage: high and exhausted notify, near is history only, projection is an estimate with an ETA', () => {
  const { bus, got } = collect();
  let fire: (a: ClaudeUsageAlert) => void = () => {};
  adaptUsage({ onAlert: (fn) => ((fire = fn), () => {}) }, bus);
  const base = { id: 'x', claudeId: 'c1', claudeName: 'Work', workspaceName: 'api-dev', window: 'five_hour', label: 'Session', usedPct: 96, resetsAt: '2026-10-12T07:00:00.000Z', at: '2026-10-12T05:00:00.000Z' };
  fire({ ...base, level: 'high' });
  fire({ ...base, level: 'near', usedPct: 81 });
  fire({ ...base, level: 'near', kind: 'projection', etaAt: '2026-10-12T06:30:00.000Z', projectedPct: 130, newField: 1 } as ClaudeUsageAlert);
  assert.equal(got.length, 3);
  assert.equal(render(got[0]!, { tz: 'Asia/Jakarta', now: Date.parse(base.at) }).body, 'Work · Session · 4 % left · resets 14:00'); // 100 - 96 = 4; 07:00Z is 14:00 WIB
  assert.equal(got[1]!.facts.level, 'near');
  assert.equal(render(got[2]!, { tz: 'UTC', now: Date.parse(base.at) }).body, 'Work · Session · out by 06:30 est. · resets 07:00');
  assert.deepEqual(got[2]!.estimates, ['etaAt', 'projectedPct']);
});

test('spend: a spike and a budget at high or exhausted are cost_spike for the alert’s owner; a budget at near is not', () => {
  const { bus, got } = collect();
  let fire: (a: SpendAlert) => void = () => {};
  adaptSpend({ onAlert: (fn) => ((fire = fn), () => {}) }, bus);
  const scope = { kind: 'workspace' as const, id: 'docker/api-dev', label: 'api-dev' };
  fire({ kind: 'budget', id: 'b', at: '', level: 'high', scope, owner: 'u_owner', workspaceId: 'docker/api-dev', summary: 'CANARY summary', budgetId: 'bud_1', budgetName: 'api daily', scopeLabel: 'api-dev', usedPct: 95, periodEnd: '', paused: false });
  fire({ kind: 'budget', id: 'b2', at: '', level: 'near', scope, owner: 'u_owner', workspaceId: null, summary: '', budgetId: 'bud_1', budgetName: 'x', scopeLabel: null, usedPct: 80, periodEnd: '', paused: false });
  fire({ kind: 'spike', id: 's', at: '', level: 'near', scope, owner: 'u_owner', summary: 'CANARY', spikeId: 'sp1', spikeKind: 'rate', sessionId: null, claudeId: 'c1', workspaceId: 'docker/api-dev', heuristic: true } as SpendAlert);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((e) => [e.kind, e.audience]), [['cost_spike', ['u_owner']], ['cost_spike', ['u_owner']]]);
  assert.equal(render(got[0]!).body, 'api daily · 95 % used est.');
  assert.equal(render(got[1]!).body, 'api-dev · rate · est.');
  assert.ok(!JSON.stringify(got).includes('CANARY'));
});

test('tickets: assigned to a person by an agent or the portal is a human_request; by the person, or to a session, is not; closed dims it', () => {
  const { bus, got } = collect();
  const src: { onEvent?: (e: TicketEventLike) => void } = { onEvent: () => {} };
  const closed: string[] = [];
  adaptTickets(src, bus, { info: () => ({ type: 'approval', workspaceId: 'docker/api-dev', open: true }), closed: (id) => closed.push(id) });
  const ev = (actor: string, to: unknown, kind: TicketEventLike['kind'] = 'assigned') => src.onEvent!({ ticketId: 'T-12', kind, actor, fromAgent: actor.startsWith('session:'), data: { to } });
  ev('session:s1', { kind: 'user', name: 'admin' });
  ev('system', { kind: 'user', name: 'admin' });
  ev('ui', { kind: 'user', name: 'admin' });
  ev('user:u_owner', { kind: 'user', name: 'admin' });
  ev('session:s1', { kind: 'session', sessionId: 's2' });
  ev('ui', null, 'closed');
  assert.equal(got.length, 2);
  assert.equal(render(got[0]!).body, 'T-12 · approval · api-dev');
  assert.equal(render(got[0]!).path, '/admin/tickets/T-12');
  assert.deepEqual(closed, ['T-12']);
});

test('chat: a crash mid-turn and a credential end fail; a person closing does not; facts carry no title, command or error text', () => {
  const { bus, got } = collect();
  const chat = new FakeChat();
  adaptChat({ chat, bus, untrusted: () => false, doneWanted: () => false, resolved: () => {} });
  const s = session('s1', { title: 'CANARY title', state: 'working' });
  chat.sessions.set('s1', s);
  chat.dispatch('s1', { type: 'session', session: s });
  chat.dispatch('s1', { type: 'session', session: { ...s, state: 'interrupted', endedReason: 'CANARY reason' } });
  chat.dispatch('s1', { type: 'session', session: { ...s, state: 'idle' } });
  chat.dispatch('s1', { type: 'session', session: { ...s, state: 'ended', endedReason: 'closed by operator' } });
  chat.dispatch('s1', { type: 'session', session: { ...s, state: 'idle' } });
  chat.dispatch('s1', { type: 'session', session: { ...s, state: 'ended', endedReason: 'credential: CANARY expired' } });
  chat.dispatch('s1', { type: 'events', session: 's1', items: [{ seq: 1, at: '', kind: 'error', text: 'API Error: 429 rate_limit CANARY' }] });
  chat.dispatch('s1', { type: 'events', session: 's1', items: [{ seq: 2, at: '', kind: 'error', text: 'boom', agentLabel: 'worker' }] });
  chat.ask(s, request('r1', 'Edit', '/home/coder/project/CANARY.ts'));
  assert.deepEqual(got.map((e) => [e.kind, e.facts.reason ?? e.facts.action]), [['session_failed', 'crash'], ['session_failed', 'credential'], ['session_failed', 'rate_limit'], ['approval', 'edit']]);
  assert.ok(!JSON.stringify(got.map((e) => e.facts)).includes('CANARY'));
  assert.equal(got[3]!.detail?.text, '/home/coder/project/CANARY.ts', 'the request summary is detail (shown only with Include detail)');
  assert.equal(requestAction({ kind: 'question', toolName: null }), 'question');
  assert.equal(errorReason('overloaded_error'), 'rate_limit');
  assert.equal(errorReason(FOLDER_CHANGED), 'folder_trust', 'a wake refused for trust says so (T-38)');
  assert.equal(errorReason('boom'), 'error');
});

// T-41: done means the session went idle and stayed so. Working is the main turn OR a task of its process running (the controller
// presents that as `working`, `tasksOnly`), so a turn's result while sub-agents run is not done.
const doneRig = (wanted = true) => {
  const { bus, got } = collect();
  const chat = new FakeChat();
  let clock = 1_000_000;
  const off = adaptChat({ chat, bus, untrusted: () => false, doneWanted: () => wanted, resolved: () => {}, doneDebounceMs: 30, now: () => clock });
  const s0 = session('s1', { state: 'idle' });
  const set = (over: Partial<typeof s0>) => {
    const s = { ...s0, ...over };
    chat.sessions.set('s1', s);
    chat.dispatch('s1', { type: 'session', session: s });
  };
  const result = () => chat.dispatch('s1', { type: 'events', session: 's1', items: [{ seq: 1, at: '', kind: 'result', durationMs: 400_000 }] });
  const advance = (ms: number) => (clock += ms);
  const done = () => got.filter((e) => e.kind === 'session_done');
  return { set, result, advance, done, off, wait: (ms = 60) => new Promise((r) => setTimeout(r, ms)) };
};

test('chat: a result while tasks run is no session_done: it stays working; the last task ending emits it once, after the debounce', async () => {
  const r = doneRig();
  try {
    r.set({ state: 'idle' });
    r.set({ state: 'working' });
    r.advance(6 * 60_000);
    r.result(); // the main turn's result: its tasks still run, so the controller still says working
    r.set({ state: 'working', tasksOnly: true, agentsRunning: 2 });
    await r.wait();
    assert.equal(r.done().length, 0, 'no session_done for a result, nor while tasks run');
    r.set({ state: 'working', tasksOnly: true, agentsRunning: 1 });
    r.set({ state: 'idle', agentsRunning: 0 });
    assert.equal(r.done().length, 0, 'not at once: after the debounce');
    await r.wait();
    assert.equal(r.done().length, 1);
    assert.equal(r.done()[0]!.facts.minutes, 6, 'from the first working moment of the stretch');
    r.set({ state: 'idle', agentsRunning: 0 }); // the same state again
    await r.wait();
    assert.equal(r.done().length, 1, 'once per move to idle');
  } finally {
    r.off();
  }
});

test('chat: a new turn before the debounce ends cancels the done; the stretch goes on and is counted whole', async () => {
  const r = doneRig(false);
  try {
    r.set({ state: 'working' });
    r.advance(3 * 60_000);
    r.set({ state: 'idle' });
    r.set({ state: 'working' }); // a task's notification started the next turn
    await r.wait();
    assert.equal(r.done().length, 0);
    r.advance(3 * 60_000);
    r.set({ state: 'idle' });
    await r.wait();
    assert.deepEqual(r.done().map((e) => e.facts.minutes), [6], 'not asked for, but 6 minutes of work: long enough');
  } finally {
    r.off();
  }
});

test('chat: no session_done mid-move, for an ended session, or when nobody asked and it was short', async () => {
  const r = doneRig(false);
  try {
    r.set({ state: 'working' });
    r.set({ state: 'idle' });
    await r.wait();
    assert.equal(r.done().length, 0, 'short and not asked for');
  } finally {
    r.off();
  }
  const m = doneRig();
  try {
    m.set({ state: 'working' });
    m.set({ state: 'idle', switching: { toClaude: 'Work', step: 'starting' } });
    await m.wait();
    m.set({ state: 'ended' });
    await m.wait();
    assert.equal(m.done().length, 0);
    m.set({ state: 'working' });
    m.set({ state: 'idle' });
    m.set({ state: 'ended' }); // ended within the debounce
    await m.wait();
    assert.equal(m.done().length, 0);
  } finally {
    m.off();
  }
});
