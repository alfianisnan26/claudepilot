import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { McpCatalogEntry, McpSetContent } from '@portal/contracts';
import { compile } from '../delivery/compile.js';
import { FOUNDATION, type FragmentProvider } from '../delivery/reconciler.js';
import type { StepResult, WorkspaceStep, WorkspaceSteps } from '../delivery/steps.js';
import { MARKETPLACE_JSON, type Fragment } from '../delivery/types.js';
import { References, type SecretName } from '../pools/references.js';
import { PoolService } from '../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { McpSets } from './index.js';

const WS = 'docker/e2e-mcp-a';
const WS2 = 'docker/e2e-mcp-b';
const MCP_DROPIN = '/etc/claude-code/managed-settings.d/30-claudepilot-mcp.json';
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-mcp-kind-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const pools = new PoolService(store, { providers });
  const references = new References();
  // A fake Secrets & env (the real one registers itself the same way).
  const names = new Map<string, Map<string, SecretName>>();
  references.provideSecretNames({ namesFor: (ws) => names.get(ws) ?? new Map() });
  const give = (ws: string, ...list: string[]) => names.set(ws, new Map(list.map((n) => [n, { kind: 'secret', file: true, variable: false }])));
  const requests: { id: string; why: string }[] = [];
  pools.reconciler = { request: (id: string, why = '') => (requests.push({ id, why }), Promise.resolve()) };
  const queued: { ws: string; step: WorkspaceStep }[] = [];
  const steps = { enqueue: (ws: string, list: WorkspaceStep[]) => list.forEach((step) => queued.push({ ws, step })), queued: () => [] } as unknown as WorkspaceSteps;
  const mcp = new McpSets(store, pools, references, () => undefined, { resolveDns: false, steps });
  const provider = providers.find((p) => p.type === 'mcpset')!;
  const done = () => (store.close(), rmSync(dataDir, { recursive: true, force: true }));
  return { store, pools, references, mcp, provider, give, requests, queued, done };
}
type H = Awaited<ReturnType<typeof setup>>;

async function memory(h: H, version = '1.0.0'): Promise<McpCatalogEntry> {
  const e = await h.mcp.catalog.create({
    key: 'memory',
    displayName: 'Memory',
    kind: 'npm',
    version,
    spec: { package: '@modelcontextprotocol/server-memory', args: ['--quiet'] },
    slots: [
      { name: 'DEMO_TOKEN', target: 'env', secret: true, required: true },
      { name: 'MEMORY_FILE_PATH', target: 'env', default: '/home/node/.memory.json' },
    ],
  });
  return h.mcp.catalog.approve(e.id, e.versions[0]!.id, { reviewed: true });
}

async function remote(h: H, key = 'lab', url = 'https://mcp.example.com/mcp'): Promise<McpCatalogEntry> {
  const e = await h.mcp.catalog.create({
    key,
    displayName: `Remote ${key}`,
    kind: 'remote',
    spec: { url, auth: 'headers' },
    slots: [{ name: 'Authorization', target: 'header', secret: true, required: true, template: 'Bearer {value}' }],
  });
  return h.mcp.catalog.approve(e.id, e.versions[0]!.id, { reviewed: true });
}

const server = (e: McpCatalogEntry, key: string, secrets: Record<string, string>, over: Record<string, unknown> = {}) => ({
  key,
  entry: e.id,
  version: e.versions.find((v) => v.reviewState === 'approved')?.version ?? e.versions[0]!.version,
  enabled: true,
  config: {},
  secrets,
  ...over,
});

/** Compiles the workspace through the provider and the real delivery compiler (ownership checks included). */
function deliver(h: H, ws = WS, running = true) {
  const now = new Date();
  const fragments = h.provider.fragments(ws, { running, now });
  const bundle = compile({ portalId: 'p', generation: 1, fragments: [FOUNDATION, ...fragments], claudeVersion: '2.1.296 (Claude Code)', now });
  return { fragments, bundle, now };
}
const file = (b: ReturnType<typeof compile>, path: string) => [...b.files, ...b.plugins.flatMap((p) => p.files)].find((f) => f.path === path || f.path.endsWith(path))?.content;
const pluginFile = (b: ReturnType<typeof compile>, plugin: string, path: string) => b.plugins.find((p) => p.name === plugin)?.files.find((f) => f.path.endsWith(`/${path}`))?.content;

/* ---------- Content ---------- */

test('sets: the slug comes from the name, is unique, and is fixed once a workspace has the set (FR5)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const team = h.pools.create('mcpset', { name: 'Team tools', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'DEMO' })] } });
    assert.equal((team.content as McpSetContent).slug, 'team-tools');
    assert.throws(() => h.pools.create('mcpset', { name: 'Other', content: { slug: 'team-tools', servers: [] } }), code('CONFLICT'));
    // Duplicating carries the slug over: the copy gets its own.
    const copy = h.pools.duplicate(team.id, 'Team tools copy');
    assert.equal((copy.content as McpSetContent).slug, 'team-tools-2');
    // Renaming the slug works until delivered.
    h.pools.update(copy.id, { content: { ...(copy.content as McpSetContent), slug: 'copy' } });
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: team.id }]);
    h.give(WS, 'DEMO');
    deliver(h);
    assert.throws(() => h.pools.update(team.id, { content: { ...(team.content as McpSetContent), slug: 'renamed' } }), /fixed once a workspace has the set/);
  } finally {
    h.done();
  }
});

test('sets: servers point at approved versions; deprecated and revoked ones only stay where they were (FR4, FR13)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const draft = await h.mcp.catalog.addVersion(m.id, { version: '1.1.0', spec: { package: '@modelcontextprotocol/server-memory' }, slots: m.versions[0]!.slots });
    assert.throws(() => h.pools.create('mcpset', { name: 'A', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'X' }, { version: '1.1.0' })] } }), /isn’t approved/);
    const set = h.pools.create('mcpset', { name: 'A', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'X' })] } });
    h.mcp.catalog.deprecate(m.id, m.versions[0]!.id);
    // Kept where it is…
    h.pools.update(set.id, { content: { slug: 'a', servers: [server(m, 'memory', { DEMO_TOKEN: 'Y' }, { version: '1.0.0' })] } });
    // …but can't be added under another key.
    assert.throws(
      () => h.pools.update(set.id, { content: { slug: 'a', servers: [server(m, 'memory', { DEMO_TOKEN: 'Y' }, { version: '1.0.0' }), server(m, 'memory2', { DEMO_TOKEN: 'Y' }, { version: '1.0.0' })] } }),
      /deprecated/,
    );
    void draft;
  } finally {
    h.done();
  }
});

test('sets: secret slots take Secrets & env references only; ${NAME} and credential-shaped config are refused (FR10)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const set = h.pools.create('mcpset', { name: 'Refs', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'DEMO_TOKEN' })] } });
    assert.deepEqual((set.content as McpSetContent).servers[0]!.secrets, { DEMO_TOKEN: '{{secret-file:DEMO_TOKEN}}' });
    assert.throws(() => h.pools.create('mcpset', { name: 'B', content: { servers: [server(m, 'memory', { DEMO_TOKEN: '${DEMO_TOKEN}' })] } }), /credential-like names read as empty/);
    assert.throws(() => h.pools.create('mcpset', { name: 'C', content: { servers: [server(m, 'memory', {})] } }), /Pick a secret for DEMO_TOKEN/);
    // A turned-off server may wait for its secret.
    h.pools.create('mcpset', { name: 'D', content: { servers: [server(m, 'memory', {}, { enabled: false })] } });
    assert.throws(
      () => h.pools.create('mcpset', { name: 'E', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'X' }, { config: { MEMORY_FILE_PATH: 'sk-ant-api03-abcdefghijklmnop' } })] } }),
      /looks like a secret/,
    );
    assert.throws(
      () => h.pools.create('mcpset', { name: 'F', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'X' }), server(m, 'memory', { DEMO_TOKEN: 'X' })] } }),
      /used twice/,
    );
  } finally {
    h.done();
  }
});

/* ---------- Delivery ---------- */

test('fragment: one plugin per set, maps hold parts never values, the drop-in enables it and sets MCP_TIMEOUT (FR14, §10.2)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const r = await remote(h);
    const set = h.pools.create('mcpset', { name: 'Team', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'DEMO' }), server(r, 'lab', { Authorization: 'LAB_TOKEN' })] } });
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
    h.give(WS, 'DEMO', 'LAB_TOKEN');
    const { bundle } = deliver(h);
    const plugin = bundle.plugins.find((p) => p.name === 'cpm-team')!;
    assert.match(plugin.version, /^1\.0\.0\+[0-9a-f]{8}$/);
    assert.deepEqual(JSON.parse(pluginFile(bundle, 'cpm-team', '.mcp.json')!), {
      mcpServers: {
        memory: { command: '/etc/claudepilot/bin/mcp-launch', args: ['cpm-team/memory', '--', 'npm:@modelcontextprotocol/server-memory@1.0.0', '--quiet'] },
        lab: { type: 'http', url: 'https://mcp.example.com/mcp', headersHelper: '/etc/claudepilot/bin/mcp-headers cpm-team/lab' },
      },
    });
    assert.deepEqual(JSON.parse(pluginFile(bundle, 'cpm-team', 'servers/memory.json')!), {
      target: 'npm:@modelcontextprotocol/server-memory@1.0.0',
      args: ['--quiet'],
      env: { DEMO_TOKEN: [{ file: 'DEMO' }], MEMORY_FILE_PATH: [{ text: '/home/node/.memory.json' }] },
    });
    assert.deepEqual(JSON.parse(pluginFile(bundle, 'cpm-team', 'servers/lab.json')!), {
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: [{ text: 'Bearer ' }, { file: 'LAB_TOKEN' }] },
    });
    assert.deepEqual(JSON.parse(file(bundle, MCP_DROPIN)!), { enabledPlugins: { 'cpm-team@claudepilot': true }, env: { MCP_TIMEOUT: '60000' } });
    assert.ok(file(bundle, '/etc/claudepilot/bin/mcp-launch')?.startsWith('#!/usr/bin/env node'));
    assert.ok(file(bundle, '/etc/claudepilot/bin/mcp-headers')?.startsWith('#!/usr/bin/env node'));
    assert.match(file(bundle, MARKETPLACE_JSON)!, /"source": "\.\/plugins\/cpm-team\/[0-9a-f]{12}"/);
    // Delivery states and the matchers an allowlist needs (FR19): exactly the launcher argv, and the URL.
    const status = h.mcp.status(WS);
    assert.deepEqual(status.servers.map((s) => [s.key, s.state]), [
      ['lab', 'delivered'],
      ['memory', 'delivered'],
    ]);
    assert.deepEqual(h.mcp.matchers(WS), [
      { serverCommand: ['/etc/claudepilot/bin/mcp-launch', 'cpm-team/memory', '--', 'npm:@modelcontextprotocol/server-memory@1.0.0', '--quiet'] },
      { serverUrl: 'https://mcp.example.com/mcp' },
    ]);
    assert.deepEqual(status.missingNames, []);
  } finally {
    h.done();
  }
});

test('fragment: an unresolved name leaves out only that server, with the reason (Secrets & env FR22)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const r = await remote(h);
    const set = h.pools.create('mcpset', { name: 'Linear', content: { slug: 'linear', servers: [server(m, 'memory', { DEMO_TOKEN: 'LINEAR_API_KEY' }), server(r, 'lab', { Authorization: 'LAB_TOKEN' })] } });
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
    h.give(WS, 'LAB_TOKEN');
    const { bundle } = deliver(h);
    assert.deepEqual(Object.keys(JSON.parse(pluginFile(bundle, 'cpm-linear', '.mcp.json')!).mcpServers), ['lab']);
    const status = h.mcp.status(WS);
    const memoryRow = status.servers.find((s) => s.key === 'memory')!;
    assert.deepEqual([memoryRow.state, memoryRow.reason], ['missing_secret', "MCP set 'Linear' needs LINEAR_API_KEY."]);
    assert.deepEqual(status.missingNames, ['LINEAR_API_KEY']);
    // Nothing resolves (Secrets & env not there yet): no plugin, the pool still named for the manifest.
    h.give(WS);
    const none = deliver(h);
    assert.equal(none.bundle.plugins.length, 0);
    assert.deepEqual(none.bundle.manifest.pools.map((p) => p.id), [set.id]);
    assert.equal(file(none.bundle, MCP_DROPIN), undefined);
  } finally {
    h.done();
  }
});

test('fragment: a preview without a workspace shows what a workspace with every name gets', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const set = h.pools.create('mcpset', { name: 'Prev', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'DEMO' })] } });
    const preview = h.pools.preview('mcpset', set.id, {});
    const paths = preview.files.map((f) => f.path);
    assert.ok(paths.includes(MCP_DROPIN));
    assert.ok(paths.some((p) => /\/plugins\/cpm-prev\/[0-9a-f]{12}\/servers\/memory\.json$/.test(p)));
    assert.ok(paths.includes('/etc/claudepilot/bin/mcp-launch'));
    // Previews record nothing.
    assert.equal((h.store.db!.prepare('SELECT count(*) AS n FROM mcp_delivery').get() as { n: number }).n, 0);
  } finally {
    h.done();
  }
});

test('fragment: the same remote URL in two sets of one workspace is refused; an old Claude Code gets nothing (FR11, FR14)', async () => {
  const h = await setup();
  try {
    const r = await remote(h);
    const a = h.pools.create('mcpset', { name: 'A', content: { servers: [server(r, 'lab', { Authorization: 'T' })] } });
    const b = h.pools.create('mcpset', { name: 'B', content: { servers: [server(r, 'lab', { Authorization: 'T' })] } });
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: a.id }, { poolId: b.id }]);
    h.give(WS, 'T');
    deliver(h);
    const rows = h.mcp.status(WS).servers;
    assert.deepEqual(rows.map((s) => [s.plugin, s.state]), [
      ['cpm-a', 'delivered'],
      ['cpm-b', 'unsupported'],
    ]);
    assert.match(rows[1]!.reason!, /Same URL as cpm-a\/lab/);
    assert.ok(h.mcp.status(WS).warnings.some((w) => /is in A and B/.test(w)));
    h.store.db!.prepare("INSERT INTO workspace_delivery (workspace_id, claude_version) VALUES (?, '2.1.200 (Claude Code)')").run(WS);
    const old = deliver(h);
    assert.equal(old.bundle.plugins.length, 0);
    assert.match(h.mcp.status(WS).servers[0]!.reason!, /Needs Claude Code 2\.1\.296/);
  } finally {
    h.done();
  }
});

test('revoke: the server leaves every delivery at once, pins included; its tools are denied, its folders and processes go (FR13b)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const r = await remote(h);
    const set = h.pools.create('mcpset', { name: 'Team', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'DEMO' }), server(r, 'lab', { Authorization: 'T' })] } });
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: set.id, pinnedRevision: 1 }]);
    h.give(WS, 'DEMO', 'T');
    const first = deliver(h);
    const old = first.bundle.plugins[0]!;
    // The engine reports the folder in the workspace.
    h.provider.delivered!(WS, { running: true, now: first.now, delivered: new Set(first.bundle.files.map((f) => f.path)), pluginFolders: new Map([['cpm-team', [old.treeHash.slice(0, 12)]]]) });
    assert.ok(h.queued.some((q) => q.step.key === 'verify') && h.queued.some((q) => q.step.key === 'install:npm:@modelcontextprotocol/server-memory@1.0.0'));
    h.queued.length = 0;

    const result = h.mcp.revoke(m.id, m.versions[0]!.id, 'compromised');
    assert.deepEqual(result.workspaces, [WS]);
    assert.ok(h.requests.some((q) => q.id === WS && q.why === 'mcp version revoked'));
    const next = deliver(h);
    const deny = JSON.parse(file(next.bundle, MCP_DROPIN)!).permissions.deny as string[];
    assert.deepEqual(deny, ['mcp__plugin_cpm-team_memory__*']);
    assert.deepEqual(next.bundle.revoked, [`/etc/claudepilot/marketplace/plugins/cpm-team/${old.treeHash.slice(0, 12)}/`]);
    assert.deepEqual(Object.keys(JSON.parse(pluginFile(next.bundle, 'cpm-team', '.mcp.json')!).mcpServers), ['lab']);
    const row = h.mcp.status(WS).servers.find((s) => s.key === 'memory')!;
    assert.equal(row.state, 'revoked');
    // After that delivery, its processes are stopped in the running workspace.
    h.provider.delivered!(WS, { running: true, now: next.now, delivered: new Set(), pluginFolders: new Map([['cpm-team', [next.bundle.plugins[0]!.treeHash.slice(0, 12)]]]) });
    const kill = h.queued.find((q) => q.step.key === 'kill:npm:@modelcontextprotocol/server-memory@1.0.0')!;
    assert.ok(kill);
    assert.match(kill.step.script, /CLAUDEPILOT_MCP_TARGET=npm:@modelcontextprotocol\/server-memory@1\.0\.0/);
    kill.step.done!({ code: 0, stdout: 'found: 41 42\n', stderr: '', timedOut: false, ms: 5 } as StepResult);
    const events = h.store.db!.prepare("SELECT kind, details FROM delivery_events WHERE workspace_id = ? AND kind LIKE 'mcp_revoked%' ORDER BY id").all(WS) as { kind: string; details: string }[];
    assert.deepEqual(events.map((e) => e.kind), ['mcp_revoked', 'mcp_revoked_stopped']);
    assert.deepEqual(JSON.parse(events[1]!.details).pids, [41, 42]);
    h.queued.length = 0;
    const again = deliver(h);
    h.provider.delivered!(WS, { running: true, now: again.now, delivered: new Set(), pluginFolders: new Map() });
    assert.ok(!h.queued.some((q) => q.step.key.startsWith('kill:')), 'stopped once');
    // A set revision can't add it back.
    assert.throws(() => h.pools.update(set.id, { content: { slug: 'team', servers: [server(m, 'memory2', { DEMO_TOKEN: 'DEMO' }, { version: '1.0.0' })] } }), /was revoked/);
  } finally {
    h.done();
  }
});

test('revoke: the deny rule lifts once an approved version replaces it; "Try in set" makes a held revision (FR4, FR13b)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const set = h.pools.create('mcpset', { name: 'Team', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'DEMO' })] } });
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
    h.pools.setAssignments(WS2, 'mcpset', [{ poolId: set.id }]);
    h.give(WS, 'DEMO');
    h.give(WS2, 'DEMO');
    deliver(h);
    h.mcp.revoke(m.id, m.versions[0]!.id, '');
    assert.ok(JSON.parse(file(deliver(h).bundle, MCP_DROPIN)!).permissions.deny.includes('mcp__plugin_cpm-team_memory__*'));
    const v2 = await h.mcp.catalog.addVersion(m.id, { version: '1.0.1', spec: { package: '@modelcontextprotocol/server-memory', args: ['--quiet'] }, slots: m.versions[0]!.slots });
    h.mcp.catalog.approve(m.id, v2.versions[0]!.id, { reviewed: true });
    const held = h.mcp.tryInSet(set.id, m.id, '1.0.1');
    assert.deepEqual([held.revision, held.latestRevision], [1, 2]);
    // A trial workspace pinned to it gets the new version; the deny rule is gone there.
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: set.id, pinnedRevision: 2 }]);
    const trial = deliver(h);
    assert.equal(JSON.parse(file(trial.bundle, MCP_DROPIN)!).permissions, undefined);
    assert.match(pluginFile(trial.bundle, 'cpm-team', '.mcp.json')!, /server-memory@1\.0\.1/);
    // The other workspace still follows r1: revoked, denied.
    assert.ok(JSON.parse(file(deliver(h, WS2).bundle, MCP_DROPIN)!).permissions.deny.includes('mcp__plugin_cpm-team_memory__*'));
  } finally {
    h.done();
  }
});

test('references: Secrets & env learns which sets use a name, and which names a workspace’s sets use (FR19, FR23)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const a = h.pools.create('mcpset', { name: 'A', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'SHARED' })] } });
    h.pools.create('mcpset', { name: 'B', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'OTHER' })] } });
    assert.deepEqual(h.references.referencing('SHARED'), [{ type: 'mcpset', poolId: a.id, poolName: 'A' }]);
    assert.deepEqual(h.references.referencing('NOPE'), []);
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: a.id }]);
    assert.deepEqual([...h.references.namesUsedBy(WS)], [['SHARED', [{ type: 'mcpset', poolId: a.id, poolName: 'A' }]]]);
  } finally {
    h.done();
  }
});

test('jobs: verify and installs run after a delivery to a running workspace, once, and their results show (FR16, §12)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const set = h.pools.create('mcpset', { name: 'Team', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'DEMO' })] } });
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
    h.give(WS, 'DEMO');
    // Stopped: nothing runs; the start reconcile does it.
    const stopped = deliver(h, WS, false);
    h.provider.delivered!(WS, { running: false, now: stopped.now, delivered: new Set(), pluginFolders: new Map() });
    assert.equal(h.queued.length, 0);
    assert.equal(h.mcp.status(WS).servers[0]!.state, 'pending_start');
    const d = deliver(h);
    h.provider.delivered!(WS, { running: true, now: d.now, delivered: new Set(), pluginFolders: new Map() });
    const verify = h.queued.find((q) => q.step.key === 'verify')!.step;
    const install = h.queued.find((q) => q.step.key.startsWith('install:'))!.step;
    assert.match(install.script, /npm install --prefix "\$p\.tmp" --no-save --ignore-scripts --registry https:\/\/registry\.npmjs\.org\/ --userconfig \/dev\/null/);
    const plugin = d.bundle.plugins[0]!;
    verify.done!({
      code: 0,
      stdout: `<<<cp-version>>>2.1.296 (Claude Code)\n<<<cp-plugin>>>cpm-team\ncpm-team ${plugin.version}\n  Source: cpm-team@claudepilot\n\nComponent inventory\n  MCP servers (1)  memory  (tool schemas resolved at runtime; not counted)\n<<<cp-exit>>>0\n`,
      stderr: '',
      timedOut: false,
      ms: 1200,
    });
    install.done!({ code: 0, stdout: 'installed\n', stderr: '', timedOut: false, ms: 5000 });
    const status = h.mcp.status(WS);
    assert.deepEqual(status.verify.map((v) => [v.plugin, v.result, v.servers]), [['cpm-team', 'ok', ['memory']]]);
    assert.deepEqual([status.servers[0]!.listed, status.servers[0]!.install?.state], [true, 'installed']);
    // The same delivery again runs nothing.
    h.queued.length = 0;
    const again = deliver(h);
    h.provider.delivered!(WS, { running: true, now: again.now, delivered: new Set(), pluginFolders: new Map() });
    assert.equal(h.queued.length, 0);
    // A failed install shows its (redacted) error and waits for Retry.
    h.store.db!.prepare("UPDATE mcp_installs SET state = 'failed', error = 'npm ERR! 404', updated_at = ?").run(new Date().toISOString());
    const later = deliver(h);
    h.provider.delivered!(WS, { running: true, now: later.now, delivered: new Set(), pluginFolders: new Map() });
    assert.equal(h.queued.length, 0);
    assert.deepEqual(h.mcp.status(WS).servers[0]!.install, { state: 'failed', error: 'npm ERR! 404', at: h.mcp.status(WS).servers[0]!.install!.at });
    h.mcp.retry(WS, 'installs');
    const retried = deliver(h);
    h.provider.delivered!(WS, { running: true, now: retried.now, delivered: new Set(), pluginFolders: new Map() });
    assert.deepEqual(h.queued.map((q) => q.step.key), ['install:npm:@modelcontextprotocol/server-memory@1.0.0']);
  } finally {
    h.done();
  }
});

test('jobs: a pre-installed version no set uses leaves the home volume after 14 days unused, not before (§12)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const set = h.pools.create('mcpset', { name: 'Team', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'DEMO' })] } });
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
    h.give(WS, 'DEMO');
    const d = deliver(h);
    h.provider.delivered!(WS, { running: true, now: d.now, delivered: new Set(), pluginFolders: new Map() });
    h.queued.find((q) => q.step.key.startsWith('install:'))!.step.done!({ code: 0, stdout: 'installed\n', stderr: '', timedOut: false, ms: 5000 });
    // The workspace's last set goes: the package stays while it may still be wanted back.
    h.pools.setAssignments(WS, 'mcpset', []);
    const ref = 'npm:@modelcontextprotocol/server-memory@1.0.0';
    const age = (days: number) =>
      h.store.db!.prepare('UPDATE mcp_installs SET last_used_at = ? WHERE workspace_id = ? AND package_ref = ?').run(new Date(Date.now() - days * 24 * 60 * 60_000).toISOString(), WS, ref);
    age(13);
    h.queued.length = 0;
    const early = deliver(h);
    h.provider.delivered!(WS, { running: true, now: early.now, delivered: new Set(), pluginFolders: new Map() });
    assert.equal(h.queued.length, 0);
    // 14 days unused: removed from the fixed folder only, then forgotten.
    age(15);
    const late = deliver(h);
    h.provider.delivered!(WS, { running: true, now: late.now, delivered: new Set(), pluginFolders: new Map() });
    assert.deepEqual(h.queued.map((q) => q.step.key), [`remove:${ref}`]);
    assert.equal(h.queued[0]!.step.script, `rm -rf -- "$HOME/.cache/claudepilot/mcp/"'npm/@modelcontextprotocol/server-memory@1.0.0'`);
    h.queued[0]!.step.done!({ code: 0, stdout: '', stderr: '', timedOut: false, ms: 50 });
    assert.equal((h.store.db!.prepare('SELECT count(*) AS n FROM mcp_installs WHERE workspace_id = ?').get(WS) as { n: number }).n, 0);
  } finally {
    h.done();
  }
});

test('jobs: a server starting after "not registered" runs the verify again, without waiting for the retry (FR16, §13.2)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const set = h.pools.create('mcpset', { name: 'Team', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'DEMO' })] } });
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
    h.give(WS, 'DEMO');
    const d = deliver(h);
    h.provider.delivered!(WS, { running: true, now: d.now, delivered: new Set(), pluginFolders: new Map() });
    // What Claude Code 2.1.296 prints before any session registered the marketplace (seen in a Docker workspace).
    h.queued.find((q) => q.step.key === 'verify')!.step.done!({
      code: 0,
      stdout: `<<<cp-version>>>2.1.296 (Claude Code)\n<<<cp-plugin>>>cpm-team\n✘ Could not load details for "cpm-team": Marketplace 'claudepilot' not found in configuration. Available marketplaces: anthropic-plugin-directory\n<<<cp-exit>>>1\n`,
      stderr: '',
      timedOut: false,
      ms: 600,
    });
    assert.equal(h.mcp.status(WS).verify[0]!.result, 'not_registered');
    // A failure, or another workspace's start, changes nothing.
    h.requests.length = 0;
    h.mcp.onOutbox(WS, [{ id: '1', server: 'cpm-team/memory', phase: 'fail', reason_class: 'install_failed' }]);
    h.mcp.onOutbox(WS2, [{ id: '2', server: 'cpm-team/memory', phase: 'start', source: 'preinstalled' }]);
    assert.equal(h.mcp.status(WS).verify[0]!.result, 'not_registered');
    assert.deepEqual(h.requests, []);
    // A start here: the verify is due again at once.
    h.mcp.onOutbox(WS, [{ id: '3', server: 'cpm-team/memory', phase: 'start', source: 'preinstalled' }]);
    assert.deepEqual(h.mcp.status(WS).verify, []);
    assert.deepEqual(h.requests, [{ id: WS, why: 'verify mcp sets' }]);
    h.queued.length = 0;
    const again = deliver(h);
    h.provider.delivered!(WS, { running: true, now: again.now, delivered: new Set(), pluginFolders: new Map() });
    assert.deepEqual(h.queued.map((q) => q.step.key), ['verify']);
    // Once verified, later starts don't run it again.
    h.queued[0]!.step.done!({
      code: 0,
      stdout: `<<<cp-version>>>2.1.296 (Claude Code)\n<<<cp-plugin>>>cpm-team\ncpm-team ${again.bundle.plugins[0]!.version}\n  Source: cpm-team@claudepilot\n\nComponent inventory\n  MCP servers (1)  memory  (tool schemas resolved at runtime; not counted)\n<<<cp-exit>>>0\n`,
      stderr: '',
      timedOut: false,
      ms: 900,
    });
    h.requests.length = 0;
    h.mcp.onOutbox(WS, [{ id: '4', server: 'cpm-team/memory', phase: 'start', source: 'preinstalled' }]);
    assert.equal(h.mcp.status(WS).verify[0]!.result, 'ok');
    assert.deepEqual(h.requests, []);
  } finally {
    h.done();
  }
});

test('launcher events from the outbox show the last failure, never a value (§13.2)', async () => {
  const h = await setup();
  try {
    const m = await memory(h);
    const set = h.pools.create('mcpset', { name: 'Team', content: { servers: [server(m, 'memory', { DEMO_TOKEN: 'DEMO' })] } });
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
    h.give(WS, 'DEMO');
    deliver(h);
    h.mcp.onOutbox(WS, [
      { id: '1', at: '2026-10-11T00:00:00Z', server: 'cpm-team/memory', phase: 'fail', source: 'preinstalled', reason_class: 'secret_missing' },
      { id: '2', server: 'cpm-team/memory', phase: 'start', value: 'should-be-ignored' },
      { id: '3', server: 'cpm-team/memory', phase: 'fail', source: 'preinstalled', reason_class: 'secret_missing' },
    ]);
    assert.equal(h.mcp.status(WS).servers[0]!.reason, 'Last start failed: secret missing.');
    const stored = h.store.db!.prepare("SELECT details FROM mcp_events WHERE type = 'launch'").all() as { details: string }[];
    assert.ok(stored.every((r) => !r.details.includes('should-be-ignored')));
  } finally {
    h.done();
  }
});

test('fragments pass the delivery engine’s ownership checks: own bin scripts, cpm- plugins, mcp__plugin_cpm- rules only', async () => {
  const h = await setup();
  try {
    const bad: Fragment[] = [{ owner: 'mcpset', settings: { permissions: { deny: ['Bash(*)'] } } }];
    assert.throws(() => compile({ portalId: 'p', generation: 1, fragments: bad, claudeVersion: null }), /only rules on mcp__plugin_cpm-/);
    const wrongBin: Fragment[] = [{ owner: 'mcpset', files: [{ path: '/etc/claudepilot/bin/account-key', content: '', mode: 0o755, uid: 0, gid: 0 }] }];
    assert.throws(() => compile({ portalId: 'p', generation: 1, fragments: wrongBin, claudeVersion: null }), /may not write/);
  } finally {
    h.done();
  }
});
