// T-781 F1: the production adapter (index.ts) hands the engine the chat controller's `interrupt`. The engine tests use a fake chat that has it;
// this goes through the real wiring, so a missing `interrupt` in the adapter is seen.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../chat/controller.js';
import type { Platform } from '../platform/index.js';
import { ports } from './index.js';

test('T-781: the real chat controller has `interrupt` (a rename would silently turn the hard move off)', () => {
  assert.equal(typeof ChatController.prototype.interrupt, 'function');
});

test('T-781: a controller without `interrupt` gives the engine no interrupt port (as with modelFamilies)', () => {
  const noop = () => undefined;
  const chat = { switchClaude: async () => ({}), switchOptions: async () => ({}), onEvent: () => noop, history: () => [], list: () => [], get: () => null, send: async () => undefined };
  const p = ports({ chat, claudeUsage: { report: async () => ({ claudes: [] }) } } as unknown as Platform['deps']);
  assert.ok(p);
  assert.equal('interrupt' in p.chat, false);
});

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
  const p = ports({ chat, claudeUsage: usage } as unknown as Platform['deps']);
  assert.ok(p, 'the ports are built');
  assert.equal(typeof p.chat.interrupt, 'function', 'the engine can stop a turn in production');
  await p.chat.interrupt!('s9');
  assert.deepEqual(interrupted, ['s9']);
});
