// Claude usage's hook (A6, interface I12): every rate-limit report of a session on its Claude's own sign-in is handed to
// `onRateLimit` as Claude Code emitted it; a pool's session keeps the alarm; a hook that throws never touches the session.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { line, liveSession, until } from './testkit.js';

const INFO = { status: 'allowed_warning', resetsAt: 1_790_000_000, rateLimitType: 'five_hour', utilization: 0.83, isUsingOverage: false, surpassedThreshold: 0.8 };
const rateLimit = (info: unknown) => line({ type: 'rate_limit_event', rate_limit_info: info, uuid: randomUUID(), session_id: 'x' });

test('a rate-limit report on a Claude’s own sign-in reaches the hook untouched; nothing of it is stored or shown', async () => {
  const s = await liveSession();
  try {
    s.controller.pooled = () => false;
    const got: { sessionId: string; claudeId: string; info: unknown }[] = [];
    s.controller.onRateLimit = (sessionId, claudeId, info) => got.push({ sessionId, claudeId, info });
    s.tail.push(rateLimit(INFO));
    await until(() => got.length === 1);
    assert.deepEqual(got[0], { sessionId: s.id, claudeId: s.controller.get(s.id)!.claudeId, info: INFO });
    assert.ok(got[0]!.claudeId, 'the Claude it ran on');
    assert.equal(s.controller.get(s.id)!.state, 'idle', 'the session carries on');
    assert.ok(!JSON.stringify(s.messages).includes('five_hour'), 'no tab is told');
    const rows = JSON.stringify(s.store.db!.prepare('SELECT * FROM chat_events').all());
    assert.ok(!rows.includes('five_hour') && !rows.includes('utilization'), 'nothing is stored');
    // The failed turn's own line carries the same info.
    s.tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Limit reached.' }] }, api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: { ...INFO, status: 'rejected' } }, parent_tool_use_id: null, uuid: randomUUID() }));
    await until(() => got.length === 2);
    assert.equal((got[1]!.info as { status: string }).status, 'rejected');
  } finally {
    await s.done();
  }
});

test('on a pool the report still ends the session for safety and the hook is not called', async () => {
  const s = await liveSession();
  try {
    let called = 0;
    s.controller.onRateLimit = () => void called++;
    s.tail.push(rateLimit(INFO));
    await until(() => s.state() === 'ended');
    assert.equal(called, 0);
  } finally {
    await s.done();
  }
});

test('a hook that throws never touches the session, and a line without info calls nothing', async () => {
  const s = await liveSession();
  try {
    s.controller.pooled = () => false;
    let called = 0;
    s.controller.onRateLimit = () => {
      called++;
      throw new Error('boom');
    };
    s.tail.push(rateLimit(INFO));
    await until(() => called === 1);
    s.tail.push(line({ type: 'rate_limit_event', uuid: randomUUID(), session_id: 'x' })); // no rate_limit_info
    s.tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'still here' }] }, parent_tool_use_id: null, uuid: randomUUID() }));
    await until(() => s.controller.history(s.id).some((e) => e.kind === 'assistant'));
    assert.equal(called, 1);
    assert.equal(s.controller.get(s.id)!.state, 'idle');
  } finally {
    await s.done();
  }
});
