import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CHAT_MAX_DOWNLOAD_BYTES } from '@portal/contracts';
import { CP_SESSION, DIFF_MAX_PATCH_BYTES, LS_MAX_ENTRIES, parseStartOutput } from './host.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(20);
  }
}

/** A stand-in for `claude -p`: on start it drops a marker in its cwd, then echoes a line per input line. */
const FAKE_CLAUDE = [
  `require('fs').writeFileSync('started', '');`,
  `process.stdin.setEncoding('utf8');`,
  `let buf = '';`,
  `process.stdin.on('data', (d) => {`,
  `  buf += d;`,
  `  let i;`,
  `  while ((i = buf.indexOf('\\n')) >= 0) {`,
  `    buf = buf.slice(i + 1);`,
  `    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"got it"}]}}\\n');`,
  `  }`,
  `});`,
  `process.stdin.on('end', () => process.exit(0));`,
].join('\n');

let root: string;
let scriptPath: string;
let binDir: string;
const dirs: string[] = [];

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cp-session-'));
  scriptPath = join(root, 'cp-session');
  writeFileSync(scriptPath, CP_SESSION);
  chmodSync(scriptPath, 0o755);
  binDir = join(root, 'bin');
  mkdirSync(binDir);
  const claude = join(binDir, 'claude');
  writeFileSync(claude, `#!${process.execPath}\n${FAKE_CLAUDE}\n`);
  chmodSync(claude, 0o755);
});

after(() => {
  for (const d of [root, ...dirs]) rmSync(d, { recursive: true, force: true });
});

/** A fresh sessions dir and workspace cwd, with `claude` on PATH and the base-dir override set. */
function mkEnv() {
  const sessions = mkdtempSync(join(tmpdir(), 'cp-sess-'));
  const work = mkdtempSync(join(tmpdir(), 'cp-work-'));
  dirs.push(sessions, work);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, CLAUDEPILOT_SESSIONS_DIR: sessions };
  return { sessions, work, env };
}

/** Runs one `cp-session` command to completion, returning its exit code and captured output. */
function run(args: string[], opts: { input?: string; env: NodeJS.ProcessEnv }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [scriptPath, ...args], { env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdin?.on('error', () => {}); // a command that exits before reading stdin (e.g. exit 5)
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin?.end(opts.input ?? '');
  });
}

/** Spawns `tail`, collecting stdout until `want` holds or the cap elapses, then closes its stdin to end it. */
function tailUntil(args: string[], env: NodeJS.ProcessEnv, want: (s: string) => boolean, capMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [scriptPath, ...args], { env });
    let out = '';
    const timer = setTimeout(() => child.stdin?.end(), capMs);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (want(out)) {
        clearTimeout(timer);
        child.stdin?.end();
      }
    });
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** Polls a command until its trimmed stdout satisfies `want`. */
async function runUntil(args: string[], env: NodeJS.ProcessEnv, want: (s: string) => boolean, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await run(args, { env });
    if (want(r.stdout.trim())) return r;
    if (Date.now() > end) throw new Error(`timed out: ${args.join(' ')} -> ${r.stdout.trim()}`);
    await sleep(30);
  }
}

test('parseStartOutput reads the pid and ISO time, and rejects anything else', () => {
  assert.deepEqual(parseStartOutput('12345 2026-10-10T15:00:00Z\n'), { pid: 12345, startedAt: '2026-10-10T15:00:00Z' });
  assert.deepEqual(parseStartOutput('  678 2026-01-02T03:04:05Z  '), { pid: 678, startedAt: '2026-01-02T03:04:05Z' });
  assert.equal(parseStartOutput(''), null);
  assert.equal(parseStartOutput('nope'), null);
  assert.equal(parseStartOutput('12345'), null);
  assert.equal(parseStartOutput('0 2026-10-10T15:00:00Z'), null, 'the pid must be positive');
  assert.equal(parseStartOutput('12 2026-10-10 15:00:00'), null, 'the time must be ISO-8601 Z');
});

test('a session starts detached in its cwd, takes a send, is tailable by offset, and stops', async () => {
  const { sessions, work, env } = mkEnv();

  const started = await run(['start', 's1', '1', work, '--', '-p'], { env });
  assert.equal(started.code, 0, started.stderr);
  const parsed = parseStartOutput(started.stdout);
  assert.ok(parsed, 'start printed a pid line');
  assert.ok(parsed.pid > 0);
  assert.match(parsed.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const dir = join(sessions, 's1');
  assert.ok(existsSync(join(dir, 'in')), 'the FIFO exists');
  assert.ok(existsSync(join(dir, 'parent.pid')), 'parent.pid exists');
  assert.equal(readFileSync(join(dir, 'parent.pid'), 'utf8').trim(), String(parsed.pid));

  // claude runs in <cwd>: its marker lands there, not in the session dir.
  await until(() => existsSync(join(work, 'started')));
  assert.ok(!existsSync(join(dir, 'started')), 'claude did not run in the session dir');

  const status = await run(['status', 's1'], { env });
  assert.equal(status.stdout.trim(), `live ${parsed.pid}`);

  // A valid one-line JSON send reaches claude, which appends exactly one line.
  const line = '{"type":"user","message":{"content":"hi"}}\n';
  const send = await run(['send', 's1', 'u1', String(Buffer.byteLength(line))], { input: line, env });
  assert.equal(send.code, 0, send.stderr);
  const outPath = join(dir, 'out.1.jsonl');
  await until(() => existsSync(outPath) && readFileSync(outPath, 'utf8').includes('got it'));
  const outContent = readFileSync(outPath, 'utf8');
  assert.equal(outContent.trim().split('\n').length, 1, 'exactly one output line so far');

  // tail from offset 0 sees the whole line.
  const fromZero = await tailUntil(['tail', 's1', '1', '0'], env, (s) => s.includes('got it'));
  assert.ok(fromZero.includes('got it'));

  // tail from a mid-line offset yields only the bytes after it.
  const offset = 5;
  const expected = Buffer.from(outContent, 'utf8').subarray(offset).toString('utf8');
  const fromMid = await tailUntil(['tail', 's1', '1', String(offset)], env, (s) => s.length >= expected.length);
  assert.equal(fromMid, expected, 'the offset tail returns only bytes after the offset');
  assert.ok(!fromMid.startsWith('{"type"'), 'the offset skipped the start of the line');

  // stop ends the process group; status then reports gone.
  assert.equal((await run(['stop', 's1'], { env })).code, 0);
  await runUntil(['status', 's1'], env, (s) => s === 'gone');
});

test('send rejects malformed input and a wrong byte count without appending to the pipe', async () => {
  const { sessions, work, env } = mkEnv();
  await run(['start', 's1', '1', work, '--', '-p'], { env });
  await until(() => existsSync(join(work, 'started')));

  const outPath = join(sessions, 's1', 'out.1.jsonl');
  const before = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';

  // Not JSON at all.
  assert.equal((await run(['send', 's1', 'b1', '6'], { input: 'hello\n', env })).code, 4);
  // Valid JSON, but a too-small byte count stages a truncated, invalid fragment.
  const line = '{"type":"user","message":{"content":"hi"}}\n';
  assert.equal((await run(['send', 's1', 'b2', '5'], { input: line, env })).code, 4);

  await sleep(200); // give claude a chance to (not) react
  const after = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  assert.equal(after, before, 'the malformed sends never reached claude');
  assert.ok(!existsSync(join(sessions, 's1', 'in.d', 'b1.jsonl')), 'the rejected stage was removed');
  assert.ok(!existsSync(join(sessions, 's1', 'in.d', 'b2.jsonl')), 'the rejected stage was removed');

  await run(['stop', 's1'], { env });
});

test('bad ids, unknown commands, a non-absolute cwd, and a missing session are rejected', async () => {
  const { env } = mkEnv();
  assert.equal((await run(['status', '../evil'], { env })).code, 2, 'an id cannot escape the base dir');
  assert.equal((await run(['status', '..'], { env })).code, 2);
  assert.equal((await run(['bogus'], { env })).code, 2, 'unknown command');
  assert.equal((await run([], { env })).code, 2, 'no command');
  assert.equal((await run(['start', 's1', '1', 'relative', '--', '-p'], { env })).code, 2, 'cwd must be absolute');
  assert.equal((await run(['send', 'nope', 'u1', '3'], { input: '{}\n', env })).code, 5, 'no session / FIFO');
});

/* ---------- Files and Diff ---------- */

/** Runs one command to completion, keeping stdout as bytes (`cat` output is binary). */
function runBytes(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [scriptPath, ...args], { env });
    const out: Buffer[] = [];
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out) }));
    child.stdin?.end();
  });
}

/** Git for the fixtures, never reading the developer's own configuration. */
function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
}

/**
 * A files root (standing in for /home/node) with a project, the portal's own folders, and a folder
 * outside the root that a symlink points into. `gitConfig` becomes the global git configuration.
 */
function mkFiles(gitConfig = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-files-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cp-outside-')));
  dirs.push(root, outside);
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'a.txt'), 'hello');
  symlinkSync(join(proj, 'a.txt'), join(proj, 'link-a'));
  symlinkSync(outside, join(proj, 'out'));
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  mkdirSync(join(root, '.claudepilot', 'sessions'), { recursive: true });
  writeFileSync(join(root, '.claudepilot', 'sessions', 'x.jsonl'), '{}\n');
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', '.credentials.json'), '{}');
  const config = join(outside, 'gitconfig');
  writeFileSync(config, gitConfig);
  const env = { ...process.env, CLAUDEPILOT_FILES_ROOT: root, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
  return { root, outside, proj, env };
}

/** `ls` output as [type, size, mtime, name] rows. */
const rows = (out: string) =>
  out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));

test('ls lists a folder sorted by name: type, size, mtime and name; the root hides the portal’s own folders', async () => {
  const { root, proj, env } = mkFiles();
  writeFileSync(join(proj, 'tab\tname'), 'x');
  writeFileSync(join(proj, 'new\nline'), 'y');

  const top = await run(['ls', root], { env });
  assert.equal(top.code, 0, top.stderr);
  assert.deepEqual(rows(top.stdout).map((r) => r[3]), ['proj'], '.claudepilot and .claude stay out of the root listing');

  const listed = await run(['ls', proj], { env });
  assert.equal(listed.code, 0);
  const byName = new Map(rows(listed.stdout).map((r) => [r.slice(3).join('\t'), r]));
  assert.deepEqual([...byName.keys()], ['a.txt', 'link-a', 'out', 'src', 'tab\tname'], 'sorted by name; a name with a newline is left out');
  assert.deepEqual(byName.get('a.txt')?.slice(0, 2), ['f', '5']);
  assert.equal(byName.get('src')?.[0], 'd');
  assert.equal(byName.get('link-a')?.[0], 'l', 'a symlink is listed as itself');
  const mtime = Number(byName.get('a.txt')?.[2]);
  assert.ok(Math.abs(mtime - Date.now() / 1000) < 600, `mtime is epoch seconds (${mtime})`);

  // A trailing slash and an in-root symlink to a folder both list it.
  assert.equal((await run(['ls', `${proj}/`], { env })).stdout, listed.stdout);
});

test(`ls stops at ${LS_MAX_ENTRIES} entries and says so`, async () => {
  const { proj, env } = mkFiles();
  const many = join(proj, 'many');
  mkdirSync(many);
  for (let i = 0; i < LS_MAX_ENTRIES + 3; i++) writeFileSync(join(many, `f${String(i).padStart(4, '0')}`), '');
  const lines = (await run(['ls', many], { env })).stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, LS_MAX_ENTRIES + 1);
  assert.equal(lines.at(-1), '#truncated');
  assert.equal(lines.at(-2)?.split('\t')[3], `f${String(LS_MAX_ENTRIES - 1).padStart(4, '0')}`, 'the first entries by name are kept');

  const exact = join(proj, 'exact');
  mkdirSync(exact);
  for (let i = 0; i < LS_MAX_ENTRIES; i++) writeFileSync(join(exact, `f${i}`), '');
  const all = (await run(['ls', exact], { env })).stdout.split('\n').filter(Boolean);
  assert.equal(all.length, LS_MAX_ENTRIES);
  assert.ok(!all.includes('#truncated'));
});

test('ls, cat and diff refuse paths outside the root, symlinks out of it, the portal’s files, the wrong type, and relative or missing paths', async () => {
  const { root, outside, proj, env } = mkFiles();
  execFileSync('mkfifo', [join(proj, 'pipe')]);
  const refused: string[][] = [
    ['ls', outside],
    ['ls', join(proj, 'out')], // a symlink out of the root
    ['ls', join(root, '..')],
    ['ls', join(root, '.claudepilot')],
    ['ls', join(root, '.claudepilot', 'sessions')],
    ['ls', join(root, '.claude')],
    ['ls', join(proj, 'a.txt')], // not a folder
    ['ls', 'proj'],
    ['ls', join(proj, 'missing')],
    ['ls', ''],
    ['ls'],
    ['cat', join(outside, 'secret.txt')],
    ['cat', join(proj, 'out', 'secret.txt')],
    ['cat', join(root, '.claudepilot', 'sessions', 'x.jsonl')],
    ['cat', join(root, '.claude', '.credentials.json')],
    ['cat', proj], // not a file
    ['cat', join(proj, 'pipe')], // a FIFO is never opened
    ['cat', 'proj/a.txt'],
    ['cat', join(proj, 'missing')],
    ['diff', outside],
    ['diff', join(proj, 'out')],
    ['diff', join(proj, 'a.txt')],
    ['diff', join(root, '.claudepilot')],
  ];
  for (const args of refused) {
    const r = await runBytes(args, env);
    assert.equal(r.code, 2, `${args.join(' ')} is refused`);
    assert.equal(r.stdout.length, 0, `${args.join(' ')} prints nothing`);
  }
  // The same folder is fine under a root that holds it.
  assert.equal((await run(['ls', outside], { env: { ...env, CLAUDEPILOT_FILES_ROOT: outside } })).code, 0);
});

test('cat prints a file’s exact bytes, also through an in-root symlink, and refuses one over the download limit', async () => {
  const { proj, env } = mkFiles();
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  writeFileSync(join(proj, 'all.bin'), bytes);
  const r = await runBytes(['cat', join(proj, 'all.bin')], env);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.equals(bytes), 'every byte value comes through unchanged');
  assert.equal((await runBytes(['cat', join(proj, 'link-a')], env)).stdout.toString(), 'hello');
  writeFileSync(join(proj, 'empty'), '');
  assert.deepEqual(await runBytes(['cat', join(proj, 'empty')], env), { code: 0, stdout: Buffer.alloc(0) });

  const big = join(proj, 'big.bin');
  writeFileSync(big, '');
  truncateSync(big, CHAT_MAX_DOWNLOAD_BYTES + 1); // sparse: cheap to make
  assert.deepEqual(await runBytes(['cat', big], env), { code: 6, stdout: Buffer.alloc(0) });
});

test('diff says #norepo outside a git work tree', async () => {
  const { proj, env } = mkFiles();
  assert.deepEqual(await run(['diff', proj], { env }), { code: 0, stdout: '#norepo\n', stderr: '' });
});

/** Splits `diff` output into its marked sections. */
function sections(out: string) {
  const m = /^#status\n([\s\S]*?)#numstat\n([\s\S]*?)#patch\n([\s\S]*)$/.exec(out);
  assert.ok(m, `three sections in order:\n${out.slice(0, 500)}`);
  return { status: m[1]!.split('\n').filter(Boolean), numstat: m[2]!.split('\n').filter(Boolean), patch: m[3]! };
}

test('diff prints status, numstat and the patch against HEAD, and nothing the configuration defines runs', async () => {
  const marker = (name: string) => join(tmpdir(), `cp-diff-${process.pid}-${name}`);
  const filterRan = marker('filter');
  const fsmonitorRan = marker('fsmonitor');
  // A hostile global configuration: colour, no prefixes, untracked hidden, quoted paths, a filter.
  const { root, proj, env } = mkFiles(
    [
      '[color]\n\tui = always',
      '[diff]\n\tnoprefix = true',
      '[status]\n\tshowUntrackedFiles = no',
      '[core]\n\tquotePath = true',
      `[filter "evil"]\n\tclean = touch ${filterRan} && cat\n\tsmudge = cat\n\trequired = true`,
      '',
    ].join('\n'),
  );
  const repo = join(proj, 'repo');
  mkdirSync(join(repo, 'sub'), { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(repo, 'old.txt'), 'same\n');
  writeFileSync(join(repo, 'del.txt'), 'gone\n');
  writeFileSync(join(repo, 'b.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(join(repo, 'sp ace.txt'), 'x\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  // The repository's own fsmonitor hook would run on status.
  const hook = join(root, 'fsmon.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch ${fsmonitorRan}\n`);
  chmodSync(hook, 0o755);
  git(repo, 'config', 'core.fsmonitor', hook);
  writeFileSync(join(repo, '.gitattributes'), '* filter=evil\n');

  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n');
  git(repo, 'mv', 'old.txt', 'new.txt');
  rmSync(join(repo, 'del.txt'));
  writeFileSync(join(repo, 'b.bin'), Buffer.from([0, 9, 9, 9]));
  writeFileSync(join(repo, 'sp ace.txt'), 'x\ny\n');
  writeFileSync(join(repo, 'staged.txt'), 'staged\n');
  git(repo, 'add', 'staged.txt');
  writeFileSync(join(repo, 'untracked.txt'), 'new\n');
  rmSync(filterRan, { force: true });
  rmSync(fsmonitorRan, { force: true });

  try {
    // From a subfolder: git still reports the whole work tree, paths relative to its top.
    const r = await run(['diff', join(repo, 'sub')], { env });
    assert.equal(r.code, 0, r.stdout);
    assert.ok(!r.stdout.includes('\x1b['), 'no colour');
    const { status, numstat, patch } = sections(r.stdout);
    assert.deepEqual(status, [' M a.txt', ' M b.bin', ' D del.txt', 'R  old.txt -> new.txt', ' M "sp ace.txt"', 'A  staged.txt', '?? .gitattributes', '?? untracked.txt']);
    assert.deepEqual(numstat, ['2\t1\ta.txt', '-\t-\tb.bin', '0\t1\tdel.txt', '0\t0\told.txt => new.txt', '1\t0\tsp ace.txt', '1\t0\tstaged.txt']);
    assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt\n/, 'prefixed paths');
    assert.ok(patch.includes('\n-two\n+TWO\n+three\n'));
    assert.ok(patch.includes('+staged\n'), 'staged changes are in the patch too');
    assert.ok(patch.includes('Binary files a/b.bin and b/b.bin differ'));
    assert.ok(!patch.includes('untracked.txt'), 'untracked files are listed only');
    assert.ok(!existsSync(filterRan), 'the clean filter never ran');
    assert.ok(!existsSync(fsmonitorRan), 'the fsmonitor hook never ran');
  } finally {
    rmSync(filterRan, { force: true });
    rmSync(fsmonitorRan, { force: true });
  }
});

test('diff before the first commit compares with the empty tree', async () => {
  const { proj, env } = mkFiles();
  git(proj, 'init', '-q');
  writeFileSync(join(proj, 'a.txt'), 'hello\n');
  git(proj, 'add', 'a.txt');
  const { status, numstat, patch } = sections((await run(['diff', proj], { env })).stdout);
  assert.ok(status.includes('A  a.txt'));
  assert.ok(numstat.includes('1\t0\ta.txt'));
  assert.ok(patch.includes('+hello'));
});

test(`diff cuts the patch at ${DIFF_MAX_PATCH_BYTES} bytes and marks it`, async () => {
  const { proj, env } = mkFiles();
  git(proj, 'init', '-q');
  writeFileSync(join(proj, 'f.txt'), 'x\n');
  git(proj, 'add', '-A');
  git(proj, 'commit', '-qm', 'init');
  writeFileSync(join(proj, 'f.txt'), 'a line of changed text\n'.repeat(60_000));
  const r = await runBytes(['diff', proj], env);
  assert.equal(r.code, 0);
  const out = r.stdout.toString('utf8');
  assert.ok(out.endsWith('\n#truncated\n'));
  const patch = out.slice(out.indexOf('#patch\n') + '#patch\n'.length, -'\n#truncated\n'.length);
  assert.equal(Buffer.byteLength(patch), DIFF_MAX_PATCH_BYTES);
});
