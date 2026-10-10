import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CP_SESSION, parseStartOutput } from './host.js';

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
