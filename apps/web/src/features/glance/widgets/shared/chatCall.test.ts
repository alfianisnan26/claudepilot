import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callChat, respondTo, stopSession, stopTask, type SocketLike } from './chatCall.js';

/** A socket the test drives: `open()` the connection, `reply()` as the portal. */
class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  sent: unknown[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  reply(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
const harness = (timeoutMs = 1000) => {
  const sockets: FakeSocket[] = [];
  const deps = { open: () => (sockets.push(new FakeSocket()), sockets.at(-1)!), url: 'ws://x/api/chat/live', timeoutMs, newId: () => 'u-1' };
  return { sockets, deps };
};

test('an answer to a request is the chat socket respond message, sent once the connection opens, settled on the ack keyed by the request id', async () => {
  const { sockets, deps } = harness();
  const done = respondTo('s1', 'req-9', 'allow', deps);
  const s = sockets[0]!;
  assert.deepEqual(s.sent, [], 'nothing before the connection is open');
  s.open();
  assert.deepEqual(s.sent, [{ type: 'respond', session: 's1', requestId: 'req-9', decision: 'allow' }]);
  s.reply({ type: 'ack', uuid: 'someone-else', ok: false, error: 'not ours' });
  s.reply({ type: 'events', session: 's1', items: [] });
  s.reply({ type: 'ack', uuid: 'req-9', ok: true });
  await done;
  assert.equal(s.closed, true, 'the connection is closed after');
});

test('deny is the same message with deny, and never "allow for session"', async () => {
  const { sockets, deps } = harness();
  const done = respondTo('s1', 'req-1', 'deny', deps);
  sockets[0]!.open();
  assert.equal((sockets[0]!.sent[0] as { decision: string }).decision, 'deny');
  sockets[0]!.reply({ type: 'ack', uuid: 'req-1', ok: true });
  await done;
});

test('a refusal is the portal\'s own words and code (the request is no longer open, the chat is moving)', async () => {
  const { sockets, deps } = harness();
  const done = respondTo('s1', 'req-2', 'allow', deps);
  sockets[0]!.open();
  sockets[0]!.reply({ type: 'ack', uuid: 'req-2', ok: false, error: 'That request is no longer open.', code: 'CONFLICT' });
  await assert.rejects(done, (e: Error & { code?: string }) => e.message === 'That request is no longer open.' && e.code === 'CONFLICT');
  assert.equal(sockets[0]!.closed, true);
});

test('an error the portal sends for this session settles it; one for another session does not', async () => {
  const { sockets, deps } = harness();
  const done = respondTo('s1', 'req-3', 'allow', deps);
  sockets[0]!.open();
  sockets[0]!.reply({ type: 'error', session: 'other', message: 'unrelated' });
  sockets[0]!.reply({ type: 'error', session: 's1', message: 'No such session.' });
  await assert.rejects(done, /No such session\./);
});

test('a connection that drops before the ack, one that cannot open and one that never answers all fail, and say so', async () => {
  const a = harness();
  const dropped = respondTo('s1', 'r', 'allow', a.deps);
  a.sockets[0]!.open();
  a.sockets[0]!.onclose?.();
  await assert.rejects(dropped, /dropped before this was confirmed/);

  const b = harness();
  const unreachable = respondTo('s1', 'r', 'allow', b.deps);
  b.sockets[0]!.onerror?.();
  await assert.rejects(unreachable, /Could not reach the portal/);

  const c = harness(30);
  const silent = respondTo('s1', 'r', 'allow', c.deps);
  c.sockets[0]!.open();
  await assert.rejects(silent, /did not answer/);
  assert.equal(c.sockets[0]!.closed, true);
});

test('settling twice is harmless: a late ack after a timeout changes nothing', async () => {
  const { sockets, deps } = harness(20);
  const done = callChat({ type: 'respond', session: 's', requestId: 'r', decision: 'deny' }, 'r', deps);
  sockets[0]!.open();
  await assert.rejects(done, /did not answer/);
  sockets[0]!.reply({ type: 'ack', uuid: 'r', ok: true }); // handlers are detached: nothing happens
});

test('Stop is the control stop with its own id; Stop on a task is stop_task with the task id', async () => {
  const one = harness();
  const stopped = stopSession('s1', one.deps);
  one.sockets[0]!.open();
  assert.deepEqual(one.sockets[0]!.sent, [{ type: 'control', session: 's1', op: 'stop', uuid: 'u-1' }]);
  one.sockets[0]!.reply({ type: 'ack', uuid: 'u-1', ok: true });
  await stopped;

  const two = harness();
  const task = stopTask('s1', 't9', two.deps);
  two.sockets[0]!.open();
  assert.deepEqual(two.sockets[0]!.sent, [{ type: 'control', session: 's1', op: 'stop_task', uuid: 'u-1', args: { taskId: 't9' } }]);
  two.sockets[0]!.reply({ type: 'ack', uuid: 'u-1', ok: false, error: 'No such task.' });
  await assert.rejects(task, /No such task\./);
});
