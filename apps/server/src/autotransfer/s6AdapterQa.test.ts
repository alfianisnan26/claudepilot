// QA T-781 S6 (lane-cp-qa-perf): the production adapter (index.ts `autoTransferPorts`) and the hard move's `interrupt`. Written before the run, NOT run
// when committed; expected values come from T-781 comments 7946 and 7939 and from reading ff51fd8d. The builder's t781ports.test.ts is not repeated
// (it covers a plain pass-through with the chat id).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Platform } from '../platform/index.js';
import { autoTransferPorts } from './index.js';

const noop = () => undefined;
const usage = { report: async () => ({ claudes: [] }) };
/** A controller as a class (methods use `this`), with or without `interrupt`. */
class Controller {
  calls: string[] = [];
  async switchClaude() { return {}; }
  async switchOptions() { return {}; }
  onEvent() { return noop; }
  history() { return []; }
  list() { return []; }
  get() { return null; }
  async send() { return undefined; }
}
const ports = (chat: object) => autoTransferPorts({ chat, claudeUsage: usage } as unknown as Platform['deps']);

test('QA-S6-a1 the adapter calls the controller\'s interrupt as a method: `this` is the controller, the id passes through', async () => {
  class WithInterrupt extends Controller {
    async interrupt(id: string) { this.calls.push(id); }
  }
  const c = new WithInterrupt();
  const p = ports(c);
  assert.ok(p, 'ports are built');
  await p.chat.interrupt!('s7');
  assert.deepEqual(c.calls, ['s7'], 'a method that uses this works through the adapter');
});

test('QA-S6-a2 a rejecting interrupt rejects with the same error object; a synchronous throw reaches the caller as that error', async () => {
  const err = new Error('stop failed');
  class Rejecting extends Controller { interrupt() { return Promise.reject(err); } }
  const p = ports(new Rejecting());
  await assert.rejects(Promise.resolve().then(() => p!.chat.interrupt!('s1')), (e) => e === err, 'the rejection is not wrapped or swallowed');
  class Throwing extends Controller { interrupt(): Promise<void> { throw err; } }
  const q = ports(new Throwing());
  let caught: unknown = null;
  try { await q!.chat.interrupt!('s1'); } catch (e) { caught = e; }
  assert.equal(caught, err, 'a sync throw is the same error to the caller');
});

test('QA-S6-a3 a controller WITHOUT interrupt: the ports still build, and calling interrupt never resolves quietly (it throws or rejects, or is absent)', async () => {
  const p = ports(new Controller());
  assert.ok(p, 'the ports are built without interrupt (the rest of auto move must work)');
  const fn = p.chat.interrupt;
  if (fn === undefined) return; // absent is the clean answer
  let outcome: 'resolved' | 'threw' = 'resolved';
  try { await fn('s1'); } catch { outcome = 'threw'; }
  assert.equal(outcome, 'threw', 'a controller that cannot stop a turn must not look like it did');
});

test('QA-S6-a4 the other ports still work through the adapter when interrupt is absent (get, list, history, send)', async () => {
  const p = ports(new Controller());
  assert.ok(p);
  assert.equal(p.chat.get('x'), null);
  assert.deepEqual(p.chat.list(), []);
  assert.deepEqual(p.chat.history('x', 0), []);
  await p.chat.send('x', 'hello', { priority: 'next', actor: 'portal:autotransfer' } as never);
});
