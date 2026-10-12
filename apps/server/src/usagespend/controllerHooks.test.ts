// The three seams between the chat controller and usage spend, end to end: a real controller on a fake workspace host, a real store, and the
// module wired the way index.ts wires it. What this proves that the unit tests cannot: the hooks are called by the controller, with the same
// turn that was recorded, and the gate refuses a message before anything is stored.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { SettingValue } from '@portal/contracts';
import { ChatController } from '../chat/controller.js';
import { controls, FakeWorkspaces, freshStore, line, ok, sleep, until, USAGE_API_KEY, type Control } from '../chat/testkit.js';
import { settingDef } from '../settings/registry.js';
import type { Workspaces } from '../workspaces/manager.js';
import { UsageSpend } from './service.js';

async function hooked(persona: { id: string; name: string; revision: number } | null) {
  const { store, dataDir } = await freshStore();
  const ws = new FakeWorkspaces();
  const controller = new ChatController(store, ws as unknown as Workspaces);
  const settings = { get: <T extends SettingValue>(key: string): T => settingDef(key)!.default as T };
  const spend = new UsageSpend({ store, settings, personaOf: () => persona, log: () => {} });
  // As index.ts wires them.
  controller.onUsage = (turn, rows) => spend.onTurn(turn, rows);
  controller.onLaunch = (info) => spend.onLaunch(info);
  controller.sendGate = (info) => spend.gate(info);
  const id = (await controller.create({ workspaceId: 'docker/ws1', title: 'Fix the build' })).id;
  await until(() => ws.tails.length === 1);
  await until(() => controller.get(id)?.state === 'idle');
  await sleep(20);
  const seen = new Set<string>();
  const take = async (subtype: string): Promise<Control> => {
    let found: Control | undefined;
    await until(() => !!(found = controls(ws).find((c) => c.request.subtype === subtype && !seen.has(c.id))));
    seen.add(found!.id);
    return found!;
  };
  /** A finished turn: Claude Code's result line, then the answer to the subscription check the controller asks after it. */
  const finishTurn = async (total: number, input: number) => {
    ws.tails[0]!.push(
      line({
        type: 'result',
        subtype: 'success',
        total_cost_usd: total,
        duration_ms: 3000,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: { 'claude-opus-5-5': { inputTokens: input, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: total } },
        is_error: false,
        session_id: id,
      }),
    );
    ws.tails[0]!.push(ok((await take('get_usage')).id, USAGE_API_KEY));
  };
  const done = async () => {
    await controller.end(id).catch(() => undefined);
    controller.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, controller, spend, ws, id, finishTurn, done };
}

test('a process start records the persona; a finished turn is told with the same time it was stored under, and keeps the session’s title', async () => {
  const s = await hooked({ id: 'p1', name: 'Dev', revision: 2 });
  try {
    const persona = s.store.db!.prepare('SELECT persona_id, persona_name, revision FROM usage_persona WHERE session_id = ?').all(s.id).map((r) => ({ ...r }));
    assert.deepEqual(persona, [{ persona_id: 'p1', persona_name: 'Dev', revision: 2 }], 'recorded at the launch, before any request');

    await s.finishTurn(0.1, 100);
    await until(() => (s.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_usage').get() as { n: number }).n === 1);
    const row = { ...(s.store.db!.prepare('SELECT at_ms, session_id, workspace_id, cost_usd, input_tokens FROM chat_usage').get() as Record<string, unknown>) };
    const kept = { ...(s.store.db!.prepare('SELECT title, workspace_id, first_at_ms, last_at_ms FROM usage_sessions WHERE session_id = ?').get(s.id) as Record<string, unknown>) };
    assert.deepEqual(kept, { title: 'Fix the build', workspace_id: 'docker/ws1', first_at_ms: row.at_ms, last_at_ms: row.at_ms }, 'the module was told the very turn that was recorded');
    assert.equal(row.cost_usd, 0.1);

    // The request is attributed to the persona recorded at the launch, and to the session by title.
    const byPersona = s.spend.attribution({ by: 'persona', range: '1h' });
    assert.deepEqual(byPersona.rows.map((r) => [r.key, r.label, r.state, r.total.costUsd]), [['p1', 'Dev', 'known', 0.1]]);
    assert.equal(byPersona.coverage.value, 100);
    assert.deepEqual(s.spend.attribution({ by: 'session', range: '1h' }).rows.map((r) => [r.key, r.label, r.total.requests, r.total.input]), [[s.id, 'Fix the build', 1, 100]]);
  } finally {
    await s.done();
  }
});

test('with no persona assigned the launch records "none", so its requests are "No persona", not "not recorded"', async () => {
  const s = await hooked(null);
  try {
    await s.finishTurn(0.05, 10);
    await until(() => (s.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_usage').get() as { n: number }).n === 1);
    assert.deepEqual(s.spend.attribution({ by: 'persona', range: '1h' }).rows.map((r) => [r.state, r.label, r.total.costUsd]), [['none', 'No persona', 0.05]]);
  } finally {
    await s.done();
  }
});

test('a budget that pauses refuses the next message before anything is stored or sent; alerts only, or a failing gate, let it through', async () => {
  const s = await hooked(null);
  try {
    await s.finishTurn(0.1, 100);
    await until(() => (s.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_usage').get() as { n: number }).n === 1);
    // $0.10 of $0.10 this month on this workspace: used up, and set to pause.
    const b = await s.spend.createBudget({ scope: { kind: 'workspace', id: 'docker/ws1' }, period: 'month', limitUsd: 0.1, mode: 'pause' });
    assert.deepEqual([b.level, b.paused], ['exhausted', true]);
    const sent = () => s.ws.sends.length;
    const stored = (uuid: string) => s.controller.history(s.id).some((e) => e.kind === 'user' && e.uuid === uuid);
    const before = sent();
    const uuid = randomUUID();
    await assert.rejects(s.controller.send(s.id, uuid, 'one more thing'), (e) => isAppError(e) && e.code === 'USAGE_BUDGET' && e.status === 409 && /used up/.test(e.message));
    assert.equal(sent(), before, 'nothing reached Claude Code');
    assert.ok(!stored(uuid), 'and nothing was stored for it');

    // Alerts only: the same message goes through.
    await s.spend.updateBudget(b.budget.id, { mode: 'alert' });
    await s.controller.send(s.id, uuid, 'one more thing');
    assert.ok(stored(uuid));
    assert.ok(sent() > before, 'it reached Claude Code');
    // Paused again, but the gate itself breaks: a gate that fails never blocks a message.
    await s.spend.updateBudget(b.budget.id, { mode: 'pause' });
    s.controller.sendGate = () => {
      throw new Error('the gate broke');
    };
    const other = randomUUID();
    await s.controller.send(s.id, other, 'and this');
    assert.ok(stored(other));
  } finally {
    await s.done();
  }
});
