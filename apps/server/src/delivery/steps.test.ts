import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { DeliveryAccess } from '../workspaces/runtime.js';
import { WorkspaceSteps, type StepResult } from './steps.js';

const WS = 'docker/ws1';

async function setup(running = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-steps-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const ran: { script: string; user?: string; timeoutMs?: number }[] = [];
  const state = { running, reply: { code: 0, stdout: 'ok\n', stderr: '' } };
  const access = {
    state: async () => ({ exists: true, running: state.running }),
    run: async (_name: string, script: string, opts: { user?: 'root' | 'node'; timeoutMs?: number } = {}) => {
      ran.push({ script, user: opts.user, timeoutMs: opts.timeoutMs });
      await new Promise((r) => setTimeout(r, 5));
      return state.reply;
    },
  } as unknown as DeliveryAccess;
  const steps = new WorkspaceSteps(store, () => access);
  const events = () =>
    (store.db!.prepare("SELECT details FROM delivery_events WHERE kind = 'step' ORDER BY id").all() as { details: string }[]).map((r) => JSON.parse(r.details) as Record<string, unknown>);
  return { store, steps, ran, state, events, done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

test('steps run one at a time per workspace, as the workspace user, under a timeout; repeats while queued are dropped (A4)', async () => {
  const h = await setup();
  try {
    const results: StepResult[] = [];
    const step = (key: string) => ({ owner: 'mcpset' as const, key, label: key, script: `echo ${key}`, timeoutMs: 2_000, done: (r: StepResult) => void results.push(r) });
    h.steps.enqueue(WS, [step('a'), step('b')]);
    h.steps.enqueue(WS, [step('b'), step('c')]);
    await h.steps.idle(WS);
    assert.equal(h.ran.length, 3);
    assert.deepEqual(h.ran.map((r) => r.user), ['node', 'node', 'node']);
    assert.equal(h.ran[0]!.script, `exec timeout -k 5 2 sh -c 'echo a'`);
    assert.ok(h.ran[0]!.timeoutMs! > 2_000);
    assert.deepEqual(results.map((r) => r.code), [0, 0, 0]);
    assert.deepEqual(h.events().map((e) => [e.owner, e.step, e.code]), [
      ['mcpset', 'a', 0],
      ['mcpset', 'b', 0],
      ['mcpset', 'c', 0],
    ]);
  } finally {
    h.done();
  }
});

test('steps: output is redacted before anyone sees it; nothing runs in a stopped workspace or a Locked portal', async () => {
  const h = await setup();
  try {
    h.state.reply = { code: 1, stdout: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n', stderr: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' };
    let got: StepResult | null = null;
    h.steps.enqueue(WS, [{ owner: 'mcpset', key: 'x', label: 'x', script: 'true', timeoutMs: 1000, done: (r) => void (got = r) }]);
    await h.steps.idle(WS);
    const r = got as unknown as StepResult;
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /ghp_|abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(JSON.stringify(h.events()), /ghp_abcdef|abcdefghijklmnopqrstuvwxyz123456/);
    h.state.running = false;
    let skipped: StepResult | null = null;
    h.steps.enqueue(WS, [{ owner: 'mcpset', key: 'y', label: 'y', script: 'true', timeoutMs: 1000, done: (res) => void (skipped = res) }]);
    await h.steps.idle(WS);
    assert.deepEqual([(skipped as unknown as StepResult).code, (skipped as unknown as StepResult).skipped], [null, 'not running']);
    assert.equal(h.ran.length, 1);
  } finally {
    h.done();
  }
});
