import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { BROWSER_POOL_DEFAULTS, SETTING_KEYS, type BrowserPoolContent } from '@portal/contracts';
import { McpLockdown } from '../settings/lockdown.js';
import type { Settings } from '../settings/store.js';
import { compile, CompileError } from '../delivery/compile.js';
import { dropInPath } from '../delivery/ownership.js';
import { FOUNDATION } from '../delivery/reconciler.js';
import { browserMatchers, compileBrowser, LOCK_HASH, mcpServers, permissionRules } from './compile.js';
import { GATE_PATH } from './gate.js';
import { chromePolicy, containerConfig } from './policy.js';
import { browserHarness } from './testkit.js';

const content = (over: Partial<BrowserPoolContent> = {}): BrowserPoolContent => ({ ...BROWSER_POOL_DEFAULTS, ...over });
const pool = { id: 'p1', name: 'Dev browser', revision: 3 };

test('parse: defaults, every field validated, headless has no VNC, allowlist mode needs sites', async () => {
  const h = await browserHarness();
  try {
    const kind = h.kind;
    assert.deepEqual(kind.parse({}, null), BROWSER_POOL_DEFAULTS);
    assert.throws(() => kind.parse({ tier: 'desktop' }, null), /desktop tier/);
    const edited = kind.parse({ tier: 'headless', display: '1920x1080', idleMinutes: 0, sessions: 'isolated', resources: { cpus: 1.5, memoryMb: 4096 } }, null);
    assert.equal(edited.tier, 'headless');
    assert.equal(edited.resources.cpus, 1.5);
    assert.equal(edited.resources.shmMb, 1024, 'unlisted resources keep their default');
    // An edit continues from the previous revision.
    assert.equal(kind.parse({ display: '1024x768' }, edited).tier, 'headless');

    const headless = kind.parse({ tier: 'headless' }, null);
    assert.equal(headless.liveView, false);
    assert.throws(() => kind.parse({ tier: 'headless', proxyView: false }, null), /proxy view/);
    for (const bad of [{ tier: 'tablet' }, { display: '800x600' }, { idleMinutes: -1 }, { idleMinutes: 2.5 }, { resources: { memoryMb: 100 } }, { downloads: 'yes' }, { toolRules: { 'Bad Name': 'ask' } }, { toolRules: { browser_click: 'maybe' } }, { blockedSites: ['a b'] }, { blockedSites: 'x' }]) {
      assert.throws(() => kind.parse(bad, null), (e) => isAppError(e) && e.code === 'VALIDATION_FAILED', JSON.stringify(bad));
    }
    assert.throws(() => kind.parse({ allowlistMode: true }, null), /List the sites/);
    assert.deepEqual(kind.parse({ allowlistMode: true, allowedSites: ['localhost:5173', ' *.example.com '] }, null).allowedSites, ['localhost:5173', '*.example.com']);
    assert.throws(() => kind.parse(null, null), /Describe the browser/);
  } finally {
    h.done();
  }
});

test('the servers a pool starts: through the gate, with CDP on loopback, shared or isolated, devtools only when on', () => {
  const shared = mcpServers(content()) as Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  assert.deepEqual(Object.keys(shared), ['browser']);
  assert.equal(shared.browser!.command, GATE_PATH);
  assert.deepEqual(shared.browser!.args.slice(0, 7), ['playwright', '--tools', '${CLAUDE_PLUGIN_ROOT}/tools/playwright.json', '--npm-files', '${CLAUDE_PLUGIN_ROOT}/npm', '--shared', '--']);
  assert.ok(shared.browser!.args.includes('--cdp-endpoint') && shared.browser!.args.includes('http://127.0.0.1:9222'));
  assert.ok(shared.browser!.args.includes('vision'));
  assert.ok(!shared.browser!.args.includes('--isolated'));

  const isolated = mcpServers(content({ sessions: 'isolated', vision: false, devtools: true })) as typeof shared;
  assert.ok(isolated.browser!.args.includes('--isolated') && !isolated.browser!.args.includes('--shared') && !isolated.browser!.args.includes('vision'));
  assert.deepEqual(Object.keys(isolated), ['browser', 'devtools']);
  assert.ok(isolated.devtools!.args.includes('--no-usage-statistics'));
  assert.equal(isolated.devtools!.env!.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS, '1');
  // Never npx at runtime, never a version range: the command is the gate, the servers come from the lockfile.
  for (const s of Object.values(isolated)) assert.ok(!s.args.some((a) => /npx|@latest/.test(a)));
});

test('lockdown matchers: each server’s command line with the plugin’s folder spelled out (that is what Claude Code compares), one per server', async () => {
  const dir = compileBrowser({ pool, content: content() }).plugin.dir;
  const [one] = browserMatchers(content(), dir);
  const line = (one as { serverCommand: string[] }).serverCommand;
  assert.equal(line[0], GATE_PATH);
  assert.ok(line.includes(`${dir}/tools/playwright.json`) && line.includes(`${dir}/npm`));
  assert.ok(!line.some((a) => a.includes('${')), 'nothing left to expand');
  assert.equal(browserMatchers(content(), dir).length, 1);
  assert.equal(browserMatchers(content({ devtools: true }), dir).length, 2, 'devtools is a second server');
  // The service reports the same for an assigned workspace, and nothing for one without a browser.
  const h = await browserHarness();
  try {
    const p = h.create('Dev browser', {});
    assert.deepEqual(h.service.matchers('docker/dev'), []);
    h.pools.setAssignments('docker/dev', 'browser', [{ poolId: p.id }]);
    const got = h.service.matchers('docker/dev');
    assert.equal(got.length, 1);
    const folder = (got[0] as { serverCommand: string[] }).serverCommand.find((a) => a.endsWith('/tools/playwright.json'))!;
    assert.match(folder, /^\/etc\/claudepilot\/marketplace\/plugins\/cpb-browser\/[0-9a-f]{12}\/tools\/playwright\.json$/);
  } finally {
    h.done();
  }
});

test('T-881: after a revision changes the plugin, the old exact command stays allowed while its folder is retained, then goes; never anything else', async () => {
  const h = await browserHarness();
  try {
    const p = h.create('Dev browser', {});
    h.pools.setAssignments('docker/dev', 'browser', [{ poolId: p.id }]);
    const [first] = h.service.matchers('docker/dev') as { serverCommand: string[] }[];
    const dirOf = (m: { serverCommand: string[] }) => m.serverCommand.find((a) => a.endsWith('/tools/playwright.json'))!.replace(/\/tools\/playwright\.json$/, '');
    const oldDir = dirOf(first!);
    // Rev 2 changes what the plugin holds (isolated sessions: other servers arguments), so it lives in another folder.
    h.pools.update(p.id, { content: { sessions: 'isolated' } });
    const both = h.service.matchers('docker/dev') as { serverCommand: string[] }[];
    const newDir = dirOf(both[0]!);
    assert.notEqual(newDir, oldDir, 'the revision moved the plugin to a new folder');
    assert.deepEqual(both.map(dirOf), [newDir, oldDir], 'before any delivery report: the new command and the old one, nothing else');
    assert.ok(both[0]!.serverCommand.includes('--isolated') && !both[1]!.serverCommand.includes('--isolated'), 'each is the exact command of its own revision');
    const folders = (...hashes: string[]) => new Map([['cpb-browser', hashes]]);
    const report = (m: Map<string, string[]>) => h.kind.delivered('docker/dev', { running: true, now: new Date(), pluginFolders: m });
    // The reconciler still holds both folders: both commands.
    report(folders(newDir.slice(-12), oldDir.slice(-12)));
    assert.deepEqual((h.service.matchers('docker/dev') as typeof both).map(dirOf), [newDir, oldDir]);
    // The old folder is retired: only the new command.
    report(folders(newDir.slice(-12)));
    assert.deepEqual((h.service.matchers('docker/dev') as typeof both).map(dirOf), [newDir]);
    // A folder that is not one of this pool's revisions never makes the list.
    report(folders(newDir.slice(-12), 'f'.repeat(12)));
    assert.deepEqual((h.service.matchers('docker/dev') as typeof both).map(dirOf), [newDir]);
  } finally {
    h.done();
  }
});

type Cmd = { serverCommand: string[] };
const dirOfCmd = (m: Cmd) => m.serverCommand.find((a) => a.endsWith('/tools/playwright.json'))!.replace(/\/tools\/playwright\.json$/, '');
const dirsOf = (h: Awaited<ReturnType<typeof browserHarness>>) => (h.service.matchers('docker/dev') as Cmd[]).map(dirOfCmd);
/** A new deliverable revision of the pool: the plugin folder carries the revision number, so every one has its own folder. */
const bump = (h: Awaited<ReturnType<typeof browserHarness>>, id: string, n: number, draft = false) => h.pools.update(id, { content: { idleMinutes: 10 + n }, draft });

test('T-881: exactly 5 earlier revisions stay admitted, the newest ones: a 6th and older are not', async () => {
  const h = await browserHarness();
  try {
    const p = h.create('Dev browser', {});
    h.pools.setAssignments('docker/dev', 'browser', [{ poolId: p.id }]);
    const dirs = [dirsOf(h)[0]!]; // revision 1
    for (let n = 2; n <= 8; n++) {
      bump(h, p.id, n);
      dirs.push(dirsOf(h)[0]!);
    }
    assert.equal(new Set(dirs).size, 8, 'eight revisions, eight folders');
    const [r1, r2, r3, r4, r5, r6, r7, r8] = dirs;
    // Current (r8) and the 5 before it, newest first; r2 and r1 are too old.
    assert.deepEqual(dirsOf(h), [r8, r7, r6, r5, r4, r3]);
    assert.ok(!dirsOf(h).includes(r2!) && !dirsOf(h).includes(r1!));
  } finally {
    h.done();
  }
});

test('T-881: another pool’s revisions never reach this workspace’s allowlist', async () => {
  const h = await browserHarness();
  try {
    const p = h.create('Dev browser', {});
    const other = h.create('Other browser', { devtools: true, sessions: 'isolated' });
    h.pools.update(other.id, { content: { idleMinutes: 33 } });
    h.pools.setAssignments('docker/dev', 'browser', [{ poolId: p.id }]);
    bump(h, p.id, 2);
    bump(h, p.id, 3);
    const got = h.service.matchers('docker/dev') as Cmd[];
    assert.equal(got.length, 3, 'the current revision and p’s own two earlier ones: one server each, nothing from the other pool');
    assert.ok(got.every((m) => !m.serverCommand.includes('--isolated')), 'the other pool’s content is isolated');
  } finally {
    h.done();
  }
});

test('T-881: drafts and revisions waiting for review are never admitted', async () => {
  const h = await browserHarness();
  try {
    const p = h.create('Dev browser', {});
    h.pools.setAssignments('docker/dev', 'browser', [{ poolId: p.id }]);
    const r1 = dirsOf(h)[0]!;
    const sql = h.store.db!;
    const copy = (revision: number, status: string, from: number) =>
      sql.prepare(`INSERT INTO pool_revisions (pool_id, revision, content, note, created_at, status) SELECT pool_id, ?, content, note, created_at, ? FROM pool_revisions WHERE pool_id = ? AND revision = ?`).run(revision, status, p.id, from);
    copy(2, 'draft', 1);
    bump(h, p.id, 3); // revision 3: deliverable and current
    const r3 = dirsOf(h)[0]!;
    copy(4, 'draft', 1); // (the store has no 'rejected' status: a CHECK allows draft, waiting_review and deliverable)
    copy(5, 'waiting_review', 1);
    copy(6, 'deliverable', 3);
    sql.prepare('UPDATE pools SET current_revision = 6 WHERE id = ?').run(p.id);
    const got = dirsOf(h);
    assert.equal(got.length, 3, `revision 6 and the deliverable r3 and r1: not the drafts (2, 4) or waiting (5); got ${JSON.stringify(got)}`);
    assert.ok(got.includes(r1) && got.includes(r3));
  } finally {
    h.done();
  }
});

test('T-881: the retained folders come from the cpb-browser entry of the delivery report, and a workspace’s are forgotten with it', async () => {
  const h = await browserHarness();
  try {
    const p = h.create('Dev browser', {});
    h.pools.setAssignments('docker/dev', 'browser', [{ poolId: p.id }]);
    const oldDir = dirsOf(h)[0]!;
    bump(h, p.id, 2);
    const newDir = dirsOf(h)[0]!;
    const report = (m: Map<string, string[]>) => h.kind.delivered('docker/dev', { running: true, now: new Date(), pluginFolders: m });
    // The old folder listed under another plugin's name is not the browser plugin's folder.
    report(new Map([['cpb-browser', [newDir.slice(-12)]], ['other-plugin', [oldDir.slice(-12)]]]));
    assert.deepEqual(dirsOf(h), [newDir]);
    report(new Map([['other-plugin', [oldDir.slice(-12)]]]));
    assert.deepEqual(dirsOf(h), [newDir], 'no browser folders reported: none retained');
    report(new Map([['cpb-browser', [newDir.slice(-12), oldDir.slice(-12)]]]));
    assert.deepEqual(dirsOf(h), [newDir, oldDir]);
    // Forgetting the workspace forgets what it held: back to "no report yet", which admits every earlier revision.
    report(new Map([['cpb-browser', [newDir.slice(-12)]]]));
    assert.deepEqual(dirsOf(h), [newDir]);
    assert.ok(h.kind.retainedFolders('docker/dev'));
    h.kind.forgetWorkspace('docker/dev');
    assert.equal(h.kind.retainedFolders('docker/dev'), undefined);
    assert.deepEqual(dirsOf(h), [newDir, oldDir]);
    await new Promise((r) => setTimeout(r, 30)); // forgotten() starts an async removal
  } finally {
    h.done();
  }
});

test('T-881: the lockdown drop-in is built from the matchers, so the old command leaves it when the retained set shrinks', async () => {
  const h = await browserHarness();
  try {
    const lockdown = new McpLockdown(h.store, { get: (key: string) => key === SETTING_KEYS.mcpPoolOnly } as unknown as Settings);
    lockdown.addMatcherSource((ws) => h.service.matchers(ws));
    const p = h.create('Dev browser', {});
    h.pools.setAssignments('docker/dev', 'browser', [{ poolId: p.id }]);
    const oldDir = dirsOf(h)[0]!;
    bump(h, p.id, 2);
    const newDir = dirsOf(h)[0]!;
    const allowed = () => {
      const [frag] = lockdown.fragments('docker/dev');
      return ((frag!.settings as { allowedMcpServers: Cmd[] }).allowedMcpServers).map(dirOfCmd).sort();
    };
    const report = (...hashes: string[]) => h.kind.delivered('docker/dev', { running: true, now: new Date(), pluginFolders: new Map([['cpb-browser', hashes]]) });
    report(newDir.slice(-12), oldDir.slice(-12));
    assert.deepEqual(allowed(), [newDir, oldDir].sort());
    const before = JSON.stringify(lockdown.desired('docker/dev'));
    report(newDir.slice(-12));
    assert.deepEqual(allowed(), [newDir], 'the next compile of the drop-in no longer allows the old command');
    assert.notEqual(JSON.stringify(lockdown.desired('docker/dev')), before, 'so the drop-in content changes');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    h.done();
  }
});

test('tool rules: asks, blocks, devtools’ network tools ask by default, and the profile is never readable', () => {
  const rules = permissionRules(content());
  assert.deepEqual(rules.ask, ['mcp__plugin_cpb-browser_browser__browser_file_upload']);
  assert.ok(rules.deny.includes('mcp__plugin_cpb-browser_browser__browser_run_code_unsafe'));
  assert.ok(rules.deny.includes('Read(//home/node/.claudepilot/browser/profile/**)'));
  assert.ok(rules.deny.includes('Edit(//home/node/.claudepilot/browser/profile/**)'));
  const withDevtools = permissionRules(content({ devtools: true, toolRules: { browser_file_upload: 'default', browser_navigate: 'ask', list_network_requests: 'default' } }));
  assert.ok(!withDevtools.ask.some((r) => r.endsWith('browser_file_upload')), 'default removes the rule');
  assert.ok(withDevtools.ask.includes('mcp__plugin_cpb-browser_browser__browser_navigate'));
  assert.ok(withDevtools.ask.includes('mcp__plugin_cpb-browser_devtools__get_network_request'), 'ask by default');
  assert.ok(!withDevtools.ask.includes('mcp__plugin_cpb-browser_devtools__list_network_requests'), 'unless the pool says default');
});

test('the fragment passes the delivery compiler: plugin, gate, installer, drop-in, and nothing outside what the browser owner may write', async () => {
  const c = compileBrowser({ pool, content: content({ devtools: true }) });
  const bundle = compile({ portalId: 'portal', generation: 1, fragments: [FOUNDATION, ...c.fragments], claudeVersion: '2.1.296 (Claude Code)' });
  assert.deepEqual(bundle.skipped, []);
  const paths = bundle.files.map((f) => f.path);
  assert.ok(paths.includes('/etc/claudepilot/bin/browser-mcp') && paths.includes('/etc/claudepilot/bin/browser-install'));
  const gate = bundle.files.find((f) => f.path === '/etc/claudepilot/bin/browser-mcp')!;
  assert.equal(gate.mode, 0o755);
  assert.equal(gate.uid, 0, 'root-owned: the workspace user can’t edit what the agent runs through');
  const [plugin] = bundle.plugins;
  assert.equal(plugin!.name, 'cpb-browser');
  assert.match(plugin!.version, /^3\.0\.0\+[0-9a-f]{8}$/);
  assert.deepEqual(
    plugin!.files.map((f) => f.path.slice(plugin!.dir.length + 1)).sort(),
    ['.claude-plugin/plugin.json', '.mcp.json', 'npm/package-lock.json', 'npm/package.json', 'skills/browser/SKILL.md', 'tools/devtools.json', 'tools/playwright.json'],
  );
  const dropIn = JSON.parse(bundle.files.find((f) => f.path === dropInPath('browser'))!.content) as { enabledPlugins: Record<string, boolean>; env: Record<string, string>; permissions: { ask: string[]; deny: string[] } };
  assert.deepEqual(dropIn.enabledPlugins, { 'cpb-browser@claudepilot': true });
  assert.equal(dropIn.env.CLAUDEPILOT_BROWSER_CDP, 'http://127.0.0.1:9222');
  assert.equal(dropIn.env.CLAUDEPILOT_BROWSER_DOWNLOADS, '/home/node/Downloads');
  assert.ok(dropIn.permissions.deny.includes('Read(//home/node/.claudepilot/browser/profile/**)'));
  assert.equal(bundle.manifest.pools.find((p) => p.type === 'browser')?.id, 'p1');
  // A Claude Code older than the minimum leaves it out, with the reason.
  const old = compile({ portalId: 'portal', generation: 1, fragments: [FOUNDATION, ...c.fragments], claudeVersion: '2.1.100 (Claude Code)' });
  assert.equal(old.skipped[0]?.owner, 'browser');
  assert.match(old.skipped[0]!.reason, /2\.1\.296/);
  assert.equal(old.plugins.length, 0);
  assert.throws(() => compile({ portalId: 'p', generation: 1, fragments: [{ ...c.fragments[0]!, files: [{ path: '/etc/claudepilot/bin/mcp-launch', content: 'x', mode: 0o755, uid: 0, gid: 0 }] }], claudeVersion: null }), CompileError);
});

test('the plugin changes only when what it holds changes (the version folder is named by its content)', () => {
  const a = compileBrowser({ pool, content: content() });
  assert.equal(compileBrowser({ pool, content: content({ idleMinutes: 5, display: '1024x768' }) }).plugin.treeHash, a.plugin.treeHash, 'idle time and display are the container’s, not the plugin’s');
  assert.notEqual(compileBrowser({ pool, content: content({ sessions: 'isolated' }) }).plugin.treeHash, a.plugin.treeHash);
  assert.match(LOCK_HASH, /^[0-9a-f]{16}$/);
});

test('Chrome policy and the container config: the baseline, blocked hosts, allowlist mode, downloads', () => {
  const p = chromePolicy(content({ blockedSites: ['evil.example'] }), { portalHosts: ['172.17.0.1:3104'] });
  assert.equal(p.BrowserSignin, 0);
  assert.equal(p.SyncDisabled, true);
  assert.equal(p.PasswordManagerEnabled, false);
  assert.deepEqual(p.ExtensionInstallBlocklist, ['*']);
  assert.equal(p.DownloadRestrictions, 0);
  assert.equal(p.RestoreOnStartup, undefined, 'no restored tabs: a session would pick one that isn’t in front');
  for (const host of ['metadata.google.internal', '169.254.169.254', 'cluster.local', '172.17.0.1:3104', 'evil.example']) assert.ok((p.URLBlocklist as string[]).includes(host), host);
  assert.equal(p.URLAllowlist, undefined);

  const strict = chromePolicy(content({ downloads: false, profile: 'fresh', allowlistMode: true, allowedSites: ['localhost:5173'] }), { portalHosts: [] });
  assert.equal(strict.DownloadRestrictions, 3);
  assert.equal((strict.URLBlocklist as string[])[0], '*');
  assert.deepEqual(strict.URLAllowlist, ['about:blank', 'localhost:5173']);

  const cfg = containerConfig(content({ tier: 'headless', display: '1366x768', start: 'with_workspace', privateTakeOvers: true }), { sandbox: false });
  assert.deepEqual(cfg, { tier: 'headless', display: { width: 1366, height: 768 }, profile: 'persistent', idleMinutes: 30, startWithWorkspace: true, sandbox: false, liveView: false, takeOver: true, private: true });
});

test('assignment: one browser pool per workspace, and only on Docker targets', async () => {
  const h = await browserHarness({ targets: ['docker'] });
  try {
    const a = h.create('A');
    const b = h.create('B');
    h.pools.setAssignments('docker/dev', 'browser', [{ poolId: a.id }]);
    assert.throws(() => h.pools.setAssignments('docker/dev', 'browser', [{ poolId: a.id }, { poolId: b.id }]), /one browser pool/);
    // Replacing swaps it (a removal record for the old one).
    const swapped = h.pools.setAssignments('docker/dev', 'browser', [{ poolId: b.id }]);
    assert.deepEqual(swapped.assignments.filter((x) => x.state === 'assigned').map((x) => x.poolName), ['B']);
    assert.throws(() => h.pools.setAssignments('kubernetes/dev', 'browser', [{ poolId: a.id }]), /Docker targets/);
    assert.deepEqual(h.pools.assignToMany(a.id, ['docker/other']).assigned, ['docker/other']);
    assert.ok(h.requests.includes('docker/dev'), 'assigning asks the reconciler to deliver');
  } finally {
    h.done();
  }
});
