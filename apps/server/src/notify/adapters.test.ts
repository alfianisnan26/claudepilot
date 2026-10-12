// The adapters over the existing seams: CI (chain-wrapped hook, failed after not-failed), plan usage (near is history only; projection is
// an estimate), spend (spikes and budgets at high/exhausted, routed to the alert's owner), tickets (assigned to a person by an agent), and
// the chat (failures, crash, no title or error text in facts). Free text is checked with canaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeUsageAlert, NotifyEvent, SpendAlert } from '@portal/contracts';
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

test('plan usage: high and exhausted notify, near is history only, projection is an estimate with an ETA', () => {
  const { bus, got } = collect();
  let fire: (a: ClaudeUsageAlert) => void = () => {};
  adaptUsage({ onAlert: (fn) => ((fire = fn), () => {}) }, bus);
  const base = { id: 'x', claudeId: 'c1', claudeName: 'Work', workspaceName: 'api-dev', window: 'five_hour', label: 'Session', usedPct: 96, resetsAt: '2026-10-12T07:00:00.000Z', at: '2026-10-12T05:00:00.000Z' };
  fire({ ...base, level: 'high' });
  fire({ ...base, level: 'near', usedPct: 81 });
  fire({ ...base, level: 'near', kind: 'projection', etaAt: '2026-10-12T06:30:00.000Z', projectedPct: 130, newField: 1 } as ClaudeUsageAlert);
  assert.equal(got.length, 3);
  assert.equal(render(got[0]!, { tz: 'Asia/Jakarta' }).body, 'Work · Session · 4 % left · resets 14:00'); // 100 - 96 = 4; 07:00Z is 14:00 WIB
  assert.equal(got[1]!.facts.level, 'near');
  assert.equal(render(got[2]!, { tz: 'UTC' }).body, 'Work · Session · out by 06:30 est. · resets 07:00');
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
});
