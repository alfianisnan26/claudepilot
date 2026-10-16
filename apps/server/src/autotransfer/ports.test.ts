// T-723 S3b (G1): the engine's model change goes to the chat controller as the engine (`portal:autotransfer`), not as the default `portal`.
// The engine tests fake the chat port whole, so the adapter in index.ts (the one place that calls `control`) is under test here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Platform } from '../platform/index.js';
import { ENGINE_ACTOR } from './engine.js';
import { ports } from './index.js';

test('T-723 S3b: setModel asks the controller for the model as ENGINE_ACTOR', async () => {
  const asked: { id: string; op: string; args: unknown; actor: string | undefined }[] = [];
  const noop = () => undefined;
  const chat = {
    get: noop,
    list: () => [],
    switchOptions: noop,
    switchClaude: noop,
    onEvent: noop,
    history: noop,
    send: noop,
    control: async (id: string, op: string, args: unknown, opts?: { actor?: string }) => void asked.push({ id, op, args, actor: opts?.actor }), // `opts?`: a dropped actor fails the assertion below, not with a crash
  };
  const usage = { report: noop };
  const p = ports({ chat, claudeUsage: usage } as unknown as Platform['deps']);
  assert.ok(p, 'the ports were built');
  await p.chat.setModel('chat-1', 'sonnet');
  assert.deepEqual(asked, [{ id: 'chat-1', op: 'model', args: { model: 'sonnet' }, actor: ENGINE_ACTOR }]);
  assert.equal(ENGINE_ACTOR, 'portal:autotransfer');
});
