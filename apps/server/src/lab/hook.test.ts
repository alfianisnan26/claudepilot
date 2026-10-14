import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { firstTurn, init, line, liveSession, until } from '../chat/testkit.js';

test('the chat hands the lab every line it accepted, and none it refused (after the integrity checks)', async () => {
  const s = await liveSession();
  const seen: string[] = [];
  s.controller.onStreamLine = (sessionId, raw) => {
    assert.equal(sessionId, s.id);
    seen.push(raw);
  };
  try {
    await firstTurn(s);
    const said = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null, uuid: randomUUID() });
    s.tail.push(said);
    await until(() => seen.some((l) => l.trim() === said.trim()));
    // A line the integrity check refuses ends the session and is not measured.
    const bad = init('another-session');
    s.tail.push(bad);
    await until(() => s.state() === 'ended');
    assert.ok(!seen.some((l) => l.trim() === bad.trim()), 'a refused line never reaches the lab');
  } finally {
    await s.done();
  }
});

test('a lab that throws never touches the chat', async () => {
  const s = await liveSession();
  s.controller.onStreamLine = () => {
    throw new Error('boom');
  };
  try {
    await firstTurn(s);
    s.tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'still here' }] }, parent_tool_use_id: null, uuid: randomUUID() }));
    await until(() => s.controller.history(s.id).some((e) => e.text === 'still here'));
    assert.notEqual(s.state(), 'ended');
  } finally {
    await s.done();
  }
});
