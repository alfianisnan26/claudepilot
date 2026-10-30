import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The browser container's process signals and stale locks (T-1660), imported the way headers.test.ts imports the container's code.
const PROCS = new URL('../../../../images/browser/cpb/procs.mjs', import.meta.url);
const procs = (await import(PROCS.href)) as {
  signalAs: (child: unknown, signal: string, o: { uid?: number; run?: (cmd: string, args: string[], o: Record<string, unknown>) => unknown }) => boolean;
  clearStaleXLock: (display: string, o?: { tmp?: string; name?: (pid: number) => string | null }) => string;
  clearStaleSingleton: (dir: string, o?: { host?: string; name?: (pid: number) => string | null }) => { live: number | null; removed?: string[] };
  prepareProfileDir: (dir: string, profile: string, o?: { host?: string; name?: (pid: number) => string | null }) => { live: number | null; removed?: string[] };
  processName: (pid: number) => string | null;
};
const SRC = (f: string) => readFileSync(new URL(`../../../../images/browser/cpb/${f}`, import.meta.url), 'utf8');

/** A child as the init holds one, whose own `kill()` fails the way it does for root without CAP_KILL: an 'error' event. */
function eacces(pid = 4242) {
  const c = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; kill: () => boolean };
  c.pid = pid;
  c.exitCode = null;
  c.signalCode = null;
  c.kill = () => {
    c.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' }));
    return false;
  };
  return c;
}

test('signalAs sends the signal as the child’s own user through /bin/kill, never with the child’s kill()', () => {
  const calls: [string, string[], Record<string, unknown>][] = [];
  const child = eacces();
  assert.equal(procs.signalAs(child, 'SIGKILL', { uid: 1000, run: (cmd, args, o) => (calls.push([cmd, args, o]), { status: 0 }) }), true);
  assert.deepEqual(calls.map(([cmd, args, o]) => [cmd, args, o.uid, o.gid]), [['/bin/kill', ['-s', 'KILL', '4242'], 1000, 1000]]);
});

test('signalAs survives EPERM and a runner that throws: it reports false and the init lives on', () => {
  const child = eacces();
  // Before T-1660 the init called child.kill(): without a listener the 'error' event threw and ended the container's PID 1 child.
  assert.throws(() => child.kill(), /EPERM/, 'the fake fails like the real one');
  assert.equal(procs.signalAs(child, 'SIGTERM', { uid: 1000, run: () => ({ status: 1, stderr: 'kill: (4242): Operation not permitted' }) }), false);
  assert.equal(procs.signalAs(child, 'SIGTERM', { uid: 1000, run: () => { throw Object.assign(new Error('spawnSync EPERM'), { code: 'EPERM' }); } }), false);
  assert.equal(procs.signalAs(child, 'SIGTERM', { uid: 1000, run: () => ({ status: null, error: new Error('ETIMEDOUT') }) }), false);
  // Nothing to signal: an exited child or no pid never reaches the runner (a reused pid could be someone else).
  let ran = 0;
  const run = () => (ran++, { status: 0 });
  assert.equal(procs.signalAs({ ...eacces(), pid: 7, exitCode: 0, signalCode: null }, 'SIGKILL', { run }), false);
  assert.equal(procs.signalAs({ pid: 7, exitCode: null, signalCode: 'SIGTERM' }, 'SIGKILL', { run }), false);
  assert.equal(procs.signalAs({ pid: undefined, exitCode: null, signalCode: null }, 'SIGKILL', { run }), false);
  assert.equal(procs.signalAs(null, 'SIGKILL', { run }), false);
  assert.equal(ran, 0);
});

test('signalAs really stops a child (as this user, through the real /bin/kill)', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  const exited = new Promise<string | null>((r) => child.once('exit', (_c, s) => r(s)));
  assert.equal(procs.signalAs(child, 'SIGTERM', { run: (cmd, args, o) => spawnSync(cmd, args, { ...o, uid: undefined, gid: undefined }) }), true);
  assert.equal(await exited, 'SIGTERM');
});

test('the init signals Chrome and the supervisor only through signalAs, and keeps listening for errors', () => {
  const init = SRC('init.mjs');
  assert.doesNotMatch(init, /\.kill\(/, 'a child.kill() as root without CAP_KILL is EPERM');
  assert.match(init, /child\.on\('error'/, 'a once() listener is spent by the first error; the next one ends the init');
  assert.doesNotMatch(init, /child\.once\('error'/);
  assert.match(init, /signalAs\(me\.child, 'SIGKILL', \{ uid: UID_CHROME \}\)/);
  assert.match(init, /signalAs\(supervisor, 'SIGTERM', \{ uid: UID_CPB \}\)/);
});

test('a stale X display lock and socket are removed; a live X server’s are kept', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cpb-x-'));
  try {
    mkdirSync(join(tmp, '.X11-unix'));
    const lock = join(tmp, '.X99-lock');
    const sock = join(tmp, '.X11-unix', 'X99');
    assert.equal(procs.clearStaleXLock(':99', { tmp }), 'none');

    // The lock Xvnc writes: the pid, padded to 10 characters.
    const put = (pid: string) => (writeFileSync(lock, `${pid.padStart(10)}\n`), writeFileSync(sock, ''));
    put('23');
    assert.equal(procs.clearStaleXLock(':99', { tmp, name: (pid) => (pid === 23 ? 'Xtigervnc' : null) }), 'live');
    assert.ok(existsSync(lock) && existsSync(sock), 'a live display keeps its lock');

    // Its container restarted: no such process, or the pid now belongs to something that isn't an X server.
    assert.equal(procs.clearStaleXLock(':99', { tmp, name: () => null }), 'removed');
    assert.ok(!existsSync(lock) && !existsSync(sock));
    put('23');
    assert.equal(procs.clearStaleXLock(':99', { tmp, name: () => 'node' }), 'removed');
    put('garbage');
    assert.equal(procs.clearStaleXLock(':99', { tmp, name: () => 'Xtigervnc' }), 'removed', 'an unreadable pid owns nothing');
    // The real /proc: this test's own pid is alive but not an X server.
    put(String(process.pid));
    assert.equal(procs.processName(process.pid) !== null, true);
    assert.equal(procs.clearStaleXLock(':99', { tmp }), 'removed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Chrome’s Singleton links are removed unless a live Chrome on this host owns them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpb-profile-'));
  const links = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  const lock = (target: string) => {
    for (const f of links) rmSync(join(dir, f), { force: true });
    symlinkSync(target, join(dir, 'SingletonLock'));
    symlinkSync('1234567890', join(dir, 'SingletonCookie'));
    symlinkSync('/tmp/.org.chromium.Chromium.x/SingletonSocket', join(dir, 'SingletonSocket'));
  };
  const has = () => links.filter((f) => { try { return lstatSync(join(dir, f)).isSymbolicLink(); } catch { return false; } });
  const chromium = (pid: number) => (pid === 39 ? 'chromium' : null);
  try {
    lock('pod-a-39');
    assert.deepEqual(procs.clearStaleSingleton(dir, { host: 'pod-a', name: chromium }), { live: 39 });
    assert.deepEqual(has(), links, 'a live Chrome keeps its locks');

    // The pod before this one (another host name), a dead pid, a pid that is no longer Chrome: all stale.
    for (const [target, host, name] of [['pod-old-39', 'pod-a', chromium], ['pod-a-40', 'pod-a', chromium], ['pod-a-39', 'pod-a', () => 'node']] as const) {
      lock(target);
      assert.deepEqual(procs.clearStaleSingleton(dir, { host, name }), { live: null, removed: links }, target);
      assert.deepEqual(has(), []);
    }
    // A stray socket link without a lock goes too; nothing there is fine.
    symlinkSync('/nowhere', join(dir, 'SingletonSocket'));
    assert.deepEqual(procs.clearStaleSingleton(dir, { host: 'pod-a', name: chromium }), { live: null, removed: ['SingletonSocket'] });
    assert.deepEqual(procs.clearStaleSingleton(dir, { host: 'pod-a', name: chromium }), { live: null, removed: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareProfileDir: a persistent profile keeps its data, a fresh one is emptied, a live Chrome’s profile is left alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'cpb-prep-'));
  const dir = join(root, 'profile');
  const chromium = (pid: number) => (pid === 39 ? 'chromium' : null);
  try {
    assert.deepEqual(procs.prepareProfileDir(dir, 'persistent', { host: 'h', name: chromium }), { live: null, removed: [] });
    assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    writeFileSync(join(dir, 'Cookies'), '');
    symlinkSync('h-12', join(dir, 'SingletonLock'));
    assert.deepEqual(procs.prepareProfileDir(dir, 'persistent', { host: 'h', name: chromium }).removed, ['SingletonLock']);
    assert.deepEqual(readdirSync(dir), ['Cookies']);

    rmSync(join(dir, 'SingletonLock'), { force: true });
    symlinkSync('h-39', join(dir, 'SingletonLock'));
    assert.deepEqual(procs.prepareProfileDir(dir, 'fresh', { host: 'h', name: chromium }), { live: 39 });
    assert.deepEqual(readdirSync(dir).sort(), ['Cookies', 'SingletonLock'], 'not emptied under a running Chrome');
    rmSync(join(dir, 'SingletonLock'), { force: true });
    procs.prepareProfileDir(dir, 'fresh', { host: 'h', name: chromium });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the profile CLI the init runs as Chrome’s user: JSON on stdout, exit 0, stale links gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpb-cli-'));
  try {
    symlinkSync(`${hostname()}-999999999`, join(dir, 'SingletonLock'));
    const r = spawnSync(process.execPath, [fileURLToPath(PROCS), 'profile', dir, 'persistent'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { live: null, removed: ['SingletonLock'] });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the supervisor clears a stale display lock before every Xvnc start', () => {
  const sup = SRC('supervisor.mjs');
  assert.match(sup, /prepare\?\.\(\);\n\s+const startedAt/, 'supervise() runs prepare before each spawn, restarts included');
  assert.match(sup, /prepare: \(\) => \{\n\s+const lock = clearStaleXLock\(DISPLAY\)/);
});
