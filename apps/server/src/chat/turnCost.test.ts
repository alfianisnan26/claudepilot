// T-343: a running turn's cost estimate from the stream's per-call usage, replaced by the turn's result.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionCost } from '@portal/contracts';
import { callCostUsd } from '../lab/prices.js';
import { costFields } from '../portalmcp/tools/common.js';
import { parseLine } from './protocol.js';
import { firstTurn, line, liveSession, until } from './testkit.js';
import { TurnCost } from './turnCost.js';

const OPUS = 'claude-opus-5-5';
const PRICE = 4e-6; // lab/prices.ts: Opus 5.5 input, per token
const near = (a: number | null | undefined, b: number) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

const assistant = (sessionId: string, id: string, usage: Record<string, unknown>, model: string | null = OPUS, parent: string | null = null) =>
  line({ type: 'assistant', message: { id, role: 'assistant', ...(model ? { model } : {}), content: [{ type: 'text', text: 'x' }], usage }, parent_tool_use_id: parent, session_id: sessionId, uuid: `${id}-u` });
const delta = (sessionId: string, id: string, output: number) =>
  line({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } }, parent_tool_use_id: null, session_id: sessionId, api_message_id: id });
const result = (sessionId: string, cost: number) => line({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, session_id: sessionId, usage: { input_tokens: 1 } });

test('parseLine: an assistant line gives its call’s tokens by kind and model, a sub-agent’s too; message_delta the main call’s output', () => {
  const p = parseLine(assistant('S', 'm1', { input_tokens: 10, cache_read_input_tokens: 300, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 20 }, output_tokens: 2 }));
  assert.deepEqual(p.spend, { messageId: 'm1', model: OPUS, agent: false, input: 10, cacheRead: 300, cacheWrite5m: 30, cacheWrite1h: 20, output: 2 });
  const sub = parseLine(assistant('S', 's1', { input_tokens: 7 }, 'claude-haiku-4-5', 'toolu_x'));
  assert.deepEqual(sub.spend, { messageId: 's1', model: 'claude-haiku-4-5', agent: true, input: 7, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });
  assert.deepEqual(parseLine(delta('S', 'm1', 90)).spend, { messageId: 'm1', model: null, agent: false, input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 90 });
  // A line that counts nothing (Claude Code's own `<synthetic>` answer) is no call.
  assert.equal(parseLine(assistant('S', 'z', { input_tokens: 0, output_tokens: 0 }, '<synthetic>')).spend, undefined);
});

test('TurnCost: each call counted once at its largest counts, priced by the lab’s weights; an unknown model makes it unavailable', () => {
  assert.equal(callCostUsd('some-other-model', { input: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 }), null);
  const t = new TurnCost();
  const base = { model: OPUS, agent: false, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  t.add({ ...base, messageId: 'm1', input: 1000, output: 1 }, OPUS);
  t.add({ ...base, messageId: 'm1', input: 1000, output: 1 }, OPUS); // the same call's next content block
  near(t.estimateUsd(), (1000 + 5 * 1) * PRICE);
  t.add({ ...base, messageId: 'm1', model: null, input: 0, output: 100 }, OPUS); // its message_delta: the final output
  near(t.estimateUsd(), (1000 + 5 * 100) * PRICE);
  t.add({ ...base, messageId: 'm2', input: 0, cacheRead: 10_000, cacheWrite5m: 100, cacheWrite1h: 10, output: 0 }, OPUS);
  near(t.estimateUsd(), (1500 + 0.05 * 10_000 + 1.25 * 100 + 2 * 10) * PRICE);
  // A main-thread line without its model is priced at the session's; a sub-agent's never is (unknown stays unknown).
  t.add({ ...base, messageId: 'm3', model: null, input: 10, output: 0 }, OPUS);
  assert.notEqual(t.estimateUsd(), null);
  t.add({ ...base, messageId: 's1', model: null, agent: true, input: 10, output: 0 }, OPUS);
  assert.equal(t.estimateUsd(), null);
});

test('costFields: cost_usd adds the running estimate and says so; an unpriced turn is unavailable, never guessed', () => {
  assert.deepEqual(costFields({ costUsd: 0.5 }), { cost_usd: 0.5 });
  assert.deepEqual(costFields({ costUsd: 0.5, turnCostEstimateUsd: 0.25 }), { cost_usd: 0.75, cost_basis: 'estimate' });
  assert.deepEqual(costFields({ costUsd: 0.5, turnCostEstimateUsd: null }), { cost_usd: 0.5, cost_basis: 'unavailable' });
  assert.deepEqual(sessionCost({ costUsd: 0, turnCostEstimateUsd: 0.1 }), { usd: 0.1, basis: 'estimate' });
});

test('controller: a long turn’s cost grows as its calls stream, marked an estimate, and the turn’s result replaces it', async () => {
  const s = await liveSession();
  try {
    await firstTurn(s);
    assert.equal(s.controller.get(s.id)!.turnCostEstimateUsd, undefined, 'no call yet, nothing to estimate');
    s.tail.push(assistant(s.id, 'm1', { input_tokens: 1000, output_tokens: 1 }));
    await until(() => s.controller.get(s.id)!.turnCostEstimateUsd !== undefined);
    near(s.controller.get(s.id)!.turnCostEstimateUsd, 1005 * PRICE);
    s.tail.push(delta(s.id, 'm1', 100));
    s.tail.push(assistant(s.id, 'm2', { input_tokens: 2000, cache_read_input_tokens: 10_000, output_tokens: 300 }));
    const grown = (1000 + 500 + 2000 + 0.05 * 10_000 + 5 * 300) * PRICE;
    await until(() => Math.abs((s.controller.get(s.id)!.turnCostEstimateUsd ?? 0) - grown) < 1e-12);
    const live = s.controller.get(s.id)!;
    assert.deepEqual(sessionCost(live).basis, 'estimate');
    assert.equal(costFields(live).cost_basis, 'estimate');
    // Tabs saw it grow without waiting for the result.
    assert.ok(s.messages.some((m) => m.type === 'session' && m.session.id === s.id && typeof m.session.turnCostEstimateUsd === 'number' && m.session.turnCostEstimateUsd > 0.01));
    // The result always wins: its reported total, and no estimate left.
    s.tail.push(result(s.id, 0.0123));
    await until(() => s.controller.get(s.id)!.turnCostEstimateUsd === undefined);
    const after = s.controller.get(s.id)!;
    near(after.costUsd, 0.0123);
    assert.deepEqual(costFields(after), { cost_usd: 0.0123 });
  } finally {
    await s.done();
  }
});

test('controller: a turn on a model without a known price shows its cost unavailable, the reported total unchanged', async () => {
  const s = await liveSession();
  try {
    await firstTurn(s);
    s.tail.push(assistant(s.id, 'm1', { input_tokens: 1000, output_tokens: 10 }, 'claude-unknown-9'));
    await until(() => s.controller.get(s.id)!.turnCostEstimateUsd === null);
    assert.deepEqual(costFields(s.controller.get(s.id)!), { cost_usd: 0, cost_basis: 'unavailable' });
  } finally {
    await s.done();
  }
});
