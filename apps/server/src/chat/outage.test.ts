// T-OUT for chat readers (docs/prd/targets-connect.md §12.5, FR39): while a workspace's target is unreachable (an enrolled target's tunnel
// is down) a dropped `tail` does not spend its retries and the session is never marked gone ("Lost touch") or Interrupted; when the
// target returns the reader follows again from its stored byte offset, and no line is applied twice.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TargetUnreachableError } from '../workspaces/runtime.js';
import { line, liveSession, sleep, until } from './testkit.js';

test('outage: a reader waits for its target instead of marking the session gone, and resumes at its offset', async () => {
  const s = await liveSession({ livenessMs: 50 }, true);
  try {
    const first = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'before the drop' }] }, parent_tool_use_id: null, uuid: 'b1' });
    s.tail.push(first);
    await until(() => s.controller.history(s.id).some((e) => e.text === 'before the drop'));
    const offset = s.store.db!.prepare('SELECT byte_offset FROM chat_sessions WHERE id = ?').get(s.id) as { byte_offset: number };

    // The tunnel drops: every exec fails as unreachable, and Connect says the target is down.
    let down = true;
    s.controller.targetState = () => (down ? 'down' : 'up');
    const exec = s.ws.exec.bind(s.ws);
    s.ws.exec = async (...args: Parameters<typeof exec>) => {
      if (down) throw new TargetUnreachableError('docker', new Date().toISOString());
      return exec(...args);
    };
    s.tail.exit(255);
    // Longer than five immediate retries (1 s each) would take, and several liveness rounds.
    await sleep(6_500);
    assert.notEqual(s.state(), 'interrupted');
    assert.equal(s.controller.get(s.id)!.process, 'live');
    assert.equal(s.ws.tails.length, 1, 'no tail was opened while the target was down');

    down = false;
    s.controller.targetReturned('docker');
    await until(() => s.ws.tails.length === 2);
    assert.deepEqual(s.ws.tailArgs[1]!.slice(-1), [String(offset.byte_offset)]);
    const after = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'after the return' }] }, parent_tool_use_id: null, uuid: 'b2' });
    await sleep(20);
    s.ws.tails[1]!.push(after);
    await until(() => s.controller.history(s.id).some((e) => e.text === 'after the return'));
    assert.equal(s.controller.history(s.id).filter((e) => e.text === 'before the drop').length, 1, 'nothing applied twice');
  } finally {
    await s.done();
  }
});

test('a portal restart while the target is away: the live session is followed as soon as the target returns, not a liveness round later (T6)', async () => {
  const s = await liveSession({ livenessMs: 50 }, true);
  let c2: typeof s.controller | null = null;
  try {
    // The portal stops; it starts again while the tunnel is still down: its first liveness round can't reach the workspace.
    s.controller.stop();
    let down = true;
    const exec = s.ws.exec.bind(s.ws);
    s.ws.exec = async (...args: Parameters<typeof exec>) => {
      if (down) throw new TargetUnreachableError('docker', new Date().toISOString());
      return exec(...args);
    };
    const Ctor = s.controller.constructor as new (...a: unknown[]) => typeof s.controller;
    c2 = new Ctor(s.store, s.ws, { livenessMs: 60_000 });
    c2.targetState = () => (down ? 'down' : 'up');
    c2.start();
    await sleep(100);
    const tails = s.ws.tails.length;
    // The agent is back: the session is followed now, not in a minute.
    down = false;
    c2.targetReturned('docker');
    await until(() => s.ws.tails.length === tails + 1, 2_000).catch(() => undefined);
    assert.equal(s.ws.tails.length, tails + 1, 'the session is followed within 2 s of the return (its liveness round is a minute away)');
    assert.equal(c2.get(s.id)!.process, 'live');
  } finally {
    c2?.stop();
    await s.done();
  }
});
