// Delivery into Kubernetes workspaces (kubernetesDelivery.ts) against the in-process fake API server: no cluster, no kubeconfig (KUBERNETES
// SAFETY RULE). The exec's argv runs for real here (kubeTestkit.ts `localPod`, a stand-in sudo first on PATH, delivery pointed at a temporary
// folder), so the wrapper scripts are what is tested: counted stdin that is never ended, separate stdout and stderr, exit codes, owners and
// modes in the archive, the refusals (paths, links, sizes), no sudo or a refused one, a dropped exec, a stopped workspace, and start polling.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { isAppError } from '@isnanme/core';
import { extract } from 'tar-stream';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import { localPod, kubeRuntimeOn } from './kubeTestkit.js';
import { checkEntries, DELIVERY_LIMITS, DELIVERY_ROOTS, OUTER, pollStarts, PUT_INNER, WRAPPER_CODE } from './kubernetesDelivery.js';
import type { KubernetesRuntime } from './kubernetes.js';
import { LABEL, type TarEntry } from './runtime.js';

let fake: FakeKube;
let dir: string;
let root: string;
let rt: KubernetesRuntime;
const saved = process.env.KUBECONFIG;

before(() => {
  // Anything that still called loadFromDefault() would read this, and fail: nothing must.
  process.env.KUBECONFIG = '/nonexistent/kd-kubeconfig';
});
after(() => {
  if (saved === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = saved;
});
beforeEach(async () => {
  fake = await FakeKube.start();
  dir = mkdtempSync(join(tmpdir(), 'kd-deliver-'));
  root = join(dir, 'root');
  mkdirSync(root);
  rt = kubeRuntimeOn(fake, { roots: [root], pollMs: 40 });
  await rt.create({ name: 'kw' }, () => undefined);
});
afterEach(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (fn: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const file = (path: string, content: string, mode = 0o644, uid = 1000, gid = 1000): TarEntry => ({ path, type: 'file', content, mode, uid, gid });
const folder = (path: string, mode = 0o755, uid = 0, gid = 0): TarEntry => ({ path, type: 'directory', mode, uid, gid });
const podOf = () => [...fake.pods.values()][0]!;
const containerStatus = () => (podOf().status as { containerStatuses: { ready: boolean; restartCount?: number }[] }).containerStatuses[0]!;

describe('state', () => {
  it('tells a missing, a running, a not-ready and a stopped workspace apart, with the portal label', async () => {
    assert.deepEqual(await rt.delivery.state('nope'), { exists: false, running: false, portal: null });
    assert.deepEqual(await rt.delivery.state('kw'), { exists: true, running: true, portal: null });
    assert.equal(rt.delivery.needsRunning, true);
    containerStatus().ready = false;
    assert.equal((await rt.delivery.state('kw')).running, false, 'a pod whose container is not Ready is not running yet');
    containerStatus().ready = true;
    await rt.stop('kw');
    assert.deepEqual(await rt.delivery.state('kw'), { exists: true, running: false, portal: null });
    (fake.deployments.get('ws-kw')!.metadata.labels ??= {})[LABEL.portal] = 'other-portal';
    assert.equal((await rt.delivery.state('kw')).portal, 'other-portal');
  });
});

describe('run', () => {
  it('runs as root through sudo -n and as the workspace user without it; stdin, stdout, stderr and the exit code come back apart', async () => {
    const pod = localPod(fake, dir);
    const marker = 'kd-marker-in-the-script';
    const r = await rt.delivery.run('kw', `echo ${marker}\ncat\necho to-stderr >&2\nexit 7`, { stdin: 'from stdin\n\n' });
    assert.deepEqual(r, { code: 7, stdout: `${marker}\nfrom stdin\n\n`, stderr: 'to-stderr\n' });
    // Nothing of the script or its input is on the command line: only the fixed wrapper and byte counts.
    assert.ok(pod.execs.every((argv) => !argv.join(' ').includes(marker) && !argv.join(' ').includes('from stdin')));
    assert.deepEqual(pod.execs.at(-1)!.slice(3, 6), ['cp-deliver', 'root', String(Buffer.byteLength(`echo ${marker}\ncat\necho to-stderr >&2\nexit 7`) + 12)]);
    assert.match(readFileSync(pod.sudoLog, 'utf8'), /^-n true\n-n sh -c /);
    const before = readFileSync(pod.sudoLog, 'utf8');
    const asNode = await rt.delivery.run('kw', 'id -u', { user: 'node' });
    assert.equal(asNode.code, 0);
    assert.equal(readFileSync(pod.sudoLog, 'utf8'), before, 'the workspace user runs without sudo');
  });

  it('keeps a script byte for byte (quotes, trailing newlines, no stdin at all)', async () => {
    localPod(fake, dir);
    const script = `printf '%s|' "a'b" 'c"d' "$#"\nprintf '\\n'\n\n\n`;
    assert.deepEqual(await rt.delivery.run('kw', script), { code: 0, stdout: `a'b|c"d|0|\n`, stderr: '' });
    assert.equal((await rt.delivery.run('kw', 'cat; echo end')).stdout, 'end\n', 'no stdin reads as empty input, never as a hang');
  });

  it('refuses a script or input over the limits before any exec', async () => {
    localPod(fake, dir);
    const execs = fake.upgrades.length;
    await assert.rejects(rt.delivery.run('kw', 'x'.repeat(DELIVERY_LIMITS.scriptBytes + 1)), /Refusing a script/);
    await assert.rejects(rt.delivery.run('kw', 'cat', { stdin: 'x'.repeat(DELIVERY_LIMITS.stdinBytes + 1) }), /Refusing \d+ bytes of input/);
    assert.equal(fake.upgrades.length, execs);
  });

  it('a root run with no sudo, or a refused one, fails with exit 125 and says why; the workspace user still runs', async () => {
    localPod(fake, dir, 'missing');
    let r = await rt.delivery.run('kw', 'echo hi');
    assert.equal(r.code, WRAPPER_CODE);
    assert.match(r.stderr, /needs root in this workspace, and its image has no sudo/);
    assert.equal(r.stdout, '');
    assert.equal((await rt.delivery.run('kw', 'echo hi', { user: 'node' })).stdout, 'hi\n');
    await assert.rejects(rt.delivery.put('kw', [file(`${root}/a`, 'x')]), /Writing into the workspace failed: claudepilot: delivery needs root/);
    assert.equal(existsSync(`${root}/a`), false);
    localPod(fake, dir, 'refused');
    r = await rt.delivery.run('kw', 'echo hi');
    assert.equal(r.code, WRAPPER_CODE);
    assert.match(r.stderr, /sudo -n was refused for uid \d+/);
    await assert.rejects(rt.delivery.read('kw', `${root}/a`), /Reading .* failed: claudepilot: delivery needs root/);
  });

  it('a dropped exec, an exec that cannot start and a timeout reject; a stopped workspace is refused', async () => {
    fake.onExec = () => setTimeout(() => fake.stop(), 10);
    await assert.rejects(rt.delivery.run('kw', 'true'), /dropped before the command finished|ECONNRESET|socket hang up/);
    fake = await FakeKube.start();
    rt = kubeRuntimeOn(fake, { roots: [root] });
    await rt.create({ name: 'kw' }, () => undefined);
    // A Failure status with no exit code (the container is gone, say) is not an exit code.
    fake.onExec = (io) => io.status({ metadata: {}, status: 'Failure', message: 'container not found ("workspace")', reason: 'InternalError' });
    await assert.rejects(rt.delivery.run('kw', 'true'), /could not run in the workspace: container not found/);
    fake.onExec = () => undefined;
    await assert.rejects(rt.delivery.run('kw', 'true', { timeoutMs: 200 }), /timed out after 200 ms/);
    await rt.stop('kw');
    await assert.rejects(rt.delivery.run('kw', 'true'), (e) => isAppError(e) && e.code === 'CONFLICT' && /needs it running/.test(e.message));
    await assert.rejects(rt.delivery.put('kw', [file(`${root}/a`, 'x')]), (e) => isAppError(e) && e.code === 'CONFLICT');
    assert.equal(await rt.delivery.read('kw', `${root}/a`), null, 'stopped: no container, nothing delivered is there');
  });
});

describe('put and read', () => {
  it('writes files and folders with their modes, makes missing parents, and reads them back; the archive carries owners', async () => {
    localPod(fake, dir);
    const big = Buffer.alloc(3 * 1024 * 1024 + 7, 7);
    const seen: Buffer[] = [];
    let counts: string[] = [];
    const run = fake.onExec;
    fake.onExec = (io) => {
      if (io.command[6] === PUT_INNER) (counts = io.command), io.onStdin((d) => seen.push(d));
      run(io);
    };
    await rt.delivery.put('kw', [
      folder(`${root}/etc`),
      folder(`${root}/etc/account`, 0o750, 0, 1000),
      file(`${root}/etc/account/a.key`, 'k1', 0o440, 0, 1000),
      file(`${root}/deep/er/still/b.txt`, 'made parents'),
      { path: `${root}/blob.bin`, type: 'file', content: '', bytes: big, mode: 0o600, uid: 1000, gid: 1000 },
    ]);
    assert.equal(statSync(`${root}/etc/account`).mode & 0o7777, 0o750);
    assert.equal(statSync(`${root}/etc/account/a.key`).mode & 0o7777, 0o440);
    assert.equal(statSync(`${root}/blob.bin`).mode & 0o7777, 0o600);
    assert.ok(readFileSync(`${root}/blob.bin`).equals(big));
    assert.equal(await rt.delivery.read('kw', `${root}/etc/account/a.key`), 'k1');
    assert.equal(await rt.delivery.read('kw', `${root}/deep/er/still/b.txt`), 'made parents');
    // Owners (root here, the workspace user's group there) travel in the archive's headers; the image's tar keeps them as root.
    const payload = Buffer.concat(seen);
    const archive = payload.subarray(Number(counts[7]), Number(counts[7]) + Number(counts[8]));
    const owners: Record<string, string> = {};
    const ex = extract();
    const reading = (async () => {
      for await (const e of ex) {
        owners[e.header.name] = `${e.header.uid}:${e.header.gid} ${(e.header.mode! & 0o7777).toString(8)}`;
        e.resume();
      }
    })();
    ex.end(archive);
    await reading;
    const rel = root.slice(1);
    assert.equal(owners[`${rel}/etc/account`], '0:1000 750');
    assert.equal(owners[`${rel}/etc/account/a.key`], '0:1000 440');
    // The 3 MiB went on stdin; the command line stayed small.
    assert.ok(counts.every((c) => c.length < 4096));
  });

  it('read: a missing file, a folder and a link are null; a path outside the roots is refused', async () => {
    localPod(fake, dir);
    writeFileSync(join(dir, 'outside.txt'), 'secret');
    symlinkSync(join(dir, 'outside.txt'), join(root, 'link'));
    assert.equal(await rt.delivery.read('kw', `${root}/missing`), null);
    assert.equal(await rt.delivery.read('kw', root), null);
    assert.equal(await rt.delivery.read('kw', `${root}/link`), null, 'never read through a link');
    await assert.rejects(rt.delivery.read('kw', join(dir, 'outside.txt')), /outside the folders delivery writes/);
    await assert.rejects(rt.delivery.read('kw', `${root}/../outside.txt`), /not a plain path/);
  });

  it('refuses traversal, odd paths, modes, owners and types before anything reaches the pod', async () => {
    localPod(fake, dir);
    const execs = fake.upgrades.length;
    const refused: [TarEntry, RegExp][] = [
      [file(`${root}/../escape`, 'x'), /not a plain path/],
      [file(`${root}/a/./b`, 'x'), /not a plain path/],
      [file(`${root}//a`, 'x'), /not a plain path/],
      [file(`${root}/a/`, 'x'), /not a plain path/],
      [file('relative/path', 'x'), /not an absolute path/],
      [file('/etc/passwd', 'x'), /outside the folders delivery writes/],
      [file(`${root}x/sibling`, 'x'), /outside the folders delivery writes/],
      [file(`${root}/new\nline`, 'x'), /control characters/],
      [file(`${root}/nul\0byte`, 'x'), /control characters/],
      [file(`${root}/${'n'.repeat(256)}`, 'x'), /a name in it is too long/],
      [file(`${root}/suid`, 'x', 0o4755), /set-user-ID/],
      [file(`${root}/sgid`, 'x', 0o2755), /set-user-ID/],
      [file(`${root}/mode`, 'x', 0o10000), /mode .* is not valid/],
      [file(`${root}/owner`, 'x', 0o644, -1), /owner -1 is not valid/],
      [{ ...file(`${root}/sym`, 'x'), type: 'symlink' as never }, /only files and folders/],
    ];
    for (const [entry, why] of refused) await assert.rejects(rt.delivery.put('kw', [file(`${root}/fine`, 'ok'), entry]), why, entry.path);
    assert.equal(fake.upgrades.length, execs, 'no exec was made');
    assert.equal(existsSync(`${root}/fine`), false, 'nothing of a refused batch was written');
  });

  it('refuses a delivery over the size or entry limits before building the archive', async () => {
    localPod(fake, dir);
    const mib = Buffer.alloc(1024 * 1024);
    const many = Array.from({ length: DELIVERY_LIMITS.archiveBytes / mib.length + 1 }, (_, i): TarEntry => ({ path: `${root}/f${i}`, type: 'file', bytes: mib, mode: 0o644, uid: 0, gid: 0 }));
    await assert.rejects(rt.delivery.put('kw', many), /more than 128 MiB at once/);
    const lots = Array.from({ length: DELIVERY_LIMITS.entries + 1 }, (_, i) => file(`${root}/e${i}`, ''));
    await assert.rejects(rt.delivery.put('kw', lots), /entries at once/);
  });

  it('never writes through a symbolic link on the way, whoever planted it; nothing of that batch lands', async () => {
    localPod(fake, dir);
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'planted'));
    await assert.rejects(rt.delivery.put('kw', [file(`${root}/ok.txt`, 'fine'), file(`${root}/planted/x.json`, 'hijack')]), /refusing to write through the symbolic link .*planted/);
    assert.equal(existsSync(join(outside, 'x.json')), false);
    assert.equal(existsSync(`${root}/ok.txt`), false, 'the check runs before tar writes anything');
    // A link at the file's own name is refused too (tar would replace it; delivery says so instead).
    symlinkSync(join(outside, 'victim'), join(root, 'f'));
    await assert.rejects(rt.delivery.put('kw', [file(`${root}/f`, 'x')]), /symbolic link .*\/f$/m);
    assert.equal(existsSync(join(outside, 'victim')), false);
    assert.ok(lstatSync(join(root, 'f')).isSymbolicLink());
  });

  it('the link check covers each entry and its folders up to its root, nothing above', () => {
    assert.deepEqual(checkEntries([file('/etc/claude-code/managed-settings.d/30-x.json', '{}'), folder('/home/node/.claudepilot/outbox')], DELIVERY_ROOTS), [
      '/etc/claude-code/managed-settings.d/30-x.json',
      '/etc/claude-code/managed-settings.d',
      '/etc/claude-code',
      '/home/node/.claudepilot/outbox',
      '/home/node/.claudepilot',
      '/home/node',
    ]);
    assert.deepEqual(checkEntries([file('/etc/profile.d/claudepilot.sh', '')], DELIVERY_ROOTS), ['/etc/profile.d/claudepilot.sh']);
    assert.throws(() => checkEntries([file('/etc/profile.d/other.sh', '')], DELIVERY_ROOTS), /outside the folders/);
    assert.throws(() => checkEntries([file('/etc/claudepilot-ca/ca.pem', '')], DELIVERY_ROOTS), /outside the folders/);
  });

  it('the wrapper is the only command line: fixed text and numbers', () => {
    assert.ok(OUTER.length < 2048 && PUT_INNER.length < 2048);
    assert.doesNotMatch(OUTER, /\$\{?[a-z]*SECRET|token/i);
  });
});

describe('watchStarts', () => {
  it('polls Ready pods: a start, a restart and a new pod each call back once; the first answer is the baseline', async () => {
    const seen: string[] = [];
    await rt.create({ name: 'kw2' }, () => undefined);
    const stop = rt.delivery.watchStarts((n) => seen.push(n));
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(seen, [], 'what already runs is the baseline');
    await rt.stop('kw');
    await new Promise((r) => setTimeout(r, 100));
    await rt.start('kw');
    await until(() => seen.length === 1);
    assert.deepEqual(seen, ['kw']);
    const kw2 = [...fake.pods.values()].find((p) => p.metadata.name.startsWith('ws-kw2-'))!;
    const s = (kw2.status as { containerStatuses: { ready: boolean; restartCount?: number }[] }).containerStatuses[0]!;
    s.ready = false;
    await new Promise((r) => setTimeout(r, 100));
    s.ready = true;
    s.restartCount = 1;
    await until(() => seen.length === 2);
    assert.deepEqual(seen, ['kw', 'kw2']);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, 2, 'a pod that stays up is not a start');
    stop();
    await rt.stop('kw2');
    await rt.start('kw2');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, 2, 'stopped watching');
  });

  it('survives API errors, and a start while the API was away still counts', async () => {
    const seen: string[] = [];
    const stop = rt.delivery.watchStarts((n) => seen.push(n));
    await new Promise((r) => setTimeout(r, 100));
    const token = fake.token;
    fake.token = 'kd-refuse-everyone';
    containerStatus().restartCount = 4;
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(seen, []);
    fake.token = token;
    await until(() => seen.length === 1);
    assert.deepEqual(seen, ['kw']);
    stop();
  });

  it('pollStarts: a listener that throws does not stop the watch', async () => {
    let n = 0;
    let key = 'a';
    const calls: string[] = [];
    const stop = pollStarts(async () => new Map([['w', key]]), (name) => {
      calls.push(name);
      if (++n === 1) throw new Error('listener bug');
    }, 20);
    await new Promise((r) => setTimeout(r, 60));
    key = 'b';
    await until(() => calls.length === 1);
    key = 'c';
    await until(() => calls.length === 2);
    stop();
  });
});
