import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { SETTING_KEYS, type AgentEnvStatus, type SettingsView } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { compile } from '../delivery/compile.js';
import { mayUseEnv } from '../delivery/ownership.js';
import { FOUNDATION, Reconciler, type FragmentProvider } from '../delivery/reconciler.js';
import { memoryWorkspace } from '../secrets/testkit.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { AGENT_ENV, createSettingsRoutes, SettingsModule } from './index.js';

const WS = 'docker/ws1';
const POLICY = '/etc/claude-code/managed-settings.d/10-claudepilot-policy.json';
const NAMES = ['BASH_MAX_OUTPUT_LENGTH', 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'MAX_MCP_OUTPUT_TOKENS'];
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-agentenv-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const mod = new SettingsModule(store, providers);
  const requests: string[] = [];
  mod.reconciler = { request: (id: string) => (requests.push(id), Promise.resolve()), knownWorkspaces: () => ['docker/a', 'docker/b'] };
  mod.lockdown.recheck = () => undefined;
  const ws = memoryWorkspace();
  const reconciler = new Reconciler(store, () => ws.runtime, () => [ws.runtime], providers);
  /** The policy drop-in as the workspace holds it (what Claude Code reads at start). */
  const landed = () => {
    const f = ws.files.get(POLICY);
    return f ? (JSON.parse(f.content) as { env?: Record<string, string> }) : null;
  };
  const compiled = () => {
    const now = new Date();
    const fragments = providers.flatMap((p) => p.fragments(WS, { running: true, now }));
    return compile({ portalId: 'p', generation: 1, fragments: [FOUNDATION, ...fragments], claudeVersion: '2.1.296 (Claude Code)', now });
  };
  const done = () => (reconciler.stop(), store.close(), rmSync(dataDir, { recursive: true, force: true }));
  return { store, mod, settings: mod.settings, agentEnv: mod.agentEnv, requests, ws, reconciler, landed, compiled, done };
}

test('the policy drop-in carries exactly the declared names, with the defaults and their sources', async () => {
  const h = await setup();
  try {
    const file = h.compiled().files.find((f) => f.path === POLICY);
    assert.ok(file, 'the policy drop-in is compiled');
    assert.deepEqual([file.mode, file.uid, file.gid], [0o644, 0, 0]);
    const parsed = JSON.parse(file.content) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ['env']);
    assert.deepEqual(Object.keys(parsed.env as object).sort(), NAMES);
    assert.deepEqual(parsed.env, {
      CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h',
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '5',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3',
      BASH_MAX_OUTPUT_LENGTH: '8000',
      MAX_MCP_OUTPUT_TOKENS: '25000',
    });
    // Every setting names its source and, behind its ⓘ, when a change takes effect (T-302, T-309): the
    // sub-agent values at once for new sub-agents, the output caps at Claude's next start.
    const applies = Object.fromEntries(AGENT_ENV.map((a) => [a.env, a.applies]));
    assert.deepEqual(applies, {
      CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: 'new-subagents',
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: 'new-subagents',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: 'new-subagents',
      BASH_MAX_OUTPUT_LENGTH: 'restart',
      MAX_MCP_OUTPUT_TOKENS: 'restart',
    });
    for (const a of AGENT_ENV) {
      const help = a.def.help ?? '';
      assert.match(help, /Source: /, a.def.key);
      assert.match(help, new RegExp(a.env), a.def.key);
      if (a.applies === 'new-subagents') {
        assert.match(help, /applies at once to new sub-agents; ones already running keep theirs\./, a.def.key);
        assert.doesNotMatch(help, /next start/, a.def.key);
      } else {
        assert.match(help, /Read when Claude starts: a running Claude takes a change at its next start \(a new chat or a Restart\)\./, a.def.key);
        assert.doesNotMatch(help, /at once/, a.def.key);
      }
    }
  } finally {
    h.done();
  }
});

test('a changed value reaches the workspace; one set back to its default is overwritten with it, never removed', async () => {
  const h = await setup();
  try {
    h.settings.set(SETTING_KEYS.agentsMaxSubagents, 8, { actor: 'Admin' });
    h.settings.set(SETTING_KEYS.agentsSubagentCacheTtl, '5m', { actor: 'Admin' });
    await h.reconciler.request(WS, 'test');
    assert.equal(h.reconciler.row(WS)?.status, 'synced');
    assert.equal(h.landed()?.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '8');
    assert.equal(h.landed()?.env?.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, '5m');

    h.settings.set(SETTING_KEYS.agentsMaxSubagents, 5, { actor: 'Admin' });
    h.settings.set(SETTING_KEYS.agentsSubagentCacheTtl, '1h', { actor: 'Admin' });
    await h.reconciler.request(WS, 'test');
    assert.deepEqual(Object.keys(h.landed()?.env ?? {}).sort(), NAMES);
    assert.equal(h.landed()?.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '5');
    assert.equal(h.landed()?.env?.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, '1h');
  } finally {
    h.done();
  }
});

test('a change to an agent setting asks every known workspace to deliver again', async () => {
  const h = await setup();
  try {
    h.settings.set(SETTING_KEYS.agentsBashOutputMax, 6000, { actor: 'Admin' });
    assert.deepEqual(h.requests, ['docker/a', 'docker/b']);
  } finally {
    h.done();
  }
});

test('the values are checked: whole numbers in range, the cache only 5m or 1h', async () => {
  const h = await setup();
  try {
    assert.throws(() => h.settings.set(SETTING_KEYS.agentsMaxSubagents, 2.5, { actor: 'Admin' }), code('VALIDATION_FAILED'));
    assert.throws(() => h.settings.set(SETTING_KEYS.agentsMaxSubagents, 0, { actor: 'Admin' }), code('VALIDATION_FAILED'));
    assert.throws(() => h.settings.set(SETTING_KEYS.agentsSpawnDepth, 11, { actor: 'Admin' }), code('VALIDATION_FAILED'));
    assert.throws(() => h.settings.set(SETTING_KEYS.agentsSubagentCacheTtl, '2h', { actor: 'Admin' }), code('VALIDATION_FAILED'));
    const view = h.settings.view().settings.find((s) => s.key === SETTING_KEYS.agentsSubagentCacheTtl);
    assert.deepEqual([view?.group, view?.choices, view?.value], ['agents', ['5m', '1h'], '1h']);
  } finally {
    h.done();
  }
});

test('pools cannot set a policy name: the env registry refuses it to Secrets & env, and the compiler refuses the fragment', async () => {
  for (const name of NAMES) {
    assert.equal(mayUseEnv('secrets', name), false, name);
    assert.equal(mayUseEnv('policy', name), true, name);
  }
  // A name the policy does not declare stays free for a pool.
  assert.equal(mayUseEnv('secrets', 'ENABLE_PROMPT_CACHING_1H'), true);
  const now = new Date();
  const base = { portalId: 'p', generation: 1, claudeVersion: '2.1.296 (Claude Code)', now };
  assert.throws(
    () => compile({ ...base, fragments: [FOUNDATION, { owner: 'secrets', pool: { id: 's1', revision: 1 }, settings: { env: { BASH_MAX_OUTPUT_LENGTH: '99' } } }] }),
    /may not set env BASH_MAX_OUTPUT_LENGTH/,
  );
});

test('status per workspace: unavailable until the drop-in lands, applied after, pending while a change is on its way', async () => {
  const h = await setup();
  try {
    const before = h.agentEnv.status(WS);
    assert.equal(before.state, 'unavailable');
    assert.ok(before.values.every((v) => v.applied === null));
    assert.equal(before.appliedAt, null);

    await h.reconciler.request(WS, 'test');
    const after = h.agentEnv.status(WS);
    assert.equal(after.state, 'applied');
    assert.deepEqual(after.values.find((v) => v.env === 'MAX_MCP_OUTPUT_TOKENS'), { key: SETTING_KEYS.agentsMcpOutputMax, env: 'MAX_MCP_OUTPUT_TOKENS', applies: 'restart', desired: '25000', applied: '25000', overriddenPool: null });
    assert.equal(after.values.find((v) => v.env === 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS')?.applies, 'new-subagents');
    assert.ok(after.appliedAt);

    h.settings.set(SETTING_KEYS.agentsMcpOutputMax, 10000, { actor: 'Admin' });
    const pending = h.agentEnv.status(WS);
    assert.equal(pending.state, 'pending');
    assert.deepEqual(pending.values.find((v) => v.env === 'MAX_MCP_OUTPUT_TOKENS'), { key: SETTING_KEYS.agentsMcpOutputMax, env: 'MAX_MCP_OUTPUT_TOKENS', applies: 'restart', desired: '10000', applied: '25000', overriddenPool: null });

    await h.reconciler.request(WS, 'test');
    assert.equal(h.agentEnv.status(WS).state, 'applied');
    h.agentEnv.forgetWorkspace(WS);
    assert.equal(h.agentEnv.status(WS).state, 'unavailable');
  } finally {
    h.done();
  }
});

test('routes: the Agents settings are listed, and a workspace’s agent policy has its own route', async () => {
  const h = await setup();
  try {
    const app = new Hono();
    app.onError((err, c) => (isAppError(err) ? c.json({ success: false, error: { code: err.code } }, err.status as ContentfulStatusCode) : c.json({}, 500)));
    app.route('/api/settings', createSettingsRoutes(h.mod));
    const get = async <T>(path: string) => ((await (await app.request(path)).json()) as { data: T }).data;
    const list = await get<SettingsView>('/api/settings');
    const agents = list.settings.filter((s) => s.group === 'agents').map((s) => s.key);
    for (const a of AGENT_ENV) assert.ok(agents.includes(a.def.key), a.def.key);
    const status = await get<AgentEnvStatus>('/api/settings/agent-env/docker/ws1');
    assert.deepEqual([status.workspaceId, status.state, status.values.length], [WS, 'unavailable', NAMES.length]);
    const bad = await app.request(`/api/settings/${SETTING_KEYS.agentsSubagentCacheTtl}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: '10m' }) });
    assert.equal(bad.status, 422);
  } finally {
    h.done();
  }
});
