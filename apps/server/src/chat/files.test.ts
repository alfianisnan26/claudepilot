import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import type { ChatDiff, ChatFolder } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { ChatController } from './controller.js';
import { attachmentHeader, createChatFileRoutes } from './fileRoutes.js';
import { DIFF_MAX_FILES, openDownload, parseDiff, parseListing, sessionFolder, unquote, workspacePath } from './files.js';
import { CP_SESSION, CP_SESSION_PATH } from './host.js';
import { ChatStore } from './store.js';

/* ========================= parsing (pure) ========================= */

test('parseListing: types, file sizes, ISO times and names with tabs; folders first, then by name', () => {
  const out = [
    'f\t5\t1791654855.4837820020\tb.txt',
    'd\t4096\t1791654855.0000000000\tsrc',
    'l\t12\t1791654855.5\tlink',
    'f\t10\t1791654855\tfile10.txt',
    'f\t2\t1791654855\tfile2.txt',
    'p\t0\t1791654855\tpipe',
    'd\t4096\t1791654855\tApp',
    'f\t1\t1791654855\ttab\tname',
    'garbage that is not an entry',
    '',
  ].join('\n');
  const folder = parseListing('/home/node/proj', out);
  assert.equal(folder.path, '/home/node/proj');
  assert.equal(folder.truncated, false);
  assert.deepEqual(
    folder.entries.map((e) => [e.name, e.type, e.size]),
    [
      ['App', 'dir', null],
      ['src', 'dir', null],
      ['b.txt', 'file', 5],
      ['file2.txt', 'file', 2],
      ['file10.txt', 'file', 10],
      ['link', 'symlink', null],
      ['pipe', 'other', null],
      ['tab\tname', 'file', 1],
    ],
  );
  const b = folder.entries.find((e) => e.name === 'b.txt')!;
  assert.equal(b.path, '/home/node/proj/b.txt');
  assert.equal(b.modifiedAt, new Date(1791654855483).toISOString());
  assert.equal(parseListing('/', 'd\t1\t1\tetc\n').entries[0]!.path, '/etc');
});

test('parseListing: #truncated marks a cut listing; nothing at all is an empty folder', () => {
  const folder = parseListing('/home/node', 'f\t1\t1\ta\n#truncated\n');
  assert.equal(folder.truncated, true);
  assert.equal(folder.entries.length, 1);
  assert.deepEqual(parseListing('/home/node', ''), { path: '/home/node', entries: [], truncated: false });
});

test('unquote: git’s C-quoted paths, with escapes and octal UTF-8 bytes; plain paths pass', () => {
  assert.equal(unquote('"a\\tb"'), 'a\tb');
  assert.equal(unquote('"say \\"hi\\"\\\\"'), 'say "hi"\\');
  assert.equal(unquote('"\\303\\251t\\303\\251.txt"'), 'été.txt');
  assert.equal(unquote('"sp ace.txt"'), 'sp ace.txt');
  assert.equal(unquote('plain.txt'), 'plain.txt');
  assert.equal(unquote('"'), '"');
});

/** Real `cp-session diff` output from a repository with every kind of change (see host.test.ts). */
const DIFF_OUT = [
  '#status',
  ' M a.txt',
  ' M b.bin',
  ' D del.txt',
  'R  old.txt -> new.txt',
  ' M "sp ace.txt"',
  'A  staged.txt',
  ' M é.txt',
  '?? untracked.txt',
  '#numstat',
  '2\t1\ta.txt',
  '-\t-\tb.bin',
  '0\t1\tdel.txt',
  '0\t0\told.txt => new.txt',
  '1\t0\tsp ace.txt',
  '1\t0\tstaged.txt',
  '1\t0\té.txt',
  '#patch',
  'diff --git a/a.txt b/a.txt',
  'index 814f4a4..ddc897f 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,2 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  '+three',
  '',
].join('\n');

test('parseDiff: files from status with numstat counts; binary and untracked counts are null; renames count for the new path', () => {
  const diff = parseDiff('/home/node/repo', DIFF_OUT);
  assert.equal(diff.repo, '/home/node/repo');
  assert.equal(diff.truncated, false);
  assert.deepEqual(diff.files, [
    { path: 'a.txt', status: 'M', additions: 2, deletions: 1 },
    { path: 'b.bin', status: 'M', additions: null, deletions: null },
    { path: 'del.txt', status: 'D', additions: 0, deletions: 1 },
    { path: 'new.txt', status: 'R', additions: 0, deletions: 0 },
    { path: 'sp ace.txt', status: 'M', additions: 1, deletions: 0 },
    { path: 'staged.txt', status: 'A', additions: 1, deletions: 0 },
    { path: 'é.txt', status: 'M', additions: 1, deletions: 0 },
    { path: 'untracked.txt', status: '??', additions: null, deletions: null },
  ]);
  assert.equal(diff.patch, DIFF_OUT.slice(DIFF_OUT.indexOf('diff --git')));
});

test('parseDiff: status letters for every porcelain pair, and rename forms in status and numstat', () => {
  const out = [
    '#status',
    'MM both.txt',
    'AM added-then-edited.txt',
    'MD edited-then-deleted.txt',
    ' A intent.txt',
    ' T typechange',
    'UU conflict.txt',
    'AA both-added.txt',
    'C  orig.txt -> copy.txt',
    'R  "tab\\there" -> "now spaced.txt"',
    'RM src/lib/x.ts -> src/core/x.ts',
    'R  docs/old.md -> docs/sub/old.md',
    '#numstat',
    '1\t1\tboth.txt',
    '3\t0\t{"tab\\there" => "now spaced.txt"}',
    '"tab\\there" => "now spaced.txt"',
    '5\t2\t"tab\\there" => "now spaced.txt"',
    '4\t1\tsrc/{lib => core}/x.ts',
    '0\t0\tdocs/{ => sub}/old.md',
    '#patch',
    '',
  ].join('\n');
  const files = new Map(parseDiff('/r', out).files.map((f) => [f.path, f]));
  const letter = (p: string) => files.get(p)?.status;
  assert.equal(letter('both.txt'), 'M');
  assert.equal(letter('added-then-edited.txt'), 'A');
  assert.equal(letter('edited-then-deleted.txt'), 'D');
  assert.equal(letter('intent.txt'), 'A');
  assert.equal(letter('typechange'), 'T');
  assert.equal(letter('conflict.txt'), 'U');
  assert.equal(letter('both-added.txt'), 'U');
  assert.equal(letter('copy.txt'), 'C');
  assert.equal(letter('now spaced.txt'), 'R');
  assert.equal(letter('src/core/x.ts'), 'R');
  assert.deepEqual(files.get('now spaced.txt'), { path: 'now spaced.txt', status: 'R', additions: 5, deletions: 2 });
  assert.deepEqual(files.get('src/core/x.ts'), { path: 'src/core/x.ts', status: 'R', additions: 4, deletions: 1 });
  assert.deepEqual(files.get('docs/sub/old.md'), { path: 'docs/sub/old.md', status: 'R', additions: 0, deletions: 0 });
});

test('parseDiff: #norepo, empty sections, a cut patch drops its partial line, and too many files', () => {
  assert.deepEqual(parseDiff('/r', '#norepo\n'), { repo: null, files: [], patch: '', truncated: false });
  assert.deepEqual(parseDiff('/r', '#status\n#numstat\n#patch\n'), { repo: '/r', files: [], patch: '', truncated: false });

  const cut = parseDiff('/r', '#status\n M a\n#numstat\n1\t0\ta\n#patch\ndiff --git a/a b/a\n+whole line\n+part of a li\n#truncated\n');
  assert.equal(cut.truncated, true);
  assert.equal(cut.patch, 'diff --git a/a b/a\n+whole line\n');
  assert.deepEqual(cut.files, [{ path: 'a', status: 'M', additions: 1, deletions: 0 }]);

  // Cut by the reader (no marker): the same, flagged by the caller.
  assert.deepEqual(parseDiff('/r', '#status\n M a\n#numstat\n1\t0\ta\n#patch\n+one\n+tw', true).patch, '+one\n');

  const many = `#status\n${Array.from({ length: DIFF_MAX_FILES + 5 }, (_, i) => `?? f${i}`).join('\n')}\n#numstat\n#patch\n`;
  const capped = parseDiff('/r', many);
  assert.equal(capped.files.length, DIFF_MAX_FILES);
  assert.equal(capped.truncated, true);

  assert.throws(() => parseDiff('/r', 'sh: 1: git: not found\n'), (e) => isAppError(e) && e.status === 503);
});

test('workspacePath tidies absolute paths and refuses the rest; attachmentHeader keeps the header safe', () => {
  assert.equal(workspacePath('/home/node/a//b/../c/'), '/home/node/a/c');
  assert.equal(workspacePath('/'), '/');
  for (const bad of ['', 'relative/x', '~/x', `/x\0y`, `/${'a'.repeat(5000)}`]) assert.throws(() => workspacePath(bad), (e) => isAppError(e) && e.status === 400);

  assert.equal(attachmentHeader('report.pdf'), 'attachment; filename="report.pdf"');
  assert.equal(attachmentHeader('a "b" \\c 100%.txt'), `attachment; filename="a _b_ _c 100_.txt"; filename*=UTF-8''a%20%22b%22%20%5Cc%20100%25.txt`);
  assert.equal(attachmentHeader('résumé.pdf'), `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`);
  assert.equal(attachmentHeader('new\r\nline'), `attachment; filename="new__line"; filename*=UTF-8''new%0D%0Aline`);
  assert.equal(attachmentHeader("it's (1).txt"), `attachment; filename="it's (1).txt"`);
  assert.match(attachmentHeader('日本'), /^attachment; filename="__"; filename\*=UTF-8''%E6%97%A5%E6%9C%AC$/);
});

/* ========================= routes (fake workspaces) ========================= */

/** A controllable stand-in for one `workspaces.exec` call. */
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
  push(chunk: string | Buffer): void {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    for (const fn of this.#data) fn(b);
  }
  exit(code: number | null = 0): void {
    for (const fn of this.#exit) fn(code);
  }
}

/** What one host command answers: its output and exit code, or a script that drives the exec. */
type Reply = { out?: string | Buffer | (string | Buffer)[]; code?: number | null } | ((exec: FakeExec) => void);

/** A fake Workspaces whose `exec` answers cp-session commands with canned output. */
class FakeWorkspaces {
  readonly calls: string[][] = [];
  readonly execs: FakeExec[] = [];
  reply: (args: string[]) => Reply = () => ({ code: 0 });
  /** Thrown by `exec`, as the manager does for a stopped or missing workspace. */
  fail: Error | null = null;
  async exec(target: string, name: string, command: string[]): Promise<ExecSession> {
    this.calls.push([`${target}/${name}`, ...command]);
    if (this.fail) throw this.fail;
    const exec = new FakeExec();
    this.execs.push(exec);
    const reply = this.reply(command.slice(2)); // ['sh', <script>, <cmd>, ...]
    setTimeout(() => {
      if (typeof reply === 'function') return reply(exec);
      for (const chunk of [reply.out ?? []].flat()) exec.push(chunk);
      exec.exit(reply.code ?? 0);
    }, 0);
    return exec;
  }
}

/** A store with sessions A (in ~/proj), H (no folder: the home folder), and the routes around a fake workspace. */
async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-files-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const chat = new ChatStore(store);
  chat.create({ id: 'A', workspaceId: 'docker/ws1', cwd: '/home/node/proj', title: 'A', origin: 'ui' });
  chat.create({ id: 'H', workspaceId: 'docker/ws1', cwd: '', title: 'H', origin: 'ui' });
  const ws = new FakeWorkspaces();
  const controller = new ChatController(store, ws as unknown as Workspaces);
  const app = new Hono();
  // Like app.ts: AppErrors keep their status and their (exposed) message.
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  });
  app.route('/', createChatFileRoutes({ controller, workspaces: ws as unknown as Workspaces, store }));
  const done = () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, ws, controller, app, done };
}

type ErrorBody = { error: { code: string; message: string } };

test('routes: files lists the session’s folder by default, or the folder asked for; 404 for an unknown session', async () => {
  const h = await harness();
  try {
    h.ws.reply = (args) => (args[0] === 'ls' ? { out: 'd\t4096\t1700000000\tsrc\nf\t3\t1700000000\ta.txt\n#truncated\n' } : { code: 2 });
    const res = await h.app.request('/A/files');
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as { data: ChatFolder };
    assert.deepEqual(h.ws.calls[0], ['docker/ws1', 'sh', CP_SESSION_PATH, 'ls', '/home/node/proj']);
    assert.equal(data.path, '/home/node/proj');
    assert.equal(data.truncated, true);
    assert.deepEqual(data.entries.map((e) => e.path), ['/home/node/proj/src', '/home/node/proj/a.txt']);

    await h.app.request(`/A/files?path=${encodeURIComponent('/home/node/proj/src/../lib/')}`);
    assert.deepEqual(h.ws.calls[1], ['docker/ws1', 'sh', CP_SESSION_PATH, 'ls', '/home/node/proj/lib'], 'the path is tidied first');

    await h.app.request('/H/files');
    assert.deepEqual(h.ws.calls[2]?.slice(-1), ['/home/node'], 'no folder stored: the home folder');

    for (const path of ['/nope/files', '/nope/files/download?path=/home/node/a', '/nope/diff']) assert.equal((await h.app.request(path)).status, 404, path);
    assert.equal(h.ws.calls.length, 3, 'nothing ran for an unknown session');
  } finally {
    h.done();
  }
});

test('routes: a refused path is a 400 with a friendly message; a relative one never reaches the workspace', async () => {
  const h = await harness();
  try {
    h.ws.reply = () => ({ code: 2 });
    const res = await h.app.request(`/A/files?path=${encodeURIComponent('/etc')}`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.match(body.error.message, /^Can’t open that folder\./);

    const dl = await h.app.request(`/A/files/download?path=${encodeURIComponent('/home/node/.claudepilot/x')}`);
    assert.equal(dl.status, 400);
    assert.match(((await dl.json()) as ErrorBody).error.message, /^Can’t download that file\./);

    const diff = await h.app.request('/A/diff');
    assert.equal(diff.status, 400);
    assert.match(((await diff.json()) as ErrorBody).error.message, /^Can’t read the session’s folder\./);

    const calls = h.ws.calls.length;
    assert.equal((await h.app.request('/A/files?path=proj/src')).status, 400);
    assert.equal((await h.app.request('/A/files/download')).status, 400, 'a download needs a path');
    assert.equal(h.ws.calls.length, calls);
  } finally {
    h.done();
  }
});

test('routes: a download streams the bytes as an attachment with safe headers', async () => {
  const h = await harness();
  try {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    h.ws.reply = (args) => (args[1] === '/home/node/proj/empty' ? { code: 0 } : { out: [bytes.subarray(0, 100), bytes.subarray(100)] });
    const res = await h.app.request(`/A/files/download?path=${encodeURIComponent('/home/node/proj/out/report "final".bin')}`);
    assert.equal(res.status, 200);
    assert.deepEqual(h.ws.calls[0], ['docker/ws1', 'sh', CP_SESSION_PATH, 'cat', '/home/node/proj/out/report "final".bin']);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="report _final_.bin"; filename*=UTF-8''report%20%22final%22.bin`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), 'sandbox');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes));

    const empty = await h.app.request('/A/files/download?path=/home/node/proj/empty');
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('content-disposition'), 'attachment; filename="empty"');
    assert.equal((await empty.arrayBuffer()).byteLength, 0, 'an empty file is an empty download');
  } finally {
    h.done();
  }
});

test('routes: a file over the limit is a 413; a read that fails midway aborts the body instead of ending it', async () => {
  const h = await harness();
  try {
    h.ws.reply = () => ({ code: 6 });
    const big = await h.app.request('/A/files/download?path=/home/node/big.iso');
    assert.equal(big.status, 413);
    assert.match(((await big.json()) as ErrorBody).error.message, /over 50 MB/);

    h.ws.reply = () => ({ out: 'first half', code: 1 });
    const broken = await h.app.request('/A/files/download?path=/home/node/a.txt');
    assert.equal(broken.status, 200, 'the bytes had started');
    await assert.rejects(broken.arrayBuffer());

    // Closing the download stops the read.
    h.ws.reply = () => (exec) => exec.push('some bytes'); // never exits
    const open = await h.app.request('/A/files/download?path=/home/node/a.txt');
    await open.body!.getReader().cancel();
    assert.equal(h.ws.execs.at(-1)!.closed, true);
  } finally {
    h.done();
  }
});

test('openDownload: bytes past the limit fail it (before or after the first byte), and a silent workspace times out', async () => {
  const ws = new FakeWorkspaces();
  const workspaces = ws as unknown as Workspaces;
  ws.reply = () => ({ out: Buffer.alloc(11) });
  await assert.rejects(openDownload(workspaces, 'docker/ws1', '/home/node/a', { maxBytes: 10 }), (e) => isAppError(e) && e.status === 413);
  assert.equal(ws.execs.at(-1)!.closed, true);

  ws.reply = () => ({ out: [Buffer.alloc(6), Buffer.alloc(6)] });
  const file = await openDownload(workspaces, 'docker/ws1', '/home/node/a', { maxBytes: 10 });
  assert.equal(file.name, 'a');
  await assert.rejects(new Response(file.body).arrayBuffer());
  assert.equal(ws.execs.at(-1)!.closed, true);

  ws.reply = () => () => {}; // never answers
  await assert.rejects(openDownload(workspaces, 'docker/ws1', '/home/node/a', { timeoutMs: 30 }), (e) => isAppError(e) && e.status === 503 && /too long/.test(e.message));
  assert.equal(ws.execs.at(-1)!.closed, true);
});

test('routes: diff reads the session’s folder into a ChatDiff, or repo null outside a repository', async () => {
  const h = await harness();
  try {
    h.ws.reply = () => ({ out: [DIFF_OUT.slice(0, 40), DIFF_OUT.slice(40)] });
    const res = await h.app.request('/A/diff');
    assert.equal(res.status, 200);
    assert.deepEqual(h.ws.calls[0], ['docker/ws1', 'sh', CP_SESSION_PATH, 'diff', '/home/node/proj']);
    const { data } = (await res.json()) as { data: ChatDiff };
    assert.deepEqual(data, parseDiff('/home/node/proj', DIFF_OUT));

    h.ws.reply = () => ({ out: '#norepo\n' });
    assert.deepEqual(((await (await h.app.request('/A/diff')).json()) as { data: ChatDiff }).data, { repo: null, files: [], patch: '', truncated: false });
  } finally {
    h.done();
  }
});

test('routes: an unreachable workspace is a 503 that says so; a missing one keeps its 404', async () => {
  const h = await harness();
  try {
    // The manager's own wrapping: a 503 whose message isn't exposed by default.
    h.ws.fail = new AppError('SERVICE_UNAVAILABLE', 'container 3f2a is not running');
    const res = await h.app.request('/A/files');
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as ErrorBody).error.message, 'Couldn’t reach the workspace: container 3f2a is not running');

    h.ws.fail = new AppError('NOT_FOUND', 'That workspace doesn’t exist.');
    const gone = await h.app.request('/A/diff');
    assert.equal(gone.status, 404);
    assert.equal(((await gone.json()) as ErrorBody).error.message, 'That workspace doesn’t exist.');

    h.ws.fail = null;
    h.ws.reply = () => ({ code: 127 });
    const odd = await h.app.request('/A/files');
    assert.equal(odd.status, 503);
    assert.equal(((await odd.json()) as ErrorBody).error.message, 'Couldn’t list that folder (exit 127).');
  } finally {
    h.done();
  }
});

test('routes: the host is brought up to date before each command, once at a time per workspace, and a failed install doesn’t block', async () => {
  const h = await harness();
  try {
    const order: string[] = [];
    let installs = 0;
    h.controller.installHost = async (workspaceId) => {
      installs++;
      order.push(`install ${workspaceId}`);
      await new Promise((r) => setTimeout(r, 20));
    };
    h.ws.reply = (args) => {
      order.push(args[0]!);
      return args[0] === 'ls' ? { out: '' } : { out: '#norepo\n' };
    };
    const [files, diff] = await Promise.all([h.app.request('/A/files'), h.app.request('/A/diff')]);
    assert.equal(files.status, 200);
    assert.equal(diff.status, 200);
    assert.equal(installs, 1, 'concurrent requests share one install');
    assert.equal(order[0], 'install docker/ws1');

    h.controller.installHost = async () => {
      throw new Error("This workspace's image doesn't have the current chat host yet.");
    };
    assert.equal((await h.app.request('/A/files')).status, 200, 'the command still runs, and here it works');

    // It fails too: an out-of-date host refuses commands it doesn't know, so the install's reason is reported.
    h.ws.reply = () => ({ code: 2 });
    const stale = await h.app.request('/A/files');
    assert.equal(stale.status, 503);
    assert.equal(((await stale.json()) as ErrorBody).error.message, "This workspace's image doesn't have the current chat host yet.");
  } finally {
    h.done();
  }
});

/* ========================= end to end (the real host script) ========================= */

/** Runs cp-session commands locally, as `workspaces.exec` would in the workspace. */
class LocalExec implements ExecSession {
  readonly #child;
  constructor(script: string, command: string[], env: NodeJS.ProcessEnv) {
    const args = command[1] === CP_SESSION_PATH ? [script, ...command.slice(2)] : command.slice(1);
    this.#child = spawn('sh', args, { env });
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

test('end to end: the routes list, download and diff through the real cp-session script', async () => {
  const h = await harness();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-files-root-')));
  try {
    const script = join(root, '.cp-session');
    writeFileSync(script, CP_SESSION);
    chmodSync(script, 0o755);
    const env = { ...process.env, CLAUDEPILOT_FILES_ROOT: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    (h.ws as unknown as { exec: Workspaces['exec'] }).exec = async (_t, _n, command) => new LocalExec(script, command, env);
    const repo = join(root, 'proj');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    const gitEnv = { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'init']]) execFileSync('git', args, { cwd: repo, env: gitEnv, stdio: 'ignore' });
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(repo, 'src', 'new file.ts'), 'export {};\n');
    h.store.db!.prepare('UPDATE chat_sessions SET cwd = ? WHERE id = ?').run(repo, 'A');

    const folder = ((await (await h.app.request('/A/files')).json()) as { data: ChatFolder }).data;
    assert.deepEqual(folder.entries.map((e) => [e.name, e.type]), [['.git', 'dir'], ['src', 'dir'], ['a.txt', 'file']]);
    assert.equal(folder.entries.find((e) => e.name === 'a.txt')?.size, 8);

    const dl = await h.app.request(`/A/files/download?path=${encodeURIComponent(join(repo, 'a.txt'))}`);
    assert.equal(await dl.text(), 'one\ntwo\n');
    assert.equal((await h.app.request(`/A/files/download?path=${encodeURIComponent(join(repo, 'src'))}`)).status, 400);

    const diff = ((await (await h.app.request('/A/diff')).json()) as { data: ChatDiff }).data;
    assert.equal(diff.repo, repo);
    assert.deepEqual(diff.files, [
      { path: 'a.txt', status: 'M', additions: 1, deletions: 0 },
      { path: 'src/', status: '??', additions: null, deletions: null },
    ]);
    assert.match(diff.patch, /^diff --git a\/a\.txt b\/a\.txt\n[\s\S]*\n\+two\n$/);
    assert.equal(sessionFolder(h.store, 'A'), repo);
  } finally {
    h.done();
    rmSync(root, { recursive: true, force: true });
  }
});
