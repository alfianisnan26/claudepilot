import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { DeliveryAccess, Runtime } from '../workspaces/runtime.js';
import { pluginDir, treeHash } from './marketplace.js';
import { parsePending } from './pending.js';
import { Reconciler, type FragmentProvider } from './reconciler.js';
import { MANIFEST_PATH, MARKETPLACE_JSON, type Fragment, type Manifest, type PluginBundle } from './types.js';

const WS = 'docker/ws1';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const unquote = (s: string) => s.replace(/'\\''/g, "'");

/**
 * A running (or stopped) Docker workspace in memory: what the archive API writes, and the handful of
 * shell commands the writer runs, executed in order and logged, so tests see what landed and when.
 */
function workspace() {
  const files = new Map<string, { content: string; mode: number }>();
  const dirs = new Set<string>();
  const log: string[] = [];
  const state = { running: true, ages: [] as number[] };
  const within = (root: string) => (p: string) => p === root || p.startsWith(`${root}/`);
  const removeTree = (root: string) => {
    for (const k of [...files.keys()]) if (within(root)(k)) files.delete(k);
    for (const d of [...dirs]) if (within(root)(d)) dirs.delete(d);
  };
  const moveTree = (from: string, to: string) => {
    for (const [k, v] of [...files]) if (within(from)(k)) (files.delete(k), files.set(to + k.slice(from.length), v));
    for (const d of [...dirs]) if (within(from)(d)) (dirs.delete(d), dirs.add(to + d.slice(from.length)));
  };
  const tree = (dir: string) =>
    dirs.has(dir) ? treeHash([...files].filter(([k]) => k.startsWith(`${dir}/`)).map(([k, v]) => ({ path: k.slice(dir.length + 1), content: v.content, mode: v.mode }))) : null;

  const readApplied = (script: string) => {
    const raw = files.get(MANIFEST_PATH)?.content ?? '';
    let out = `${raw}<<<cp-hashes>>>\n`;
    if (raw) {
      const m = JSON.parse(raw) as Manifest;
      for (const p of Object.keys(m.files)) out += `${files.has(p) ? sha256(files.get(p)!.content) : '-'} ${p}\n`;
      if (script.includes('CP_TREES=1 ')) {
        out += '<<<cp-trees>>>\n';
        for (const p of m.plugins ?? []) out += `${tree(pluginDir(p.name, p.treeHash)) ?? '-'} ${pluginDir(p.name, p.treeHash)}\n`;
      }
      out += `<<<cp-claude>>>\n${state.ages.map((a) => `${a}\n`).join('')}`;
    }
    return `${out}<<<cp-version>>>\n2.1.296 (Claude Code)\n`;
  };

  const run = (script: string) => {
    if (script.includes('<<<cp-hashes>>>')) return readApplied(script);
    for (const line of script.split('\n')) {
      let m: RegExpExecArray | null;
      if (line === 'set -e') continue;
      if ((m = /^mv -f '([^']*)' '([^']*)'$/.exec(line))) {
        const [from, to] = [unquote(m[1]!), unquote(m[2]!)];
        if (!files.has(from)) throw new Error(`mv: ${from} missing`);
        files.set(to, files.get(from)!);
        files.delete(from);
        log.push(`mv ${to}`);
      } else if ((m = /^mv -T -- '([^']*)' '([^']*)'$/.exec(line))) {
        moveTree(m[1]!, m[2]!);
        log.push(`folder ${m[2]}`);
      } else if ((m = /^if \[ -e '([^']*)' \]; then mv -T -- '([^']*)' '([^']*)'; fi$/.exec(line))) {
        if (dirs.has(m[1]!)) moveTree(m[2]!, m[3]!);
      } else if ((m = /^rm -rf -- '([^']*)'$/.exec(line))) {
        if (dirs.has(m[1]!)) log.push(`rm -r ${m[1]}`);
        removeTree(m[1]!);
      } else if ((m = /^rmdir --ignore-fail-on-non-empty -- '([^']*)' 2>\/dev\/null \|\| true$/.exec(line))) {
        const dir = m[1]!;
        if (dirs.has(dir) && ![...dirs, ...files.keys()].some((p) => p.startsWith(`${dir}/`))) (dirs.delete(dir), log.push(`rmdir ${dir}`));
      } else if ((m = /^rm -f '([^']*)'$/.exec(line))) {
        files.delete(m[1]!);
        log.push(`rm ${m[1]}`);
      } else if ((m = /^for x in '([^']*)'\/\.\*\.cp-tmp; do/.exec(line))) {
        for (const d of [...dirs]) if (dirname(d) === m[1] && basename(d).startsWith('.') && d.endsWith('.cp-tmp')) removeTree(d);
      } else throw new Error(`unexpected command: ${line}`);
    }
    return '';
  };

  const access: DeliveryAccess = {
    state: async () => ({ exists: true, running: state.running }),
    run: async (_name, script) => {
      if (!state.running) throw new Error('not running');
      return { code: 0, stdout: run(script), stderr: '' };
    },
    put: async (_name, entries) => {
      for (const e of entries) {
        if (e.type === 'directory') dirs.add(e.path);
        else files.set(e.path, { content: e.content ?? '', mode: e.mode });
      }
    },
    read: async (_name, path) => files.get(path)?.content ?? null,
    watchStarts: () => () => {},
  };
  const runtime = { delivery: access, target: { id: 'docker', label: 'Docker', kind: 'docker', where: '' } } as unknown as Runtime;
  const manifest = () => JSON.parse(files.get(MANIFEST_PATH)?.content ?? 'null') as Manifest | null;
  return { files, dirs, log, state, runtime, manifest };
}

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-delivery-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const ws = workspace();
  const seen: { pluginFolders: Map<string, string[]> }[] = [];
  const provider: FragmentProvider & { list: Fragment[] } = {
    type: 'skillset',
    list: [],
    knownPools: () => ['set-1', 'sec-1'],
    fragments() {
      return this.list;
    },
    delivered: (_id, ctx) => void seen.push({ pluginFolders: ctx.pluginFolders }),
  };
  const reconciler = new Reconciler(store, () => ws.runtime, () => [ws.runtime], [provider]);
  const row = () => reconciler.row(WS)!;
  const pending = () => parsePending(row().pending_deletes);
  const run = async (why = 'test') => {
    ws.log.length = 0;
    await reconciler.request(WS, why);
    assert.equal(row().status, 'synced', row().reason ?? '');
  };
  /** Pretends every pending entry has waited `ms` longer. */
  const age = (ms: number) => {
    const rows = JSON.parse(row().pending_deletes) as { since: number }[];
    store.db!.prepare('UPDATE workspace_delivery SET pending_deletes = ? WHERE workspace_id = ?').run(JSON.stringify(rows.map((r) => ({ ...r, since: r.since - ms }))), WS);
  };
  const done = () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, ws, provider, reconciler, row, pending, run, age, seen, done };
}

const skillset = (body: string, extra: Partial<Fragment> = {}): Fragment => ({
  owner: 'skillset',
  pool: { id: 'set-1', revision: 1 },
  plugins: [{ name: 'frontend', version: '1.0.0+00000000', files: [{ path: 'skills/review/SKILL.md', content: `---\nname: review\n---\n${body}\n` }] } satisfies PluginBundle],
  settings: { enabledPlugins: { 'frontend@claudepilot': true } },
  ...extra,
});

test('plugins on a running workspace: folder before catalog before drop-ins, repoint, retention, start, revocation, unassign', async () => {
  const h = await harness();
  try {
    h.provider.list = [skillset('v1')];
    await h.run();
    const v1 = h.ws.manifest()!.plugins![0]!;
    const dir1 = pluginDir(v1.name, v1.treeHash);
    assert.ok(h.ws.files.has(`${dir1}/skills/review/SKILL.md`) && h.ws.files.has(`${dir1}/.claude-plugin/plugin.json`));
    assert.deepEqual(h.ws.log, [
      'mv /etc/claudepilot/bin/outbox-pull', // the foundation's own script: a referenced file
      `folder ${dir1}`,
      `mv ${MARKETPLACE_JSON}`,
      'mv /etc/claude-code/managed-settings.d/00-claudepilot-base.json',
      'mv /etc/claude-code/managed-settings.d/60-claudepilot-skills.json',
      `mv ${MANIFEST_PATH}`,
    ]);
    assert.equal(JSON.parse(h.ws.files.get(MARKETPLACE_JSON)!.content).plugins[0].source, `./plugins/frontend/${v1.treeHash.slice(0, 12)}`);
    assert.deepEqual([...h.seen.at(-1)!.pluginFolders], [['frontend', [v1.treeHash.slice(0, 12)]]]);

    // A new version: a new folder, the catalog repointed after it; the old folder stays for older sessions.
    h.provider.list = [skillset('v2')];
    await h.run();
    const v2 = h.ws.manifest()!.plugins![0]!;
    const dir2 = pluginDir(v2.name, v2.treeHash);
    assert.deepEqual(h.ws.log.slice(1, 3), [`folder ${dir2}`, `mv ${MARKETPLACE_JSON}`]);
    assert.ok(h.ws.dirs.has(dir1), 'retained');
    assert.deepEqual([...h.pending().paths.keys()], [`${dir1}/`]);
    assert.deepEqual(h.seen.at(-1)!.pluginFolders.get('frontend')!.sort(), [v1.treeHash.slice(0, 12), v2.treeHash.slice(0, 12)].sort());

    // Nothing changed: nothing written, the old folder still kept (retention isn't a grace period).
    h.age(60 * 60_000);
    await h.run();
    assert.deepEqual(h.ws.log, []);
    assert.ok(h.ws.dirs.has(dir1));

    // A restart ends every session, so the start reconcile prunes it.
    await h.run('started');
    assert.deepEqual(h.ws.log, [`rm -r ${dir1}`]);
    assert.deepEqual([...h.pending().paths.keys()], []);

    // Revoking v2 while moving to v3: v2 goes in the same reconcile, right after the catalog stops naming it.
    h.provider.list = [skillset('v3', { revokePluginFolders: [`frontend/${v2.treeHash.slice(0, 12)}`] })];
    await h.run();
    const v3 = h.ws.manifest()!.plugins![0]!;
    const dir3 = pluginDir(v3.name, v3.treeHash);
    assert.deepEqual(h.ws.log, [
      'mv /etc/claudepilot/bin/outbox-pull',
      `folder ${dir3}`,
      `mv ${MARKETPLACE_JSON}`,
      'mv /etc/claude-code/managed-settings.d/00-claudepilot-base.json',
      'mv /etc/claude-code/managed-settings.d/60-claudepilot-skills.json',
      `mv ${MANIFEST_PATH}`,
      `rm -r ${dir2}`,
    ]);
    assert.ok(!h.ws.dirs.has(dir2));

    // Unassigned: drop-ins stop naming it at once; after the grace period the drop-in, catalog and folder go, in that order.
    h.provider.list = [];
    await h.run();
    assert.ok(h.ws.dirs.has(dir3) && h.ws.files.has(MARKETPLACE_JSON));
    h.age(31_000);
    await h.run();
    assert.deepEqual(h.ws.log, [
      'rm /etc/claude-code/managed-settings.d/00-claudepilot-base.json',
      'rm /etc/claude-code/managed-settings.d/60-claudepilot-skills.json',
      `rm ${MARKETPLACE_JSON}`,
      `rm -r ${dir3}`,
      'rmdir /etc/claudepilot/marketplace/plugins/frontend',
    ]);
    assert.deepEqual(h.seen.at(-1)!.pluginFolders, new Map());
  } finally {
    h.done();
  }
});

test('a version folder changed by hand is rewritten whole at the next tree check', async () => {
  const h = await harness();
  try {
    h.provider.list = [skillset('v1')];
    await h.run();
    const p = h.ws.manifest()!.plugins![0]!;
    const dir = pluginDir(p.name, p.treeHash);
    await h.run(); // the first tree check that finds a manifest: intact
    assert.deepEqual(h.ws.log, []);
    h.ws.files.set(`${dir}/hooks/hooks.json`, { content: '{"hooks":{}}', mode: 0o644 });
    await h.run(); // the next check is due at a start or in 10 minutes
    assert.ok(h.ws.files.has(`${dir}/hooks/hooks.json`));
    await h.run('started');
    assert.ok(!h.ws.files.has(`${dir}/hooks/hooks.json`), 'the extra hook is gone');
    assert.ok(h.ws.files.has(`${dir}/skills/review/SKILL.md`));
    assert.equal(h.ws.log[1], `folder ${dir}`);
    const event = h.store.db!.prepare("SELECT details FROM delivery_events WHERE kind = 'drift_repaired' ORDER BY id DESC").get() as { details: string };
    assert.deepEqual(JSON.parse(event.details).plugins, [dir]);
  } finally {
    h.done();
  }
});

test('tombstones: kept while an older claude process runs, dropped once none does, never in a stopped workspace', async () => {
  const h = await harness();
  const ENV = '/etc/claude-code/managed-settings.d/20-claudepilot-env.json';
  const secrets = (env: Record<string, string>): Fragment => ({ owner: 'secrets', pool: { id: 'sec-1', revision: 1 }, settings: { env }, envTombstones: { safeValues: { GH_CONFIG_DIR: '/home/node/.config/gh' } } });
  const env = () => (JSON.parse(h.ws.files.get(ENV)?.content ?? '{}') as { env?: Record<string, string> }).env;
  try {
    h.provider.list = [secrets({ GH_CONFIG_DIR: '/etc/claudepilot/secrets/gh', LINEAR_API_KEY: 'lin' })];
    await h.run();
    assert.deepEqual(h.ws.manifest()!.env, { secrets: { GH_CONFIG_DIR: '/home/node/.config/gh', LINEAR_API_KEY: '' } });

    // A session has been running for an hour; GH_CONFIG_DIR is removed.
    h.ws.state.ages = [3600];
    h.provider.list = [secrets({ LINEAR_API_KEY: 'lin' })];
    const before = Date.now();
    await h.run();
    assert.deepEqual(env(), { LINEAR_API_KEY: 'lin', GH_CONFIG_DIR: '/home/node/.config/gh' });
    const [t] = h.pending().tombstones;
    assert.ok(t && t.name === 'GH_CONFIG_DIR' && t.since >= before, 'since: when it landed');

    await h.run();
    assert.deepEqual(h.ws.log, [], 'still needed: nothing to write');
    assert.equal(h.pending().tombstones.length, 1);

    // A minute on, the only session started after it, so none holds the old value: the tombstone goes.
    h.age(60_000);
    h.ws.state.ages = [30];
    await h.run();
    assert.deepEqual(env(), { LINEAR_API_KEY: 'lin' });
    assert.deepEqual(h.pending().tombstones, []);

    // Removing a name while the workspace is stopped needs no tombstone at all.
    h.provider.list = [secrets({})];
    h.ws.state.running = false;
    await h.run();
    assert.deepEqual(env(), {});
    assert.deepEqual(h.pending().tombstones, []);
  } finally {
    h.done();
  }
});

test('a stopped workspace drops its tombstones at once and keeps retired folders for its next start', async () => {
  const h = await harness();
  const ENV = '/etc/claude-code/managed-settings.d/20-claudepilot-env.json';
  try {
    h.provider.list = [skillset('v1'), { owner: 'secrets', pool: { id: 'sec-1', revision: 1 }, settings: { env: { A: '1', B: '2' } }, envTombstones: {} }];
    await h.run();
    const dir1 = pluginDir('frontend', h.ws.manifest()!.plugins![0]!.treeHash);
    h.ws.state.ages = [100];
    h.provider.list = [skillset('v1'), { owner: 'secrets', pool: { id: 'sec-1', revision: 1 }, settings: { env: { A: '1' } }, envTombstones: {} }];
    await h.run();
    assert.equal(h.pending().tombstones.length, 1);

    h.ws.state.running = false;
    h.provider.list = [skillset('v2'), { owner: 'secrets', pool: { id: 'sec-1', revision: 1 }, settings: { env: { A: '1' } }, envTombstones: {} }];
    await h.run();
    assert.deepEqual(JSON.parse(h.ws.files.get(ENV)!.content), { env: { A: '1' } });
    assert.deepEqual(h.pending().tombstones, []);
    assert.ok(h.ws.dirs.has(dir1), 'no exec while stopped');
    assert.deepEqual([...h.pending().paths.keys()], [`${dir1}/`]);

    h.ws.state.running = true;
    await h.run('started');
    assert.ok(!h.ws.dirs.has(dir1));
  } finally {
    h.done();
  }
});
