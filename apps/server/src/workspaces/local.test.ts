import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { JsonFile } from '../jsonFile.js';
import { LocalRuntime, type LocalState } from './local.js';

const NAME = 'local';
let dir: string;
let realHome: string | undefined;
let rt: LocalRuntime;

const output = (exec: Awaited<ReturnType<LocalRuntime['exec']>>) =>
  new Promise<{ text: string; code: number | null }>((resolve) => {
    const chunks: Buffer[] = [];
    exec.onData((d) => chunks.push(d));
    exec.onExit((code) => resolve({ text: Buffer.concat(chunks).toString('utf8'), code }));
  });

describe('LocalRuntime', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'local-runtime-'));
    realHome = process.env.HOME;
    process.env.HOME = join(dir, 'home');
    mkdirSync(process.env.HOME);
    rt = new LocalRuntime({ name: NAME, state: new JsonFile<LocalState>(join(dir, 'state.json'), {}) });
  });
  after(() => {
    process.env.HOME = realHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('is one workspace that starts switched off', async () => {
    const list = await rt.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, 'local/local');
    assert.equal(list[0]!.status, 'stopped');
    assert.deepEqual(await rt.delivery.state(NAME), { exists: true, running: false });
    assert.deepEqual(await rt.delivery.state('other'), { exists: false, running: false });
  });

  it('refuses shells, commands and delivery while switched off', async () => {
    await assert.rejects(rt.exec(NAME, ['true']), { code: 'CONFLICT' });
    await assert.rejects(rt.shell(NAME, { cols: 80, rows: 24 }), { code: 'CONFLICT' });
    await assert.rejects(rt.delivery.run(NAME, 'true'), { code: 'CONFLICT' });
    await assert.rejects(rt.delivery.put(NAME, []), { code: 'CONFLICT' });
  });

  it('starts and stops, and tells listeners', async () => {
    const started: string[] = [];
    let changes = 0;
    const stopStarts = rt.delivery.watchStarts((n) => started.push(n));
    const stopWatch = rt.watch(() => changes++);
    await rt.start(NAME);
    await rt.start(NAME); // already on: no second notice
    assert.equal((await rt.list())[0]!.status, 'running');
    assert.deepEqual(started, [NAME]);
    assert.equal(changes, 1);
    await rt.stop(NAME);
    assert.equal((await rt.list())[0]!.status, 'stopped');
    assert.equal(changes, 2);
    await rt.start(NAME);
    stopStarts();
    stopWatch();
  });

  it('keeps its state across a new instance', async () => {
    const again = new LocalRuntime({ name: NAME, state: new JsonFile<LocalState>(join(dir, 'state.json'), {}) });
    assert.equal((await again.list())[0]!.status, 'running');
  });

  it('runs commands as the portal user, with HOME set to the real home', async () => {
    const { text, code } = await output(await rt.exec(NAME, ['sh', '-c', 'echo "$HOME"; echo "$PATH"; cat']).then(async (e) => (e.write('typed\n'), e.close(), e)));
    assert.equal(code, 0);
    const [home, path] = text.split('\n');
    assert.equal(home, join(dir, 'home'));
    assert.equal(path!.split(':')[0], join(dir, 'home', '.local', 'bin'), 'the installer’s bin folder comes first');
  });

  it('reports a missing program as exit 127', async () => {
    const { code, text } = await output(await rt.exec(NAME, ['definitely-not-a-program']));
    assert.equal(code, 127);
    assert.match(text, /ENOENT/);
  });

  it('delivers files into the home directory and reads them back', async () => {
    await rt.delivery.put(NAME, [
      { path: '/home/node/.claude', type: 'directory', mode: 0o700, uid: 1000, gid: 1000 },
      { path: '/home/node/.claude/key', type: 'file', content: 'secret', mode: 0o600, uid: 1000, gid: 1000 },
    ]);
    assert.equal(readFileSync(join(dir, 'home', '.claude', 'key'), 'utf8'), 'secret');
    assert.equal(statSync(join(dir, 'home', '.claude', 'key')).mode & 0o777, 0o600);
    assert.equal(await rt.delivery.read(NAME, '/home/node/.claude/key'), 'secret');
    assert.equal(await rt.delivery.read(NAME, '/home/node/.claude/missing'), null);
  });

  it('runs delivery scripts with stdin and returns the exit code', async () => {
    const ok = await rt.delivery.run(NAME, 'cat; echo err >&2', { stdin: 'hello' });
    assert.deepEqual(ok, { code: 0, stdout: 'hello', stderr: 'err\n' });
    assert.equal((await rt.delivery.run(NAME, 'exit 3')).code, 3);
  });

  it('does not pass the portal’s heap cap on to commands, scripts or terminals (T-2615)', async () => {
    const before = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--max-old-space-size=1536 --disable-warning=ExperimentalWarning';
    try {
      const ran = await output(await rt.exec(NAME, ['sh', '-c', 'printf "%s" "$NODE_OPTIONS"']));
      assert.equal(ran.text, '--disable-warning=ExperimentalWarning', 'a command keeps the other flags, not the heap cap');
      assert.equal((await rt.delivery.run(NAME, 'printf "%s" "$NODE_OPTIONS"')).stdout, '--disable-warning=ExperimentalWarning');
      process.env.NODE_OPTIONS = '--max-old-space-size=1536';
      assert.equal((await rt.delivery.run(NAME, 'printf "%s" "${NODE_OPTIONS-unset}"')).stdout, 'unset', 'nothing else: the variable is gone');
      assert.equal(process.env.NODE_OPTIONS, '--max-old-space-size=1536', 'the portal’s own environment is unchanged');
    } finally {
      if (before === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = before;
    }
  });

  it('opens a terminal that echoes, and resizes', async () => {
    const shell = await rt.shell(NAME, { cols: 100, rows: 30 });
    const seen: string[] = [];
    shell.onData((d) => seen.push(d.toString('utf8')));
    const exited = new Promise<number | null>((resolve) => shell.onExit(resolve));
    shell.resize(120, 40);
    shell.write(Buffer.from('echo marker-$((6*7)); stty size; exit 0\n'));
    assert.equal(await exited, 0);
    const all = seen.join('');
    assert.match(all, /marker-42/);
    assert.match(all, /40 120/);
  });

  it('can’t be created again or removed, and the others don’t exist', async () => {
    await assert.rejects(rt.create({ name: 'other' }), { code: 'VALIDATION_FAILED' });
    await assert.rejects(rt.remove(), { code: 'CONFLICT' });
    await assert.rejects(rt.start('other'), { code: 'NOT_FOUND' });
  });

  it('reports host usage for each name', async () => {
    await rt.usage([NAME]); // first sample
    const [u] = await rt.usage([NAME]);
    assert.ok(u!.memoryBytes! > 0);
    assert.ok(u!.cpuPercent! >= 0);
    assert.ok(u!.cores! >= 1);
    assert.ok(u!.memoryTotalBytes! >= u!.memoryBytes!);
  });

  it('runs workspace paths as this machine’s: /home/node is the home folder and /etc/claudepilot is ~/.claudepilot/host', async () => {
    await rt.start(NAME);
    const home = process.env.HOME!;
    const { text } = await output(await rt.exec(NAME, ['sh', '-c', 'printf "%s|%s|%s|%s" "$1" "$2" "$3" "$CLAUDEPILOT_FILES_ROOT"', 'sh', '/home/node/project', '/etc/claudepilot/bin/cp-session', '/home/nodes']));
    assert.equal(text, `${home}/project|${home}/.claudepilot/host/bin/cp-session|/home/nodes|${home}`);
    await rt.delivery.put(NAME, [
      { path: '/etc/claudepilot', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
      { path: '/etc/claudepilot/bin', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
      { path: '/etc/claudepilot/bin/.tmp', type: 'file', content: 'host', mode: 0o755, uid: 0, gid: 0 },
    ]);
    const r = await rt.delivery.run(NAME, "mv -f '/etc/claudepilot/bin/.tmp' '/etc/claudepilot/bin/cp-session'", { user: 'root' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await rt.delivery.read(NAME, '/etc/claudepilot/bin/cp-session'), 'host');
    await rt.stop(NAME);
  });
});
