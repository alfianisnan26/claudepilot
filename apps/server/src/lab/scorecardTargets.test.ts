// T-739 B, plan 7349 gaps a-c: the quota ceiling edge, what the done rate counts, and the bounds and error flag of loadToolResults.
// These pin today's behaviour (part A may change it); each one fails under the mutant named beside it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CrewTarget } from '@portal/contracts';
import type { SessionInfo } from '../usagespend/model.js';
import { MIGRATIONS } from '../store/migrations.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { d65Targets, type CrewFacts, type CrewTicket, type Program } from './scorecard.js';
import { loadToolResults } from './scorecardData.js';

const DAY = 86_400_000;
const FROM = Date.UTC(2026, 9, 13);
const TO = FROM + DAY;
const WS = 'kubernetes/kohi-event'; // has a D-65 baseline (48 a day)
const prog: Program = { id: 'L', title: 'L', leads: ['L'], members: new Set(['L']) };
const info: SessionInfo = { sessionId: 'L', workspaceId: WS, claudeId: 'c1', parentId: null, ticketId: null, title: 'L', state: null, exists: true };

function facts(over: Partial<CrewFacts>): CrewFacts {
  return { nowMs: TO, sessions: new Map([['L', info]]), extra: new Map(), tickets: null, runs: null, deploys: null, pendingDeployTickets: null, spikes: null, refusals: null, usage: () => [], ticketCosts: () => [], ...over };
}
const target = (ts: CrewTarget[], id: string) => ts.find((t) => t.id === id)!;
const win = { fromMs: FROM, toMs: TO, costs: [] };

// a. quota_unused: a Claude may leave 30 percent unused; more than that breaches. Mutant: `worst > D65.unusedPct` -> `>=`.
test('quota_unused: exactly 30 is not a breach (it warns), 30.01 is', () => {
  const row = (v: number) => ({ claudeId: 'c1', window: 'week', resetAt: new Date(TO).toISOString(), unusedPct: { value: v, basis: 'measured' as const, source: 'test' }, readingAt: null });
  const at30 = target(d65Targets(prog, facts({ quotaUnused: [row(30)] }), [], win), 'quota_unused');
  assert.deepEqual([at30.state, at30.figure.value], ['warn', 30]);
  const over = target(d65Targets(prog, facts({ quotaUnused: [row(30.01)] }), [], win), 'quota_unused');
  assert.deepEqual([over.state, over.figure.value], ['breach', 30.01]);
  assert.equal(target(d65Targets(prog, facts({ quotaUnused: [row(23.99)] }), [], win), 'quota_unused').state, 'ok', 'below 80 percent of the ceiling');
  // The warn edge: 80 percent of 30 (exactly 24 in floating point, checked here) warns and names the Claude; just under it does not.
  assert.equal(30 * 0.8, 24);
  const at24 = target(d65Targets(prog, facts({ quotaUnused: [row(24)] }), [], win), 'quota_unused');
  assert.deepEqual([at24.state, at24.figure.value, at24.offenders], ['warn', 24, ['c1']]);
  assert.deepEqual(target(d65Targets(prog, facts({ quotaUnused: [row(23.99)] }), [], win), 'quota_unused').offenders, []);
});

// b. done_rate counts feature and task tickets only. Mutants: drop the type filter; count features only.
const ticket = (id: string, type: string): CrewTicket => ({ id, type, status: 'done', closedAtMs: FROM + 1000, createdAtMs: FROM - DAY, assigneeKind: 'session', assigneeRef: 'L', changes: [], actors: new Set(), tags: [] });

test('done_rate counts feature and task tickets, not bug or chore', () => {
  const t = [ticket('T-1', 'feature'), ticket('T-2', 'task'), ticket('T-3', 'bug'), ticket('T-4', 'chore')];
  assert.equal(target(d65Targets(prog, facts({ tickets: t }), [], win), 'done_rate').figure.value, 2, 'one a feature, one a task, over a day');
});

test('done_rate: bugs and chores alone count as none; a missing type does not count either', () => {
  const t = [ticket('T-3', 'bug'), ticket('T-4', 'chore'), ticket('T-5', '')];
  assert.equal(target(d65Targets(prog, facts({ tickets: t }), [], win), 'done_rate').figure.value, 0);
});

// c. loadToolResults: [from, to), only tool results, only isError = 1 is an error. Mutants: `at >=` -> `>`; `at <` -> `<=`; drop `isError = 1`; `= 1` -> `IS NOT NULL`.
test('loadToolResults: from is in, to is out, from-1ms is out; isError 1 and true fail, 0, false and absent do not', async () => {
  const store = await Store.open({ dataDir: tempDirectory('cp-t739c-'), secretKey: null, migrations: MIGRATIONS });
  try {
    const db = store.db!;
    const now = new Date(FROM).toISOString();
    db.prepare("INSERT INTO chat_sessions (id, workspace_id, state_since, created_at, last_activity_at) VALUES ('s2', 'docker/api', ?, ?, ?)").run(now, now, now);
    const ins = db.prepare('INSERT INTO chat_events (session_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)');
    const iso = (ms: number) => new Date(ms).toISOString();
    ins.run('s2', 1, iso(FROM - 1), 'tool_result', '{"isError":1}'); // 1 ms before: out
    ins.run('s2', 2, iso(FROM), 'tool_result', '{"isError":1}'); // at from: in, an error
    ins.run('s2', 3, iso(TO - 1), 'tool_result', '{"isError":true}'); // last ms: in, an error
    ins.run('s2', 4, iso(TO), 'tool_result', '{"isError":1}'); // at to: out
    ins.run('s2', 5, iso(FROM + 10), 'tool_result', '{"isError":false}'); // in, not an error
    ins.run('s2', 6, iso(FROM + 11), 'tool_result', '{}'); // in, not an error
    ins.run('s2', 7, iso(FROM + 12), 'tool_result', '{"isError":0}'); // in, not an error
    ins.run('s2', 8, iso(FROM + 13), 'assistant', '{"isError":1}'); // not a tool result
    assert.deepEqual(loadToolResults(db, FROM, TO, new Set(['s2'])), [{ sessionId: 's2', total: 5, denied: 0, portal: 0, failed: 2 }]);
    assert.deepEqual(loadToolResults(db, FROM, TO, new Set(['nobody'])), [], 'a session with no results is absent');
  } finally {
    store.close();
  }
});
