// T-781 F1: the production adapter (index.ts) hands the engine the chat controller's `interrupt`. The engine tests use a fake chat that has it;
// this goes through the real wiring, so a missing `interrupt` in the adapter is seen.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Platform } from '../platform/index.js';
import { autoTransferPorts } from './index.js';

test('T-781 F1: the adapter passes interrupt through to the controller, with the chat id', async () => {
  const interrupted: string[] = [];
  const noop = () => undefined;
  const chat = {
    switchClaude: async () => ({}),
    switchOptions: async () => ({}),
    onEvent: () => noop,
    history: () => [],
    list: () => [],
    get: () => null,
    send: async () => undefined,
    interrupt: async (id: string) => void interrupted.push(id),
  };
  const usage = { report: async () => ({ claudes: [] }) };
  const p = autoTransferPorts({ chat, claudeUsage: usage } as unknown as Platform['deps']);
  assert.ok(p, 'the ports are built');
  assert.equal(typeof p.chat.interrupt, 'function', 'the engine can stop a turn in production');
  await p.chat.interrupt!('s9');
  assert.deepEqual(interrupted, ['s9']);
});
