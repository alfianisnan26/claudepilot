import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { Reconciler } from '../delivery/reconciler.js';
import { SettingsModule } from '../settings/index.js';
import { memoryWorkspace, secretsHarness } from './testkit.js';

// T-285 decision 8: the agent policy wins over a Secrets & env entry with one of its names, and delivery never fails on that conflict.

const WS = 'docker/ws1';
const POLICY = '/etc/claude-code/managed-settings.d/10-claudepilot-policy.json';
const ENV = '/etc/claude-code/managed-settings.d/20-claudepilot-env.json';

async function setup() {
  const h = await secretsHarness();
  const mod = new SettingsModule(h.store, h.providers);
  mod.agentEnv.addOverrideSource((ws) => h.kind.policyOverrides(ws));
  const ws = memoryWorkspace();
  const reconciler = new Reconciler(h.store, () => ws.runtime, () => [ws.runtime], h.providers);
  const json = (path: string) => {
    const f = ws.files.get(path);
    return f ? (JSON.parse(f.content) as { env?: Record<string, string> }) : null;
  };
  return { h, mod, ws, reconciler, json, done: () => (reconciler.stop(), h.done()) };
}

test('a NEW pool entry with a policy name is refused when the set is saved', async () => {
  const t = await setup();
  try {
    assert.throws(
      () => t.h.service.create('secrets', { name: 'limits', content: { entries: [{ kind: 'variable', name: 'BASH_MAX_OUTPUT_LENGTH', value: '99' }] } }),
      (e: unknown) => isAppError(e) && /reserved/.test(e.message + JSON.stringify((e as { details?: unknown }).details ?? {})),
    );
  } finally {
    t.done();
  }
});

test('a set saved before the policy claimed a name still delivers: the entry is skipped, the drop-in carries the policy value, the sheet reports the override, one warning', async () => {
  const t = await setup();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
  try {
    const p = t.h.service.create('secrets', { name: 'agent-limits', content: { entries: [{ kind: 'variable', name: 'REGION', value: 'eu' }] } });
    // As it was saved before T-285: the stored revision also sets BASH_MAX_OUTPUT_LENGTH (the editor refuses that now).
    const row = t.h.store.db!.prepare('SELECT revision, content FROM pool_revisions WHERE pool_id = ? ORDER BY revision DESC LIMIT 1').get(p.id) as { revision: number; content: string };
    const content = JSON.parse(row.content) as { entries: unknown[] };
    content.entries.push({ kind: 'variable', name: 'BASH_MAX_OUTPUT_LENGTH', value: '99' });
    t.h.store.db!.prepare('UPDATE pool_revisions SET content = ? WHERE pool_id = ? AND revision = ?').run(JSON.stringify(content), p.id, row.revision);
    t.h.service.setAssignments(WS, 'secrets', [{ poolId: p.id }]);

    await t.reconciler.request(WS, 'test');
    assert.equal(t.reconciler.row(WS)?.status, 'synced', t.reconciler.row(WS)?.reason ?? '');
    assert.equal(t.json(POLICY)?.env?.BASH_MAX_OUTPUT_LENGTH, '8000');
    assert.deepEqual(t.json(ENV)?.env, { REGION: 'eu' });

    const status = t.mod.agentEnv.status(WS);
    assert.equal(status.state, 'applied');
    assert.deepEqual(
      status.values.filter((v) => v.overriddenPool).map((v) => [v.env, v.overriddenPool, v.applied]),
      [['BASH_MAX_OUTPUT_LENGTH', 'agent-limits', '8000']],
    );

    // A second pass logs nothing new: one warning line per workspace.
    await t.reconciler.request(WS, 'again');
    const lines = warnings.filter((w) => w.includes('BASH_MAX_OUTPUT_LENGTH'));
    assert.equal(lines.length, 1, warnings.join('\n'));
    assert.match(lines[0]!, /docker\/ws1/);
    assert.doesNotMatch(lines[0]!, /99/);
  } finally {
    console.warn = warn;
    t.done();
  }
});
