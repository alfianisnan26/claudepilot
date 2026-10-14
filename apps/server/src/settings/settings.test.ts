import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { SETTING_KEYS, type LockdownStatus, type SettingChange, type SettingsView } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { compile } from '../delivery/compile.js';
import { FOUNDATION, Reconciler, type FragmentProvider } from '../delivery/reconciler.js';
import { memoryWorkspace } from '../secrets/testkit.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { createSettingsRoutes, defineSetting, SettingsModule } from './index.js';

const WS = 'docker/ws1';
const DROP_IN = '/etc/claude-code/managed-settings.d/05-claudepilot-settings.json';
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-settings-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const mod = new SettingsModule(store, providers);
  const requests: string[] = [];
  mod.reconciler = { request: (id: string) => (requests.push(id), Promise.resolve()), knownWorkspaces: () => ['docker/a', 'docker/b'] };
  // The module asks for a second pass soon after a change; the tests make that pass themselves.
  const rechecks: string[] = [];
  mod.lockdown.recheck = (id) => void rechecks.push(id);
  const ws = memoryWorkspace();
  const reconciler = new Reconciler(store, () => ws.runtime, () => [ws.runtime], providers);
  const compiled = (id = WS) => {
    const now = new Date();
    const fragments = providers.flatMap((p) => p.fragments(id, { running: true, now }));
    return compile({ portalId: 'p', generation: 1, fragments: [FOUNDATION, ...fragments], claudeVersion: '2.1.296 (Claude Code)', now });
  };
  const dropIn = (id = WS) => {
    const f = compiled(id).files.find((x) => x.path === DROP_IN);
    return f ? (JSON.parse(f.content) as Record<string, unknown>) : null;
  };
  const done = () => (reconciler.stop(), store.close(), rmSync(dataDir, { recursive: true, force: true }));
  return { store, mod, settings: mod.settings, lockdown: mod.lockdown, providers, requests, rechecks, ws, reconciler, compiled, dropIn, dataDir, done };
}
type H = Awaited<ReturnType<typeof setup>>;
const on = (h: H, key: string) => h.settings.set(key, true, { actor: 'Admin' });

/* ---------- The store ---------- */

test('defaults, types and the audit trail: a change is stored, audited with who made it, and a repeat changes nothing', async () => {
  const h = await setup();
  try {
    assert.equal(h.settings.get(SETTING_KEYS.mcpPoolOnly), false);
    assert.throws(() => h.settings.get('nope.such'), /No setting named/);
    assert.throws(() => h.settings.set(SETTING_KEYS.mcpPoolOnly, 'yes', { actor: 'Admin' }), (e) => code('VALIDATION_FAILED')(e) && /Send a boolean/.test((e as Error).message));
    assert.throws(() => h.settings.set('nope.such', true, { actor: 'Admin' }), code('NOT_FOUND'));

    const set = h.settings.set(SETTING_KEYS.mcpPoolOnly, true, { actor: 'Admin' });
    assert.deepEqual([set.value, set.updatedBy, typeof set.updatedAt], [true, 'Admin', 'string']);
    assert.equal(h.settings.get(SETTING_KEYS.mcpPoolOnly), true);
    h.settings.set(SETTING_KEYS.mcpPoolOnly, true, { actor: 'Admin' });
    const audit = h.settings.audit();
    assert.equal(audit.length, 1, 'setting the same value again is not a change');
    assert.deepEqual([audit[0]!.key, audit[0]!.oldValue, audit[0]!.newValue, audit[0]!.actor], [SETTING_KEYS.mcpPoolOnly, false, true, 'Admin']);

    // It survives a restart of the portal.
    h.store.close();
    const again = await Store.open({ dataDir: h.dataDir, secretKey: parseSecretKey(generateSecretKey()) });
    const second = new SettingsModule(again, []);
    assert.equal(second.settings.get(SETTING_KEYS.mcpPoolOnly), true);
    again.close();
  } finally {
    rmSync(h.dataDir, { recursive: true, force: true });
  }
});

test('a security switch moved away from its protective value needs a confirmation, which the server enforces; turning protection on never does', async () => {
  const h = await setup();
  try {
    // Account MCP off: false is the default; switching the protection on needs nothing.
    on(h, SETTING_KEYS.mcpAccountOff);
    assert.throws(() => h.settings.set(SETTING_KEYS.mcpAccountOff, false, { actor: 'Admin' }), (e) => code('CONFIRMATION_REQUIRED')(e));
    assert.equal(h.settings.get(SETTING_KEYS.mcpAccountOff), true, 'refused, so unchanged');
    assert.throws(() => h.settings.set(SETTING_KEYS.mcpAccountOff, false, { actor: 'Admin', confirm: false }), code('CONFIRMATION_REQUIRED'));
    h.settings.set(SETTING_KEYS.mcpAccountOff, false, { actor: 'Admin', confirm: true });
    assert.equal(h.settings.get(SETTING_KEYS.mcpAccountOff), false);
    // Agents may propose: the protective value is OFF, so turning it ON is what asks.
    assert.throws(() => on(h, SETTING_KEYS.agentsSelfEdit), code('CONFIRMATION_REQUIRED'));
    h.settings.set(SETTING_KEYS.agentsSelfEdit, true, { actor: 'Admin', confirm: true });
    h.settings.set(SETTING_KEYS.agentsSelfEdit, false, { actor: 'Admin' });
    assert.deepEqual(h.settings.audit().map((c) => [c.key, c.newValue]), [
      [SETTING_KEYS.agentsSelfEdit, false],
      [SETTING_KEYS.agentsSelfEdit, true],
      [SETTING_KEYS.mcpAccountOff, false],
      [SETTING_KEYS.mcpAccountOff, true],
    ]);
  } finally {
    h.done();
  }
});

test('other areas define their own settings, and the page lists them in order, by group', async () => {
  const h = await setup();
  try {
    defineSetting({ key: 'sessions.bypassLocked', type: 'boolean', default: true, scope: 'global', group: 'sessions', label: 'Lock Bypass', help: 'Sessions can’t use Bypass.', protective: true });
    defineSetting({ key: 'sessions.idleMinutes', type: 'number', default: 30, scope: 'global', group: 'sessions', label: 'Idle sleep', min: 1, max: 600, order: 20 });
    assert.doesNotThrow(() => defineSetting({ key: 'sessions.idleMinutes', type: 'number', default: 30, scope: 'global', group: 'sessions', label: 'Idle sleep', min: 1, max: 600, order: 20 }), 'the same definition twice is fine');
    assert.throws(() => defineSetting({ key: 'sessions.idleMinutes', type: 'number', default: 60, scope: 'global', group: 'sessions', label: 'Idle sleep' }), /already defined differently/);
    assert.throws(() => defineSetting({ key: 'Bad Key', type: 'boolean', default: false, scope: 'global', group: 'x', label: 'x' }), /group\.name/);
    assert.throws(() => defineSetting({ key: 'x.y', type: 'boolean', default: 'no' as never, scope: 'global', group: 'x', label: 'x' }), /must be a boolean/);

    const view = h.settings.view();
    assert.deepEqual(view.groups.map((g) => g.id), ['mcp', 'agents', 'sessions']);
    assert.deepEqual(view.settings.filter((s) => s.group === 'mcp').map((s) => [s.key, s.label, s.protective]), [
      [SETTING_KEYS.mcpAccountOff, 'Account MCP off', true],
      [SETTING_KEYS.mcpPoolOnly, 'Pool MCP only', true],
    ]);
    assert.ok(view.settings.every((s) => s.group !== 'mcp' || !!s.help), 'every switch explains itself behind its ⓘ');
    // Number ranges.
    assert.throws(() => h.settings.set('sessions.idleMinutes', 0, { actor: 'Admin' }), field);
    assert.throws(() => h.settings.set('sessions.idleMinutes', 601, { actor: 'Admin' }), field);
    assert.equal(h.settings.set('sessions.idleMinutes', 45, { actor: 'Admin' }).value, 45);
  } finally {
    h.done();
  }
});
const field = (e: unknown) => isAppError(e) && !!(e.details as Record<string, string> | undefined)?.value;

test('a change to an MCP switch asks every known workspace to deliver again; other settings do not', async () => {
  const h = await setup();
  try {
    on(h, SETTING_KEYS.mcpPoolOnly);
    assert.deepEqual(h.requests, ['docker/a', 'docker/b']);
    h.requests.length = 0;
    h.settings.set(SETTING_KEYS.agentsSelfEdit, true, { actor: 'Admin', confirm: true });
    assert.deepEqual(h.requests, []);
  } finally {
    h.done();
  }
});

/* ---------- The lockdown's delivery ---------- */

test('both switches off: nothing is written. Account MCP off writes disableClaudeAiConnectors and nothing else', async () => {
  const h = await setup();
  try {
    assert.equal(h.dropIn(), null);
    on(h, SETTING_KEYS.mcpAccountOff);
    assert.deepEqual(h.dropIn(), { disableClaudeAiConnectors: true });
    // Root-owned and world-readable: Claude Code reads it as the workspace user.
    const f = h.compiled().files.find((x) => x.path === DROP_IN)!;
    assert.deepEqual([f.mode, f.uid, f.gid], [0o644, 0, 0]);
    h.settings.set(SETTING_KEYS.mcpAccountOff, false, { actor: 'Admin', confirm: true });
    assert.equal(h.dropIn(), null, 'and back to nothing');
  } finally {
    h.done();
  }
});

test('Pool MCP only: managed-only, with exactly the matchers the pools report, each once in a stable order; none means an empty allowlist', async () => {
  const h = await setup();
  try {
    on(h, SETTING_KEYS.mcpPoolOnly);
    // No source reports anything: an empty allowlist blocks every MCP server (✅ 2.1.296: "No MCP servers configured").
    assert.deepEqual(h.dropIn(), { allowManagedMcpServersOnly: true, allowedMcpServers: [] });

    const launcher = { serverCommand: ['/etc/claudepilot/bin/mcp-launch', 'cpm-team/linear', '--', 'npm:@x/y@1.0.0'] };
    const portal = { serverUrl: 'http://host.docker.internal:3000/mcp' };
    h.lockdown.addMatcherSource((ws) => (ws === WS ? [launcher, portal] : []));
    h.lockdown.addMatcherSource(() => [portal, { serverUrl: 'https://mcp.example.com/mcp' }]);
    assert.deepEqual(h.dropIn(), {
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [launcher, { serverUrl: 'https://mcp.example.com/mcp' }, portal].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    });
    assert.deepEqual(h.dropIn('docker/other'), { allowManagedMcpServersOnly: true, allowedMcpServers: [portal, { serverUrl: 'https://mcp.example.com/mcp' }].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }, 'per workspace');

    // Both on: both keys, in one drop-in.
    on(h, SETTING_KEYS.mcpAccountOff);
    assert.equal(h.dropIn()?.disableClaudeAiConnectors, true);
    assert.equal(h.dropIn()?.allowManagedMcpServersOnly, true);
  } finally {
    h.done();
  }
});

test('a source that fails must not widen the allowlist: its servers are just not admitted, and delivery goes on', async () => {
  const h = await setup();
  try {
    on(h, SETTING_KEYS.mcpPoolOnly);
    const ok = { serverUrl: 'https://mcp.example.com/mcp' };
    h.lockdown.addMatcherSource(() => {
      throw new Error('boom');
    });
    h.lockdown.addMatcherSource(() => [ok]);
    const errors: string[] = [];
    const log = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(' '));
    try {
      assert.deepEqual(h.dropIn()?.allowedMcpServers, [ok]);
    } finally {
      console.error = log;
    }
    assert.ok(errors.some((e) => /matcher source failed/.test(e)));
  } finally {
    h.done();
  }
});

test('the ownership check: only matchers (never a server name), only true, only the settings owner’s own keys', async () => {
  const now = new Date();
  const build = (settings: Record<string, unknown>) => compile({ portalId: 'p', generation: 1, claudeVersion: '2.1.296 (Claude Code)', now, fragments: [{ owner: 'settings', settings }] });
  assert.doesNotThrow(() => build({ allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverUrl: 'https://x.example/mcp' }, { serverCommand: ['a', 'b'] }] }));
  assert.throws(() => build({ allowedMcpServers: [{ serverName: 'pilot' }] }), /only be \{ serverUrl \} or \{ serverCommand \}/);
  assert.throws(() => build({ allowedMcpServers: [{ serverUrl: 'https://x', serverCommand: ['a'] }] }), /only be/);
  assert.throws(() => build({ allowedMcpServers: [{ serverCommand: [] }] }), /serverCommand/);
  assert.throws(() => build({ allowedMcpServers: [{ serverCommand: ['a', 3] }] }), /serverCommand/);
  assert.throws(() => build({ allowedMcpServers: 'all' }), /must be a list/);
  assert.throws(() => build({ allowManagedMcpServersOnly: false }), /may only be true/);
  assert.throws(() => build({ disableClaudeAiConnectors: 'yes' }), /may only be true/);
  assert.throws(() => build({ permissions: { allow: ['Bash(*)'] } }), /may not set permissions/);
  assert.throws(() => build({ env: { X: '1' } }), /may not set env/);
  // And nobody else sets them.
  assert.throws(() => compile({ portalId: 'p', generation: 1, claudeVersion: '2.1.296 (Claude Code)', now, fragments: [{ owner: 'mcpset', settings: { allowManagedMcpServersOnly: true } }] }), /may not set/);
  assert.throws(() => compile({ portalId: 'p', generation: 1, claudeVersion: '2.1.296 (Claude Code)', now, fragments: [{ owner: 'policy', settings: { allowedMcpServers: [] } }] }), /may not set/);
});

/* ---------- Status ---------- */

test('status per workspace: Pending until delivered, then until the sessions that predate it are counted and gone; Locked after; Not protected when delivery fails', async () => {
  const h = await setup();
  try {
    assert.equal(h.lockdown.status(WS).state, 'off');
    on(h, SETTING_KEYS.mcpPoolOnly);
    assert.deepEqual([h.lockdown.status(WS).state, h.lockdown.status(WS).reason], ['pending', 'Not delivered yet.']);

    // A session is running that started 5 minutes ago, before the lockdown reached the workspace.
    h.ws.state.ages = [300];
    await h.reconciler.request(WS, 'test');
    assert.equal(h.reconciler.row(WS)?.status, 'synced', h.reconciler.row(WS)?.reason ?? '');
    assert.equal(h.ws.files.has(DROP_IN), true);
    // The pass that wrote it read the sessions BEFORE writing, so it can't say which it missed: not Locked, and another pass is asked for.
    const checking = h.lockdown.status(WS);
    assert.deepEqual([checking.state, checking.restart, checking.reason], ['pending', 0, 'Checking the running sessions.']);
    assert.deepEqual(h.rechecks, [WS]);
    // The next pass reads them again, after the write.
    await h.reconciler.request(WS, 'check');
    const pending = h.lockdown.status(WS);
    assert.deepEqual([pending.state, pending.restart], ['pending', 1]);
    assert.match(pending.reason!, /1 running session started before the change: restart it\./);
    assert.equal(h.rechecks.length, 1, 'no more checks asked for');

    // It ends (or restarts): the workspace is Locked.
    h.ws.state.ages = [];
    await h.reconciler.request(WS, 'timer');
    assert.deepEqual([h.lockdown.status(WS).state, h.lockdown.status(WS).restart], ['locked', 0]);

    // Ages are whole seconds, so a session 1 s old might predate a change made a moment ago: it counts. One that
    // is younger than the change by a clear margin does not (the change is moved back to ten minutes ago here).
    h.store.db!.prepare('UPDATE lockdown_state SET changed_at = ? WHERE workspace_id = ?').run(new Date(Date.now() - 600_000).toISOString(), WS);
    h.ws.state.ages = [1];
    await h.reconciler.request(WS, 'timer');
    assert.equal(h.lockdown.status(WS).state, 'locked');
    h.ws.state.ages = [601];
    await h.reconciler.request(WS, 'timer');
    assert.deepEqual([h.lockdown.status(WS).state, h.lockdown.status(WS).restart], ['pending', 1]);
    h.ws.state.ages = [];
    await h.reconciler.request(WS, 'timer');

    // A change of the allowlist (a pool server arrives) is a new change: on its way, then checked again.
    h.lockdown.addMatcherSource(() => [{ serverUrl: 'https://mcp.example.com/mcp' }]);
    assert.deepEqual([h.lockdown.status(WS).state, h.lockdown.status(WS).reason], ['pending', 'A change is on its way.']);
    h.ws.state.ages = [600, 1];
    await h.reconciler.request(WS, 'pool changed');
    assert.equal(h.lockdown.status(WS).reason, 'Checking the running sessions.');
    await h.reconciler.request(WS, 'check');
    assert.deepEqual([h.lockdown.status(WS).state, h.lockdown.status(WS).restart], ['pending', 2], 'both could predate the change');

    // Delivery that fails can't hold it.
    h.store.db!.prepare("UPDATE workspace_delivery SET status = 'failed', reason = 'exec failed' WHERE workspace_id = ?").run(WS);
    assert.deepEqual([h.lockdown.status(WS).state, h.lockdown.status(WS).reason], ['not_protected', 'Delivery failed: exec failed']);
    h.store.db!.prepare("UPDATE workspace_delivery SET status = 'locked', reason = NULL WHERE workspace_id = ?").run(WS);
    assert.equal(h.lockdown.status(WS).state, 'not_protected');
    h.store.db!.prepare("UPDATE workspace_delivery SET status = 'synced', claude_version = '2.1.200 (Claude Code)' WHERE workspace_id = ?").run(WS);
    assert.match(h.lockdown.status(WS).reason!, /Claude Code 2\.1\.200 is too old/);

    // Switched off: no line, and the state is forgotten once it's delivered.
    h.settings.set(SETTING_KEYS.mcpPoolOnly, false, { actor: 'Admin', confirm: true });
    assert.equal(h.lockdown.status(WS).state, 'off');
  } finally {
    h.done();
  }
});

test('a stopped workspace has no sessions to restart: it is Locked as soon as the files are in place', async () => {
  const h = await setup();
  try {
    on(h, SETTING_KEYS.mcpAccountOff);
    h.ws.state.running = false;
    h.ws.state.ages = [999];
    await h.reconciler.request(WS, 'test');
    assert.equal(h.reconciler.row(WS)?.status, 'synced');
    assert.deepEqual([h.lockdown.status(WS).state, h.lockdown.status(WS).restart], ['locked', 0]);
  } finally {
    h.done();
  }
});

/* ---------- Routes ---------- */

test('routes: list, one change with the confirmation the server enforces, the audit trail and a workspace’s status', async () => {
  const h = await setup();
  try {
    const app = new Hono<{ Variables: { token: string } }>();
    // A stand-in for the sign-in guard (app.ts sets the session token): the routes ask the seam, which answers the owner (T-329).
    app.use(async (c, next) => (c.set('token', 'signed-in'), next()));
    app.onError((err, c) => (isAppError(err) ? c.json({ success: false, error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode) : c.json({}, 500)));
    app.route('/api/settings', createSettingsRoutes(h.mod));
    const call = async <T>(method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const json = (await res.json()) as { data?: T; error?: { code: string } };
      return { status: res.status, data: json.data as T, error: json.error };
    };
    const list = await call<SettingsView>('GET', '/api/settings');
    assert.equal(list.status, 200);
    assert.ok(list.data.settings.some((s) => s.key === SETTING_KEYS.mcpPoolOnly && s.value === false && s.protective === true));

    assert.equal((await call('PUT', `/api/settings/${SETTING_KEYS.mcpPoolOnly}`, { value: true })).status, 200);
    const refused = await call('PUT', `/api/settings/${SETTING_KEYS.mcpPoolOnly}`, { value: false });
    assert.deepEqual([refused.status, refused.error?.code], [409, 'CONFIRMATION_REQUIRED']);
    assert.equal((await call('PUT', `/api/settings/${SETTING_KEYS.mcpPoolOnly}`, { value: false, confirm: true })).status, 200);
    assert.equal((await call('PUT', '/api/settings/nope.such', { value: true })).status, 404);
    assert.equal((await call('PUT', `/api/settings/${SETTING_KEYS.mcpPoolOnly}`, {})).status, 422);

    const audit = await call<SettingChange[]>('GET', '/api/settings/audit?limit=5');
    assert.deepEqual(audit.data.map((c) => c.newValue), [false, true]);
    assert.equal(audit.data[0]!.actor, 'Admin');
    on(h, SETTING_KEYS.mcpAccountOff);
    const status = await call<LockdownStatus>('GET', `/api/settings/lockdown/docker/ws1`);
    assert.deepEqual([status.data.workspaceId, status.data.accountOff, status.data.poolOnly, status.data.state], [WS, true, false, 'pending']);
  } finally {
    h.done();
  }
});

/* ---------- Taking it away ---------- */

test('switched off, the drop-in goes after the delivery grace, or at once when a session starts; switched on again within the grace, it stays', async () => {
  const h = await setup();
  try {
    on(h, SETTING_KEYS.mcpPoolOnly);
    await h.reconciler.request(WS, 'test');
    assert.equal(h.ws.files.has(DROP_IN), true);
    h.settings.set(SETTING_KEYS.mcpPoolOnly, false, { actor: 'Admin', confirm: true });
    await h.reconciler.request(WS, 'settings');
    assert.equal(h.ws.files.has(DROP_IN), true, 'kept through the grace period');
    assert.equal(h.lockdown.status(WS).state, 'off', 'though the page already says it is off');
    // Switched on again in time: nothing is deleted.
    on(h, SETTING_KEYS.mcpPoolOnly);
    await h.reconciler.request(WS, 'started');
    assert.equal(h.ws.files.has(DROP_IN), true);
    // Off, and a session starts: the file goes.
    h.settings.set(SETTING_KEYS.mcpPoolOnly, false, { actor: 'Admin', confirm: true });
    await h.reconciler.request(WS, 'settings');
    await h.reconciler.request(WS, 'started');
    assert.equal(h.ws.files.has(DROP_IN), false, 'removed at the next start');
  } finally {
    h.done();
  }
});
