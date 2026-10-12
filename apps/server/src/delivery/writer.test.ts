import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeliveryAccess, TarEntry } from '../workspaces/runtime.js';
import { compile } from './compile.js';
import { NODE, ROOT, type Fragment } from './types.js';
import { deleteFiles, deleteOrder, readApplied, writeBundle } from './writer.js';

const base = { portalId: 'p1', generation: 7, claudeVersion: '2.1.296 (Claude Code)', now: new Date('2026-10-10T00:00:00Z') };

/** Records what the writer asks of the runtime. */
function recorder(stdout = '') {
  const puts: TarEntry[][] = [];
  const scripts: string[] = [];
  const access: DeliveryAccess = {
    state: async () => ({ exists: true, running: true }),
    run: async (_name, script) => {
      scripts.push(script);
      return { code: 0, stdout, stderr: '' };
    },
    put: async (_name, entries) => void puts.push(entries),
    read: async () => null,
    watchStarts: () => () => {},
  };
  return { access, puts, scripts };
}

const fragments: Fragment[] = [
  { owner: 'secrets', files: [{ path: '/etc/claudepilot/secrets/files/TOKEN', content: 't', mode: 0o440, uid: ROOT, gid: NODE }] },
  {
    owner: 'skillset',
    plugins: [{ name: 'frontend', version: '1.0.0+00000000', files: [{ path: 'skills/review/SKILL.md', content: '---\nname: review\n---\nx\n' }] }],
    settings: { enabledPlugins: { 'frontend@claudepilot': true } },
  },
];

test('running: version folders move into place after referenced files and before the catalog, drop-ins and manifest', async () => {
  const bundle = compile({ ...base, fragments });
  const [p] = bundle.plugins;
  const tmp = `/etc/claudepilot/marketplace/plugins/frontend/.${p!.treeHash.slice(0, 12)}.g7.cp-tmp`;
  const r = recorder();
  const deletes = ['/etc/claudepilot/marketplace/plugins/old-set/0123456789ab/', '/etc/claudepilot/marketplace/.claude-plugin/marketplace.json', '/etc/claudepilot/secrets/files/OLD', '/etc/claude-code/managed-settings.d/30-claudepilot-mcp.json'];
  await writeBundle(r.access, 'ws', bundle, { running: true, deletes });

  // One archive: folders, the version folder under its temp name, every file under a temp name.
  const paths = r.puts[0]!.map((e) => e.path);
  assert.ok(paths.includes(tmp) && paths.includes(`${tmp}/skills/review/SKILL.md`) && paths.includes(`${tmp}/.claude-plugin/plugin.json`));
  assert.ok(!paths.some((x) => x.startsWith(`${p!.dir}/`) || x === p!.dir), 'nothing at the final folder name yet');
  assert.deepEqual(r.puts[0]!.find((e) => e.path === `${tmp}/skills/review/SKILL.md`), { path: `${tmp}/skills/review/SKILL.md`, type: 'file', content: '---\nname: review\n---\nx\n', mode: 0o644, uid: 0, gid: 0 });

  // Then one exec, in write order.
  const lines = r.scripts[0]!.split('\n');
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  const order = [
    at("mv -f '/etc/claudepilot/secrets/files/.TOKEN.cp-tmp' '/etc/claudepilot/secrets/files/TOKEN'"),
    at(`mv -T -- '${tmp}' '${p!.dir}'`),
    at("'/etc/claudepilot/marketplace/.claude-plugin/marketplace.json'"),
    at("'/etc/claude-code/managed-settings.d/00-claudepilot-base.json'"),
    at("'/etc/claude-code/managed-settings.d/60-claudepilot-skills.json'"),
    at("'/etc/claudepilot/state.json'"),
    at("rm -f '/etc/claude-code/managed-settings.d/30-claudepilot-mcp.json'"),
    at("rm -f '/etc/claudepilot/secrets/files/OLD'"),
    at("rm -f '/etc/claudepilot/marketplace/.claude-plugin/marketplace.json'"),
    at("rm -rf -- '/etc/claudepilot/marketplace/plugins/old-set/0123456789ab'"),
  ];
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'referenced files, folder, catalog, drop-ins, manifest, then deletions');
  assert.equal(lines[0], 'set -e');

  // Folders already in place are left alone.
  const again = recorder();
  await writeBundle(again.access, 'ws', bundle, { running: true, deletes: [], plugins: [] });
  assert.ok(!again.puts[0]!.some((e) => e.path.includes('.cp-tmp/')) && !again.scripts[0]!.includes('mv -T'));
});

test('stopped: final names in write order, manifest last; deleted files blanked, folders left for the next start', async () => {
  const bundle = compile({ ...base, fragments });
  const r = recorder();
  const deletes = ['/etc/claudepilot/secrets/files/OLD', '/etc/claudepilot/marketplace/plugins/old-set/0123456789ab/'];
  const { deferred } = await writeBundle(r.access, 'ws', bundle, { running: false, deletes });
  assert.equal(r.scripts.length, 0, 'no exec into a stopped workspace');
  const files = r.puts[0]!.filter((e) => e.type === 'file').map((e) => e.path);
  const dir = bundle.plugins[0]!.dir;
  const idx = (p: string) => files.indexOf(p);
  assert.ok(idx('/etc/claudepilot/secrets/files/TOKEN') < idx(`${dir}/skills/review/SKILL.md`));
  assert.ok(idx(`${dir}/skills/review/SKILL.md`) < idx('/etc/claudepilot/marketplace/.claude-plugin/marketplace.json'));
  assert.ok(idx('/etc/claudepilot/marketplace/.claude-plugin/marketplace.json') < idx('/etc/claude-code/managed-settings.d/00-claudepilot-base.json'));
  assert.equal(files.at(-1), '/etc/claudepilot/state.json');
  assert.equal(r.puts[0]!.find((e) => e.path === '/etc/claudepilot/secrets/files/OLD')?.content, '');
  assert.ok(!files.some((p) => p.includes('old-set')), 'a folder can’t be blanked; it waits');
  assert.deepEqual(deferred, deletes);
});

test('deletions run drop-ins first and version folders last, and never outside the marketplace', async () => {
  assert.deepEqual(
    deleteOrder(['/etc/claudepilot/marketplace/plugins/a/0123456789ab/', '/etc/claudepilot/marketplace/.claude-plugin/marketplace.json', '/etc/claudepilot/secrets/x', '/etc/claude-code/managed-settings.d/60-claudepilot-skills.json']),
    ['/etc/claude-code/managed-settings.d/60-claudepilot-skills.json', '/etc/claudepilot/secrets/x', '/etc/claudepilot/marketplace/.claude-plugin/marketplace.json', '/etc/claudepilot/marketplace/plugins/a/0123456789ab/'],
  );
  const r = recorder();
  await assert.rejects(deleteFiles(r.access, 'ws', ['/home/node/']), /not a plugin version folder/);
  assert.equal(r.scripts.length, 0);
});

test('readApplied: file hashes, version folder tree hashes on request, claude ages and the version, from one exec', async () => {
  const manifest = { portalId: 'p1', generation: 3, compiledAt: 'x', pools: [], files: {} };
  const dir = '/etc/claudepilot/marketplace/plugins/frontend/0123456789ab';
  const r = recorder(`${JSON.stringify(manifest)}\n<<<cp-hashes>>>\nabc /etc/a\n- /etc/b\n<<<cp-trees>>>\nfff ${dir}\n- /etc/claudepilot/marketplace/plugins/x/aaaaaaaaaaaa\n<<<cp-claude>>>\n61\n2\n<<<cp-version>>>\n2.1.296 (Claude Code)\n`);
  const applied = await readApplied(r.access, 'ws', true, { trees: true });
  assert.match(r.scripts[0]!, /CP_TREES=1 /);
  assert.deepEqual(applied.manifest, manifest);
  assert.deepEqual(applied.hashes, { '/etc/a': 'abc', '/etc/b': null });
  assert.deepEqual(applied.trees, { [dir]: 'fff', '/etc/claudepilot/marketplace/plugins/x/aaaaaaaaaaaa': null });
  assert.deepEqual(applied.claudeAges, [61, 2]);
  assert.equal(applied.claudeVersion, '2.1.296 (Claude Code)');

  // Without a manifest the workspace prints no hashes or trees, but still the ages: a first delivery has to know
  // which sessions started before it (the settings lockdown's "restart these sessions").
  const empty = recorder('<<<cp-hashes>>>\n<<<cp-claude>>>\n600\n4\n<<<cp-version>>>\n2.1.296 (Claude Code)\n');
  const none = await readApplied(empty.access, 'ws', true);
  assert.match(empty.scripts[0]!, /else\s+CP_HZ=.*node -e .*<<<cp-claude>>>/s);
  assert.deepEqual([none.manifest, none.trees, none.claudeAges], [null, null, [600, 4]]);
  assert.deepEqual(none.hashes, {});
  // When the ages can't be read (node missing, say) they are unknown, not none.
  const blind = recorder('<<<cp-hashes>>>\n<<<cp-version>>>\n2.1.296 (Claude Code)\n');
  assert.equal((await readApplied(blind.access, 'ws', true)).claudeAges, null);
});
