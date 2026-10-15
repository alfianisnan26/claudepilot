import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { CHAT_FOLDER_UNTRUSTED, type ChatFolderScan } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { CP_SESSION, CP_SESSION_PATH, TRUST_EMPTY_HASH } from './host.js';
import { ChatStore } from './store.js';
import { autoTrustable, autoTrustRefusal, FOLDER_CHANGED, FOLDER_NOT_TRUSTED, parseTrustScan, scanFolder, trustFolder, untrustedError, type FolderScan, type HostScan } from './trust.js';
import { createChatTrustRoutes } from './trustRoutes.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** What `trustscan` prints for a folder with an .mcp.json and a settings file. */
const SCAN_A: HostScan = {
  hash: HASH_A,
  files: ['.mcp.json', '.claude/settings.json'],
  invalid: [],
  mcpServers: ['github'],
  hooks: ['SessionStart'],
  plugins: ['formatter@tools'],
  allowRules: 2,
  envNames: ['NODE_OPTIONS'],
  rulesOnly: false,
  broadAllow: true,
};
const EMPTY: HostScan = { hash: TRUST_EMPTY_HASH, files: [], invalid: [], mcpServers: [], hooks: [], plugins: [], allowRules: 0, envNames: [], rulesOnly: true, broadAllow: false };

/* ========================= parsing (pure) ========================= */

test('parseTrustScan: reads the host’s line; names are one line each, redacted, bounded and unique', () => {
  assert.deepEqual(parseTrustScan(`${JSON.stringify(SCAN_A)}\n`), SCAN_A);
  assert.deepEqual(parseTrustScan(JSON.stringify(EMPTY)), EMPTY);
  const odd = parseTrustScan(
    JSON.stringify({ ...SCAN_A, envNames: ['A\nB', 'sk-ant-api03-CANARYaaaaBBBBccccDDDDeeeeFFFF-0123_xyz', 'x'.repeat(500), 'A B', '', '  '], hooks: ['Stop', 'Stop'] }),
  );
  assert.deepEqual(odd.envNames, ['A B', '[redacted]', `${'x'.repeat(199)}…`]);
  assert.deepEqual(odd.hooks, ['Stop']);
  const many = parseTrustScan(JSON.stringify({ ...SCAN_A, mcpServers: Array.from({ length: 1500 }, (_, i) => `s${i}`) }));
  assert.equal(many.mcpServers.length, 1000);
});

test('parseTrustScan: rulesOnly is the host’s word when it gives one, false from a host that doesn’t (T-38)', () => {
  const rules = { ...EMPTY, hash: HASH_A, files: ['.claude/settings.json'], allowRules: 3 };
  assert.equal(parseTrustScan(JSON.stringify({ ...rules, rulesOnly: true })).rulesOnly, true);
  assert.equal(parseTrustScan(JSON.stringify({ ...rules, rulesOnly: undefined })).rulesOnly, false);
  assert.throws(() => parseTrustScan(JSON.stringify({ ...rules, rulesOnly: 'yes' })), (e) => isAppError(e) && e.status === 503);
});

test('parseTrustScan: broadAllow is the host’s word when it gives one, true from a host that doesn’t (T-366, fail closed)', () => {
  const rules = { ...EMPTY, hash: HASH_A, files: ['.claude/settings.json'], allowRules: 3 };
  assert.equal(parseTrustScan(JSON.stringify({ ...rules, broadAllow: false })).broadAllow, false);
  assert.equal(parseTrustScan(JSON.stringify({ ...rules, broadAllow: true })).broadAllow, true);
  assert.equal(parseTrustScan(JSON.stringify({ ...rules, broadAllow: undefined })).broadAllow, true);
  assert.throws(() => parseTrustScan(JSON.stringify({ ...rules, broadAllow: 'no' })), (e) => isAppError(e) && e.status === 503);
});

test('autoTrustable: a folder with rules only, trusted before at another hash (T-38) or never (T-366), never with a broad allow rule or anything that loads', () => {
  const rules: FolderScan = { workspaceId: 'docker/ws1', folder: '/home/node/proj', ...EMPTY, hash: HASH_B, files: ['.claude/settings.json'], allowRules: 3, empty: false, trusted: false };
  const before = { hash: HASH_A };
  assert.equal(autoTrustable(rules, before), true);
  assert.equal(autoTrustable(rules, null), true, 'never trusted (T-366): trusted the first time');
  assert.equal(autoTrustable(rules, { hash: null }), true);
  assert.equal(autoTrustable({ ...rules, trusted: true }, before), false);
  assert.equal(autoTrustable({ ...rules, empty: true }, null), false);
  assert.equal(autoTrustable({ ...rules, rulesOnly: false }, before), false);
  assert.equal(autoTrustable({ ...rules, broadAllow: true }, before), false, 're-trust stops on a broad rule (T-366)');
  assert.equal(autoTrustable({ ...rules, broadAllow: true }, null), false, 'first trust too');
  for (const extra of [{ hooks: ['Stop'] }, { mcpServers: ['x'] }, { plugins: ['p@m'] }, { envNames: ['NODE_OPTIONS'] }, { invalid: ['.claude/settings.json'] }, { files: ['.mcp.json'] }]) {
    assert.equal(autoTrustable({ ...rules, ...extra }, before), false, JSON.stringify(extra));
    assert.equal(autoTrustable({ ...rules, ...extra }, null), false, JSON.stringify(extra));
  }
});

test('autoTrustRefusal: says why by name, never a rule or a value (T-366)', () => {
  const rules: FolderScan = { workspaceId: 'docker/ws1', folder: '/home/node/proj', ...EMPTY, hash: HASH_B, files: ['.claude/settings.json'], allowRules: 3, empty: false, trusted: false };
  assert.equal(autoTrustRefusal(rules), null);
  assert.equal(autoTrustRefusal({ ...rules, broadAllow: true }), 'an allow rule runs any command or covers everything');
  assert.equal(autoTrustRefusal({ ...rules, hooks: ['SessionStart'], rulesOnly: false }), 'it loads hooks');
  assert.equal(autoTrustRefusal({ ...rules, files: ['.mcp.json'], mcpServers: ['github'], rulesOnly: false }), 'it starts MCP servers');
  assert.equal(autoTrustRefusal({ ...rules, plugins: ['p@m'] }), 'it enables plugins');
  assert.equal(autoTrustRefusal({ ...rules, envNames: ['NODE_OPTIONS'], rulesOnly: false }), 'it sets environment variables');
  assert.equal(autoTrustRefusal({ ...rules, invalid: ['.claude/settings.json'] }), 'a settings file can’t be read');
  assert.equal(autoTrustRefusal({ ...rules, rulesOnly: false }), 'it holds more than permission rules');
  assert.equal(autoTrustRefusal({ ...rules, hooks: ['Stop'], broadAllow: true }), 'it loads hooks; an allow rule runs any command or covers everything');
  const e = untrustedError({ ...rules, autoRefusal: 'it loads hooks' }, false);
  assert.equal(e.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: it loads hooks.`);
  assert.equal(untrustedError(rules, true).message, FOLDER_CHANGED, 'no reason when the policy did not look');
});

test('parseTrustScan: anything off is a 503, never a scan that reads as empty', () => {
  for (const out of [
    '',
    'not json',
    '[]',
    JSON.stringify({ ...SCAN_A, hash: 'nope' }),
    JSON.stringify({ ...SCAN_A, hash: undefined }),
    JSON.stringify({ ...SCAN_A, files: ['.env'] }),
    JSON.stringify({ ...SCAN_A, invalid: ['../x'] }),
    JSON.stringify({ ...SCAN_A, mcpServers: [1] }),
    JSON.stringify({ ...SCAN_A, envNames: 'NODE_OPTIONS' }),
    JSON.stringify({ ...SCAN_A, allowRules: -1 }),
    JSON.stringify({ ...SCAN_A, allowRules: 1.5 }),
    JSON.stringify({ ...SCAN_A, files: [] }), // nothing there, yet a hash of something
    JSON.stringify({ ...EMPTY, files: ['.mcp.json'] }), // something there, yet the empty hash
  ])
    assert.throws(
      () => parseTrustScan(out),
      (e) => isAppError(e) && e.status === 503,
      out,
    );
});

/* ========================= scanFolder / trustFolder (fake workspace) ========================= */

class FakeExec implements ExecSession {
  readonly #data: ((b: Buffer) => void)[] = [];
  readonly #exit: ((code: number | null) => void)[] = [];
  closed = false;
  write(): void {}
  close(): void {
    this.closed = true;
  }
  onData(fn: (b: Buffer) => void): void {
    this.#data.push(fn);
  }
  onExit(fn: (code: number | null) => void): void {
    this.#exit.push(fn);
  }
  push(chunk: string): void {
    for (const fn of this.#data) fn(Buffer.from(chunk));
  }
  exit(code: number | null): void {
    for (const fn of this.#exit) fn(code);
  }
}

/** A workspace whose `trustscan` prints `out` and exits `code` (or never answers, with `hang`). */
class FakeWorkspaces {
  readonly calls: string[][] = [];
  readonly execs: FakeExec[] = [];
  out = JSON.stringify(SCAN_A);
  code: number | null = 0;
  hang = false;
  fail: Error | null = null;
  async exec(target: string, name: string, command: string[]): Promise<ExecSession> {
    this.calls.push([`${target}/${name}`, ...command]);
    if (this.fail) throw this.fail;
    const exec = new FakeExec();
    this.execs.push(exec);
    if (!this.hang)
      setTimeout(() => {
        exec.push(`${this.out}\n`);
        exec.exit(this.code);
      }, 0);
    return exec;
  }
}

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-trust-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const ws = new FakeWorkspaces();
  const workspaces = ws as unknown as Workspaces;
  const controller: { installHost?: (workspaceId: string) => Promise<void> } = {};
  const app = new Hono();
  // Like app.ts: AppErrors keep their status, message and details.
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  });
  app.route('/', createChatTrustRoutes({ controller, workspaces, store }));
  const trustRows = () => store.db!.prepare('SELECT * FROM chat_folder_trust').all() as Record<string, unknown>[];
  const done = () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, ws, workspaces, controller, app, trustRows, done };
}

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

test('scanFolder: runs trustscan on the tidied folder and reads it as a scan; empty means no settings files at all', async () => {
  const h = await harness();
  try {
    const scan = await scanFolder(h.workspaces, h.store, ' docker/ws1 ', '/home/node/proj/../proj/', {});
    assert.deepEqual(h.ws.calls[0], ['docker/ws1', 'sh', CP_SESSION_PATH, 'trustscan', '/home/node/proj']);
    assert.deepEqual(scan, { workspaceId: 'docker/ws1', folder: '/home/node/proj', ...SCAN_A, empty: false, trusted: false });
    assert.ok(h.ws.execs[0]!.closed, 'the exec is closed once it exited');

    h.ws.out = JSON.stringify(EMPTY);
    const empty = await scanFolder(h.workspaces, h.store, 'docker/ws1', '/home/node', {});
    assert.equal(empty.empty, true);
    assert.equal(empty.trusted, false);

    // Settings files that name nothing still have to be trusted: Claude Code loads them all the same.
    h.ws.out = JSON.stringify({ ...EMPTY, hash: HASH_B, files: ['.claude/settings.json'], invalid: ['.claude/settings.json'] });
    const unreadable = await scanFolder(h.workspaces, h.store, 'docker/ws1', '/home/node/x', {});
    assert.deepEqual([unreadable.empty, unreadable.invalid], [false, ['.claude/settings.json']]);
  } finally {
    h.done();
  }
});

test('trustFolder: stores the trust (names only, when, who) only while the hash is the one confirmed; a changed one is a 409 with the new scan', async () => {
  const h = await harness();
  try {
    const req = { workspaceId: 'docker/ws1', folder: '/home/node/proj', hash: HASH_A };
    const trusted = await trustFolder(h.workspaces, h.store, req, { actor: 'ui' });
    assert.equal(trusted.trusted, true);
    const [row] = h.trustRows();
    assert.equal(row!.workspace_id, 'docker/ws1');
    assert.equal(row!.folder, '/home/node/proj');
    assert.equal(row!.scan_hash, HASH_A);
    assert.equal(row!.actor, 'ui');
    assert.ok(Date.parse(row!.trusted_at as string) > Date.now() - 60_000);
    assert.deepEqual(JSON.parse(row!.scan as string), {
      files: SCAN_A.files,
      invalid: [],
      mcpServers: SCAN_A.mcpServers,
      hooks: SCAN_A.hooks,
      plugins: SCAN_A.plugins,
      allowRules: 2,
      envNames: SCAN_A.envNames,
    });
    assert.equal((await scanFolder(h.workspaces, h.store, 'docker/ws1', '/home/node/proj/')).trusted, true, 'the same folder, tidied');
    assert.equal((await scanFolder(h.workspaces, h.store, 'docker/ws2', '/home/node/proj')).trusted, false, 'per workspace');
    assert.equal((await scanFolder(h.workspaces, h.store, 'docker/ws1', '/home/node/other')).trusted, false, 'per folder');

    // The files change: the old trust no longer holds, and confirming the old hash stores nothing.
    h.ws.out = JSON.stringify({ ...SCAN_A, hash: HASH_B, hooks: ['SessionStart', 'PreToolUse'] });
    assert.equal((await scanFolder(h.workspaces, h.store, 'docker/ws1', '/home/node/proj')).trusted, false);
    await assert.rejects(trustFolder(h.workspaces, h.store, req), (e) => {
      assert.ok(isAppError(e));
      assert.equal(e.code, CHAT_FOLDER_UNTRUSTED);
      assert.equal(e.status, 409);
      assert.equal((e.details as ChatFolderScan).hash, HASH_B);
      assert.deepEqual((e.details as ChatFolderScan).hooks, ['SessionStart', 'PreToolUse']);
      return true;
    });
    assert.equal(h.trustRows()[0]!.scan_hash, HASH_A);
    await trustFolder(h.workspaces, h.store, { ...req, hash: HASH_B.toUpperCase() });
    assert.equal(h.trustRows()[0]!.scan_hash, HASH_B, 'trusting again replaces it');
    assert.equal(h.trustRows().length, 1);

    // Checked before anything runs.
    const calls = h.ws.calls.length;
    await assert.rejects(trustFolder(h.workspaces, h.store, { ...req, hash: 'abc' }), /Say which scan you checked/);
    await assert.rejects(trustFolder(h.workspaces, h.store, { ...req, folder: 'proj' }), (e) => isAppError(e) && e.status === 400);
    await assert.rejects(trustFolder(h.workspaces, h.store, { ...req, workspaceId: 'ws1' }), (e) => isAppError(e) && e.status === 422);
    await assert.rejects(trustFolder(h.workspaces, h.store, { hash: HASH_A } as never), (e) => isAppError(e) && e.status === 422);
    assert.equal(h.ws.calls.length, calls);
  } finally {
    h.done();
  }
});

test('scanFolder: a refused folder is a 400; an unreachable or silent workspace, a failed host or a bad answer is a 503', async () => {
  const h = await harness();
  try {
    h.ws.code = 2;
    h.ws.out = '';
    await assert.rejects(scanFolder(h.workspaces, h.store, 'docker/ws1', '/etc'), (e) => isAppError(e) && e.status === 400 && /^Can’t use that folder\./.test(e.message));

    // An old host refuses trustscan as an unknown command: the failed install is the reason given.
    await assert.rejects(
      scanFolder(h.workspaces, h.store, 'docker/ws1', '/home/node', { install: async () => Promise.reject(new Error("This workspace's image doesn't have the current chat host yet.")) }),
      (e) => isAppError(e) && e.status === 503 && e.message === "This workspace's image doesn't have the current chat host yet.",
    );

    h.ws.code = 1;
    await assert.rejects(scanFolder(h.workspaces, h.store, 'docker/ws1', '/home/node'), /Couldn’t check the folder’s project settings \(exit 1\)/);
    h.ws.code = 0;
    h.ws.out = '{"hash": "nope"}';
    await assert.rejects(scanFolder(h.workspaces, h.store, 'docker/ws1', '/home/node'), /unexpected answer/);

    h.ws.fail = new AppError('SERVICE_UNAVAILABLE', 'container 3f2a is not running');
    await assert.rejects(scanFolder(h.workspaces, h.store, 'docker/ws1', '/home/node'), (e) => isAppError(e) && e.status === 503 && e.expose && e.message === 'Couldn’t reach the workspace: container 3f2a is not running');
    h.ws.fail = new AppError('NOT_FOUND', 'That workspace doesn’t exist.');
    await assert.rejects(scanFolder(h.workspaces, h.store, 'docker/ws1', '/home/node'), (e) => isAppError(e) && e.status === 404);
    h.ws.fail = null;

    h.ws.hang = true;
    await assert.rejects(scanFolder(h.workspaces, h.store, 'docker/ws1', '/home/node', { timeoutMs: 30 }), /took too long/);
    assert.ok(h.ws.execs.at(-1)!.closed, 'the silent exec was closed');
  } finally {
    h.done();
  }
});

test('untrustedError: a 409 FOLDER_UNTRUSTED carrying the scan, saying whether the files changed since they were trusted', () => {
  const scan = { workspaceId: 'docker/ws1', folder: '/home/node/p', ...SCAN_A, empty: false, trusted: false };
  const changed = untrustedError(scan, true);
  assert.deepEqual([changed.code, changed.status, changed.message, changed.details], [CHAT_FOLDER_UNTRUSTED, 409, FOLDER_CHANGED, scan]);
  assert.equal(FOLDER_CHANGED, "This folder's project settings changed since you trusted it. Check them and trust it again.");
  assert.equal(untrustedError(scan, false).message, FOLDER_NOT_TRUSTED);
  assert.deepEqual(changed.toJSON().error.details, scan, 'the details reach the client');
});

/* ========================= routes ========================= */

test('routes: GET /scan answers the scan; POST / trusts it as scanned; a stale hash is a 409 carrying the new scan', async () => {
  const h = await harness();
  try {
    const installs: string[] = [];
    h.controller.installHost = async (workspaceId) => void installs.push(workspaceId);

    const res = await h.app.request(`/scan?workspaceId=docker%2Fws1&folder=${encodeURIComponent('/home/node/proj')}`);
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as { data: FolderScan };
    assert.deepEqual(data, { workspaceId: 'docker/ws1', folder: '/home/node/proj', ...SCAN_A, empty: false, trusted: false });
    assert.deepEqual(installs, ['docker/ws1'], 'the host is brought up to date first');

    const post = (body: unknown) => h.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await post({ workspaceId: 'docker/ws1', folder: '/home/node/proj', hash: HASH_A });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { data: { ok: true } });
    assert.equal(h.trustRows()[0]!.actor, 'ui');
    const again = (await (await h.app.request('/scan?workspaceId=docker/ws1&folder=/home/node/proj')).json()) as { data: FolderScan };
    assert.equal(again.data.trusted, true);

    h.ws.out = JSON.stringify({ ...SCAN_A, hash: HASH_B });
    const stale = await post({ workspaceId: 'docker/ws1', folder: '/home/node/proj', hash: HASH_A });
    assert.equal(stale.status, 409);
    const body = (await stale.json()) as ErrorBody;
    assert.equal(body.error.code, 'FOLDER_UNTRUSTED');
    assert.equal((body.error.details as ChatFolderScan).hash, HASH_B);
    assert.equal((body.error.details as ChatFolderScan).trusted, false);
  } finally {
    h.done();
  }
});

test('routes: a missing workspace or folder, a relative folder and a bad body are refused before the workspace is asked', async () => {
  const h = await harness();
  try {
    assert.equal((await h.app.request('/scan?folder=/home/node')).status, 422);
    assert.equal((await h.app.request('/scan?workspaceId=docker/ws1')).status, 400);
    assert.equal((await h.app.request('/scan?workspaceId=docker/ws1&folder=proj')).status, 400);
    assert.equal((await h.app.request('/scan?workspaceId=docker/ws1&folder=%2Fhome%2Fnode%00x')).status, 400);
    const post = (body: string) => h.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post(JSON.stringify({ workspaceId: 'docker/ws1', folder: '/home/node' }))).status, 422, 'no hash');
    assert.equal((await post(JSON.stringify({ workspaceId: 'docker/ws1', folder: '../etc', hash: HASH_A }))).status, 400);
    assert.equal(h.ws.calls.length, 0);
    // The host refuses what it must (outside the home folder, the portal's own files).
    h.ws.code = 2;
    const refused = await h.app.request('/scan?workspaceId=docker/ws1&folder=/etc');
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as ErrorBody).error.message, /only in the workspace’s home folder/);
  } finally {
    h.done();
  }
});

/* ========================= end to end (the real host script) ========================= */

/** Runs cp-session commands locally, as `workspaces.exec` would in the workspace (stdin left open). */
class LocalExec implements ExecSession {
  readonly #child;
  constructor(script: string, command: string[], env: NodeJS.ProcessEnv) {
    this.#child = spawn('sh', [script, ...command.slice(2)], { env });
    this.#child.stdin.on('error', () => {});
  }
  write(data: string) {
    this.#child.stdin.write(data);
  }
  close() {
    this.#child.kill();
  }
  onData(fn: (b: Buffer) => void) {
    this.#child.stdout.on('data', fn);
    this.#child.stderr.on('data', fn); // merged, like the runtimes
  }
  onExit(fn: (code: number | null) => void) {
    this.#child.on('close', (code) => fn(code));
  }
}

test('end to end: scan, trust, change a file, and the trust no longer holds — through the real cp-session script', async () => {
  const h = await harness();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-trust-root-')));
  try {
    const script = join(root, '.cp-session');
    writeFileSync(script, CP_SESSION);
    chmodSync(script, 0o755);
    const env = { ...process.env, CLAUDEPILOT_FILES_ROOT: root };
    (h.ws as unknown as { exec: Workspaces['exec'] }).exec = async (_t, _n, command) => {
      assert.equal(command[1], CP_SESSION_PATH);
      return new LocalExec(script, command, env);
    };
    const proj = join(root, 'proj');
    mkdirSync(join(proj, '.claude'), { recursive: true });
    writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'npx', env: { GITHUB_TOKEN: 'ghp_never' } } } }));
    writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }, env: { FOO: 'bar' } }));

    const get = async () => ((await (await h.app.request(`/scan?workspaceId=docker/ws1&folder=${encodeURIComponent(proj)}`)).json()) as { data: FolderScan }).data;
    const scan = await get();
    assert.deepEqual(
      { ...scan, hash: undefined },
      { workspaceId: 'docker/ws1', folder: proj, hash: undefined, empty: false, files: ['.mcp.json', '.claude/settings.json'], invalid: [], mcpServers: ['github'], hooks: ['SessionStart'], plugins: [], allowRules: 0, envNames: ['FOO'], trusted: false, rulesOnly: false, broadAllow: false },
    );
    assert.ok(!JSON.stringify(scan).includes('ghp_never'));

    const post = (hash: string) => h.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'docker/ws1', folder: proj, hash }) });
    assert.equal((await post(scan.hash)).status, 200);
    assert.equal((await get()).trusted, true);

    writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
    const changed = await get();
    assert.deepEqual([changed.trusted, changed.allowRules, changed.files.length], [false, 1, 3]);
    assert.equal((await post(scan.hash)).status, 409);

    // rulesOnly (T-38): permission lists and $schema only, in files that were all read, and no .mcp.json.
    const rulesDir = join(root, 'rules');
    mkdirSync(join(rulesDir, '.claude'), { recursive: true });
    const settings = (v: unknown, name = 'settings.json') => writeFileSync(join(rulesDir, '.claude', name), typeof v === 'string' ? v : JSON.stringify(v));
    const rulesOnly = async () => ((await (await h.app.request(`/scan?workspaceId=docker/ws1&folder=${encodeURIComponent(rulesDir)}`)).json()) as { data: FolderScan }).data.rulesOnly;
    settings({ $schema: 'https://json.schemastore.org/claude-code-settings.json', permissions: { allow: ['Bash(git status)'], deny: ['Read(./.env)'], ask: [] } });
    settings({ permissions: { allow: ['Edit'] } }, 'settings.local.json');
    assert.equal(await rulesOnly(), true);
    for (const v of [
      { permissions: { allow: ['Bash'], defaultMode: 'bypassPermissions' } },
      { permissions: { allow: ['Bash'], additionalDirectories: ['/'] } },
      { permissions: { allow: [1] } },
      { permissions: { allow: 'Bash' } },
      { permissions: [] },
      { permissions: { allow: ['Bash'] }, apiKeyHelper: 'echo x' },
      { permissions: { allow: ['Bash'] }, statusLine: { type: 'command', command: 'echo x' } },
      { permissions: { allow: ['Bash'] }, env: {} },
      { hooks: {} },
      'not json',
    ]) {
      settings(v);
      assert.equal(await rulesOnly(), false, JSON.stringify(v));
    }
    settings({ permissions: { allow: ['Bash'] } });
    writeFileSync(join(rulesDir, '.mcp.json'), JSON.stringify({}));
    assert.equal(await rulesOnly(), false, 'an .mcp.json, even an empty one');

    const home = (await (await h.app.request(`/scan?workspaceId=docker/ws1&folder=${encodeURIComponent(root)}`)).json()) as { data: FolderScan };
    assert.deepEqual([home.data.empty, home.data.hash], [true, TRUST_EMPTY_HASH]);
  } finally {
    h.done();
    rmSync(root, { recursive: true, force: true });
  }
});
