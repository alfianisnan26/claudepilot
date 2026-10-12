import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { compile } from './compile.js';
import { dueFolders, folderPlugin, pluginDir, RETENTION, revokedDir, TREE_HASH_JS, treeHash } from './marketplace.js';
import { mayNamePlugin } from './ownership.js';
import { MARKETPLACE_JSON, type Fragment, type PluginBundle } from './types.js';

const base = { portalId: 'p1', generation: 1, claudeVersion: '2.1.296 (Claude Code)', now: new Date('2026-10-10T00:00:00Z') };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const skill = (name: string, body = 'Do it.') => ({ path: `skills/${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: ${name} things\n---\n${body}\n` });
const plugin = (name: string, files: PluginBundle['files'] = [skill('review')], extra: Partial<PluginBundle> = {}): PluginBundle => ({ name, version: '3.0.0+0a1b2c3d', description: `${name} set`, files, ...extra });

/* ---------- Tree hash (skillset FR6) ---------- */

test('the tree hash is FR6: one "<mode> <path>\\0<sha256>\\n" line per file, paths sorted bytewise', () => {
  const files = [
    { path: 'bin/run', content: '#!/bin/sh\n', mode: 0o755 },
    { path: 'a.txt', content: 'A' },
  ];
  const expected = sha(`0644 a.txt\0${sha('A')}\n0755 bin/run\0${sha('#!/bin/sh\n')}\n`);
  assert.equal(treeHash(files), expected);
  assert.equal(treeHash([...files].reverse()), expected, 'order of the input does not matter');
  assert.equal(treeHash([{ path: 'a.txt', content: 'A', mode: 0o600 }, { path: 'bin/run', content: '#!/bin/sh\n', mode: 0o4711 }]), expected, 'modes normalize to 0644 / 0755');
  assert.equal(treeHash([{ path: 'café.md', content: 'x' }]), treeHash([{ path: 'café.md', content: 'x' }]), 'paths are NFC-normalized');
  assert.notEqual(treeHash([{ path: 'a.txt', content: 'B' }]), treeHash([{ path: 'a.txt', content: 'A' }]));
});

test('the workspace computes the same tree hash over a delivered folder, and sees extra files and links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-tree-'));
  try {
    const files = [
      { path: '.claude-plugin/plugin.json', content: '{"name":"x"}\n', mode: 0o644 },
      { path: 'skills/review/SKILL.md', content: '---\nname: review\n---\nRévise.\n', mode: 0o644 },
      { path: 'skills/review/scripts/check.sh', content: '#!/bin/sh\necho ok\n', mode: 0o755 },
    ];
    for (const f of files) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.content);
      chmodSync(join(dir, f.path), f.mode);
    }
    // Evaluated as the workspace's Node evaluates it: a CommonJS function using require.
    const inWorkspace = new Function('require', `return (${TREE_HASH_JS})`)(createRequire(import.meta.url)) as (root: string) => string;
    assert.equal(inWorkspace(dir), treeHash(files));
    writeFileSync(join(dir, 'skills/review/hooks.json'), '{}');
    assert.notEqual(inWorkspace(dir), treeHash(files), 'an extra file is drift');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- Compiling plugins ---------- */

test('a plugin becomes a root-owned version folder named by its tree hash, with a generated plugin.json', () => {
  const bundle = compile({
    ...base,
    fragments: [{ owner: 'skillset', plugins: [plugin('frontend', [skill('review'), { path: 'skills/review/scripts/lint.sh', content: '#!/bin/sh\n', mode: 0o4755 }])] }],
  });
  const [p] = bundle.plugins;
  assert.ok(p);
  assert.equal(p.dir, `/etc/claudepilot/marketplace/plugins/frontend/${p.treeHash.slice(0, 12)}`);
  assert.equal(p.treeHash, treeHash(p.files.map((f) => ({ path: f.path.slice(p.dir.length + 1), content: f.content, mode: f.mode }))), 'the hash covers plugin.json too');
  const byPath = Object.fromEntries(p.files.map((f) => [f.path.slice(p.dir.length + 1), f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['.claude-plugin/plugin.json', 'skills/review/SKILL.md', 'skills/review/scripts/lint.sh']);
  assert.deepEqual(JSON.parse(byPath['.claude-plugin/plugin.json']!.content), { name: 'frontend', version: '3.0.0+0a1b2c3d', description: 'frontend set', author: { name: 'claudepilot' } });
  assert.equal(byPath['skills/review/scripts/lint.sh']!.mode, 0o755, 'setuid dropped, execute kept');
  assert.equal(byPath['skills/review/SKILL.md']!.mode, 0o644);
  assert.ok(p.files.every((f) => f.uid === 0 && f.gid === 0));
  assert.deepEqual(
    p.dirs.map((d) => [d.path.slice(p.dir.length + 1), d.mode, d.uid]),
    [
      ['.claude-plugin', 0o755, 0],
      ['skills', 0o755, 0],
      ['skills/review', 0o755, 0],
      ['skills/review/scripts', 0o755, 0],
    ],
  );
  // Plugin files are checked by tree hash, so the manifest lists the folder, not each file.
  assert.deepEqual(bundle.manifest.plugins, [{ owner: 'skillset', name: 'frontend', version: '3.0.0+0a1b2c3d', treeHash: p.treeHash }]);
  assert.ok(Object.keys(bundle.manifest.files).every((f) => !f.startsWith('/etc/claudepilot/marketplace/plugins/')));
});

test('the catalog and the base drop-in come with the first plugin, in write order', () => {
  const bundle = compile({
    ...base,
    fragments: [
      { owner: 'mcpset', plugins: [plugin('cpm-team', [{ path: '.mcp.json', content: '{"mcpServers":{}}' }])], settings: { enabledPlugins: { 'cpm-team@claudepilot': true } } },
      { owner: 'skillset', plugins: [plugin('frontend')], settings: { enabledPlugins: { 'frontend@claudepilot': true } } },
      { owner: 'secrets', files: [{ path: '/etc/claudepilot/secrets/files/TOKEN', content: 't', mode: 0o440, uid: 0, gid: 1000 }] },
    ],
  });
  assert.deepEqual(
    bundle.files.map((f) => f.path),
    [
      '/etc/claudepilot/secrets/files/TOKEN',
      MARKETPLACE_JSON,
      '/etc/claude-code/managed-settings.d/00-claudepilot-base.json',
      '/etc/claude-code/managed-settings.d/30-claudepilot-mcp.json',
      '/etc/claude-code/managed-settings.d/60-claudepilot-skills.json',
    ],
  );
  const [team, frontend] = [bundle.plugins.find((p) => p.name === 'cpm-team')!, bundle.plugins.find((p) => p.name === 'frontend')!];
  assert.deepEqual(JSON.parse(bundle.files[1]!.content), {
    name: 'claudepilot',
    owner: { name: 'claudepilot' },
    metadata: { description: 'Plugins delivered by the claudepilot portal. Managed: local changes are overwritten.' },
    plugins: [
      { name: 'cpm-team', source: `./plugins/cpm-team/${team.treeHash.slice(0, 12)}`, description: 'cpm-team set', version: '3.0.0+0a1b2c3d' },
      { name: 'frontend', source: `./plugins/frontend/${frontend.treeHash.slice(0, 12)}`, description: 'frontend set', version: '3.0.0+0a1b2c3d' },
    ],
  });
  assert.deepEqual(JSON.parse(bundle.files[2]!.content), {
    extraKnownMarketplaces: { claudepilot: { source: { source: 'directory', path: '/etc/claudepilot/marketplace' }, autoUpdate: false } },
  });
  assert.deepEqual(
    bundle.dirs.filter((d) => d.path.includes('marketplace')).map((d) => d.path),
    ['/etc/claudepilot/marketplace', '/etc/claudepilot/marketplace/plugins', '/etc/claudepilot/marketplace/.claude-plugin', '/etc/claudepilot/marketplace/plugins/cpm-team', '/etc/claudepilot/marketplace/plugins/frontend'],
  );
  assert.deepEqual(bundle.plugins.map((p) => p.name), ['cpm-team', 'frontend']);
});

test('the hash follows plugin content, not the order files are listed in', () => {
  const frag = (files: PluginBundle['files']): Fragment[] => [{ owner: 'skillset', plugins: [plugin('frontend', files)] }];
  const a = compile({ ...base, fragments: frag([skill('a'), skill('b')]) });
  const b = compile({ ...base, generation: 9, fragments: frag([skill('b'), skill('a')]) });
  const c = compile({ ...base, fragments: frag([skill('a'), skill('b', 'Changed.')]) });
  assert.equal(a.hash, b.hash);
  assert.equal(a.plugins[0]!.dir, b.plugins[0]!.dir);
  assert.notEqual(a.hash, c.hash);
  assert.notEqual(a.plugins[0]!.dir, c.plugins[0]!.dir, 'a new version is a new folder');
});

test('plugin names follow each owner’s rule, are unique across fragments, and avoid Claude Code’s reserved prefixes', () => {
  assert.ok(mayNamePlugin('mcpset', 'cpm-team') && !mayNamePlugin('mcpset', 'team') && !mayNamePlugin('mcpset', 'cpm-'));
  assert.ok(mayNamePlugin('persona', 'cpp-reviewer') && !mayNamePlugin('persona', 'reviewer'));
  assert.ok(mayNamePlugin('browser', 'cpb-browser'));
  assert.ok(mayNamePlugin('skillset', 'frontend') && mayNamePlugin('skillset', 'cpmx'));
  for (const name of ['cpm-x', 'cpp-x', 'cpb-x', 'claude-x', 'anthropic-x', 'anthropics-x', 'cc-plugin-x', 'Frontend', 'front_end', 'front--end', '-x', 'x'.repeat(65)])
    assert.ok(!mayNamePlugin('skillset', name), name);
  // What `claude plugin validate` refused or accepted on 2.1.296.
  for (const name of ['claude', 'anthropic', 'anthropics', 'claude-code', 'claude-mods', 'my-claude-official', 'my-claudeofficial', 'officialclaude', 'official-claude-x', 'x-official-anthropic', 'anthropic-official'])
    assert.ok(!mayNamePlugin('skillset', name), name);
  for (const name of ['claudex', 'official-x-claude', 'official-tools']) assert.ok(mayNamePlugin('skillset', name), name);
  assert.ok(!mayNamePlugin('account', 'anything') && !mayNamePlugin('secrets', 'anything') && !mayNamePlugin('foundation', 'anything'));

  const ship = (owner: Fragment['owner'], p: PluginBundle) => () => compile({ ...base, fragments: [{ owner, plugins: [p] }] });
  assert.throws(ship('mcpset', plugin('team')), /mcpset: may not ship a plugin named "team"/);
  assert.throws(ship('skillset', plugin('cpm-team')), /skillset: may not ship a plugin named "cpm-team"/);
  assert.throws(ship('account', plugin('tools')), /account: may not ship/);
  assert.throws(ship('skillset', plugin('frontend', undefined, { version: 'r3' })), /version must look like/);
  assert.throws(
    () => compile({ ...base, fragments: [{ owner: 'skillset', plugins: [plugin('frontend')] }, { owner: 'skillset', plugins: [plugin('frontend', [skill('other')])] }] }),
    /plugin frontend is already delivered/,
  );
});

test('plugin files stay inside the version folder, and an owner’s own plugin.json must match', () => {
  const ship = (files: PluginBundle['files']) => () => compile({ ...base, fragments: [{ owner: 'skillset', plugins: [plugin('frontend', files)] }] });
  for (const path of ['/etc/passwd', '../x', 'skills/../../x', 'skills//x', './skills/x', 'skills/x/', 'a\\b', 'a\u0000b', ''])
    assert.throws(ship([{ path, content: 'x' }]), /must be a relative path|must stay inside the plugin folder|control character|is listed twice/, JSON.stringify(path));
  assert.throws(ship([skill('a'), skill('a')]), /is listed twice/);
  assert.throws(ship([{ path: 'skills', content: 'x' }, skill('a')]), /skills is both a file and a folder/);
  assert.throws(ship([{ path: '.claude-plugin/plugin.json', content: '{nope' }]), /plugin\.json is not valid JSON/);
  assert.throws(ship([{ path: '.claude-plugin/plugin.json', content: '{"name":"other"}' }]), /must name the plugin "frontend"/);
  assert.throws(ship([{ path: '.claude-plugin/plugin.json', content: '{"name":"frontend","version":"9.0.0"}' }]), /version must be 3\.0\.0\+0a1b2c3d/);
  const own = '{"name":"frontend","version":"3.0.0+0a1b2c3d","keywords":["ui"]}';
  const bundle = compile({ ...base, fragments: [{ owner: 'skillset', plugins: [plugin('frontend', [{ path: '.claude-plugin/plugin.json', content: own }, skill('a')])] }] });
  assert.equal(bundle.plugins[0]!.files.find((f) => f.path.endsWith('plugin.json'))!.content, own, 'kept as written');
});

test('an owner switches on only plugins it delivers in this bundle, and may switch off its own names', () => {
  const run = (f: Fragment) => () => compile({ ...base, fragments: [f] });
  assert.doesNotThrow(run({ owner: 'skillset', plugins: [plugin('frontend')], settings: { enabledPlugins: { 'frontend@claudepilot': true, 'old-set@claudepilot': false } } }));
  assert.throws(run({ owner: 'skillset', settings: { enabledPlugins: { 'frontend@claudepilot': true } } }), /enables frontend@claudepilot without delivering it/);
  assert.throws(run({ owner: 'skillset', settings: { enabledPlugins: { 'cpm-team@claudepilot': false } } }), /may not switch cpm-team@claudepilot/);
  assert.throws(run({ owner: 'skillset', settings: { enabledPlugins: { 'frontend@other-market': true } } }), /may not switch frontend@other-market/);
  assert.throws(run({ owner: 'skillset', plugins: [plugin('frontend')], settings: { enabledPlugins: { 'frontend@claudepilot': 'yes' } } }), /must be true or false/);
  assert.throws(run({ owner: 'skillset', settings: { enabledPlugins: ['frontend@claudepilot'] } }), /enabledPlugins must be an object/);
  assert.throws(
    () =>
      compile({
        ...base,
        fragments: [
          { owner: 'mcpset', plugins: [plugin('cpm-team')] },
          { owner: 'persona', settings: { enabledPlugins: { 'cpm-team@claudepilot': true } } },
        ],
      }),
    /persona: may not switch cpm-team@claudepilot/,
  );
});

test('revoking names one of the owner’s own retired version folders', () => {
  const current = compile({ ...base, fragments: [{ owner: 'skillset', plugins: [plugin('frontend')] }] }).plugins[0]!;
  const bundle = compile({ ...base, fragments: [{ owner: 'skillset', plugins: [plugin('frontend', [skill('new')])], revokePluginFolders: [`frontend/${current.treeHash.slice(0, 12)}`] }] });
  assert.deepEqual(bundle.revoked, [`${current.dir}/`]);
  const revoke = (owner: Fragment['owner'], ref: string, plugins: PluginBundle[] = []) => () => compile({ ...base, fragments: [{ owner, plugins, revokePluginFolders: [ref] }] });
  assert.throws(revoke('skillset', 'cpm-team/0123456789ab'), /may not revoke "cpm-team\/0123456789ab"/);
  assert.throws(revoke('skillset', 'frontend/xyz'), /may not revoke/);
  assert.throws(revoke('skillset', 'frontend/0123456789ab/extra'), /may not revoke/);
  assert.throws(revoke('skillset', `frontend/${current.treeHash.slice(0, 12)}`, [plugin('frontend')]), /which it still delivers/);
  assert.equal(revokedDir('mcpset', 'cpm-team/0123456789ab'), '/etc/claudepilot/marketplace/plugins/cpm-team/0123456789ab');
});

/* ---------- Retention (skillset §10.5) ---------- */

test('retired version folders: kept for older sessions, revoked at once, gone at a start, nothing while stopped', () => {
  const DAY = 24 * 60 * 60_000;
  const now = Date.parse('2026-10-11T00:00:00Z');
  const dir = (name: string, n: number) => `${pluginDir(name, n.toString(16).padStart(12, '0'))}/`;
  const at = (name: string, n: number, ageMs: number) => ({ path: dir(name, n), since: now - ageMs });
  const ctx = { running: true, started: false, now, current: new Set(['frontend']), revoked: new Set<string>(), graceMs: 30_000 };

  // Previous two always stay; older ones stay while younger than 14 days; the rest go.
  const retired = [at('frontend', 1, 40 * DAY), at('frontend', 2, 30 * DAY), at('frontend', 3, 20 * DAY), at('frontend', 4, 13 * DAY), at('frontend', 5, 1 * DAY)];
  assert.deepEqual(dueFolders(retired, ctx).sort(), [dir('frontend', 1), dir('frontend', 2), dir('frontend', 3)].sort());
  // At most 10 folders per plugin, the current one included.
  const many = Array.from({ length: 12 }, (_, i) => at('frontend', i + 1, (i + 1) * 60_000));
  assert.deepEqual(dueFolders(many, ctx).sort(), [dir('frontend', 10), dir('frontend', 11), dir('frontend', 12)].sort());
  assert.equal(RETENTION.maxFolders, 10);
  // Revoked: at once, retention or not.
  assert.deepEqual(dueFolders([at('frontend', 5, 1000)], { ...ctx, revoked: new Set([dir('frontend', 5)]) }), [dir('frontend', 5)]);
  // A plugin no longer delivered at all: its folders go after the grace period.
  assert.deepEqual(dueFolders([at('gone', 1, 10_000)], ctx), []);
  assert.deepEqual(dueFolders([at('gone', 1, 31_000)], ctx), [dir('gone', 1)]);
  // A start ends every session, so everything retired goes; a stopped workspace can't delete anything.
  assert.deepEqual(dueFolders(retired, { ...ctx, started: true }).length, retired.length);
  assert.deepEqual(dueFolders(retired, { ...ctx, running: false }), []);
  // Anything that isn't a version folder is never due.
  assert.deepEqual(dueFolders([{ path: '/etc/claudepilot/', since: 0 }, { path: '/etc/claudepilot/marketplace/plugins/x/../../a/', since: 0 }], { ...ctx, started: true }), []);
  assert.equal(folderPlugin(dir('frontend', 1)), 'frontend');
  assert.equal(folderPlugin('/etc/claudepilot/marketplace/plugins/frontend/0123456789ab'), null, 'folders end in /');
});
