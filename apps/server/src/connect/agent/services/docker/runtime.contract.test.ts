// T-POL, "the recorded requests of DockerRuntime" (docs/prd/targets-connect.md §19.3): the real `DockerRuntime` runs every operation a
// workspace needs against the policy proxy in front of a recording fake daemon, and the policy must allow each one. This is the contract
// between `workspaces/docker.ts` and the policy: a change to either that makes the runtime send something the policy refuses fails here.
// The connection is the one the tunnel gives T3's `TunnelAgent` (a stream per HTTP connection), so what is exercised is the real path.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DockerRuntime } from '../../../../workspaces/docker.js';
import { IMAGE, PORTAL_ID, startDockerRig, type DockerRig } from '../../testkit/dockerRig.js';

let rig: DockerRig;
let rt: DockerRuntime;
const PULLED = 'ghcr.io/example/claudepilot-workspace:latest';
const progress: string[] = [];

const runtime = (image: string, client = rig.docker) =>
  new DockerRuntime({ id: 'tunnel', label: 'Tunnel', socket: rig.fake.socketPath }, image, '/nonexistent-context', () => PORTAL_ID, client, {
    tunnel: { reach: async () => void (await client.ping()), where: 'fake (docker 27)' },
  });

before(async () => {
  rig = await startDockerRig({ images: [PULLED] });
  rig.fake.images.delete(PULLED);
  rt = runtime(IMAGE);
});
after(() => rig.stop());

describe('DockerRuntime through the policy proxy', () => {
  it('check() and list() on an empty daemon', async () => {
    await rt.check();
    assert.deepEqual(await rt.list(), []);
  });

  it('create(): lists for a name clash, finds the image, creates with the portal’s labels and starts', async () => {
    await rt.create({ name: 'rt1', cpus: 1, memoryMb: 512 }, (d) => progress.push(d));
    const c = [...rig.fake.containers.values()].find((x) => x.name === 'claudepilot-rt1')!;
    assert.equal(c.state, 'running');
    assert.equal(c.labels['claudepilot.managed'], 'true');
    assert.equal(c.labels['claudepilot.portal'], PORTAL_ID);
    assert.equal(c.labels['claudepilot.workspace'], 'rt1');
    assert.deepEqual((c.hostConfig.Mounts as { Source: string }[]).map((m) => m.Source), ['claudepilot-rt1-home']);
    assert.equal(c.hostConfig.NanoCpus, 1e9);
    const create = rig.fake.seen('POST', /^\/containers\/create/)[0]!;
    assert.equal(create.url, '/containers/create?name=claudepilot-rt1', 'dockerode’s repeated query is gone');
  });

  it('list(), start() and stop() (304s included), and the state reads', async () => {
    const [w] = await rt.list();
    assert.equal(w!.name, 'rt1');
    assert.equal(w!.status, 'running');
    assert.equal(w!.cpus, 1);
    assert.equal(w!.memoryMb, 512);
    await rt.start('rt1'); // already running: 304, ignored
    await rt.stop('rt1');
    assert.equal((await rt.list())[0]!.status, 'stopped');
    await rt.stop('rt1'); // already stopped: 304, ignored
    await rt.start('rt1');
    assert.deepEqual(await rt.delivery!.state('rt1'), { exists: true, running: true, portal: PORTAL_ID });
    assert.deepEqual(await rt.delivery!.state('nothing'), { exists: false, running: false });
  });

  it('delivery.run with stdin, as root and as node, and an exit code', async () => {
    const seen: { cmd: string[]; user: string; stdin: string }[] = [];
    rig.fake.onExec = (cmd, { exec, stdin }) => {
      seen.push({ cmd, user: exec.user, stdin: stdin.toString() });
      return { stdout: 'out\n', stderr: 'err\n', exitCode: 4 };
    };
    const r = await rt.delivery!.run('rt1', 'cat > /tmp/x', { user: 'node', stdin: 'secret value' });
    assert.deepEqual({ code: r.code, stdout: r.stdout, stderr: r.stderr }, { code: 4, stdout: 'out\n', stderr: 'err\n' });
    assert.deepEqual(seen[0], { cmd: ['sh', '-c', 'cat > /tmp/x'], user: 'node', stdin: 'secret value' });
    await rt.delivery!.run('rt1', 'true');
    assert.equal(seen[1]!.user, '0', 'root is "0"');
  });

  it('delivery.put and read: an archive in, a file out, and null for a missing one', async () => {
    await rt.delivery!.put('rt1', [
      { path: '/etc/claudepilot', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
      { path: '/etc/claudepilot/note', type: 'file', content: 'hello', mode: 0o600, uid: 0, gid: 0 },
    ]);
    const c = [...rig.fake.containers.values()].find((x) => x.name === 'claudepilot-rt1')!;
    assert.equal(c.files.get('/etc/claudepilot/note')!.content.toString(), 'hello');
    assert.equal(await rt.delivery!.read('rt1', '/etc/claudepilot/note'), 'hello');
    assert.equal(await rt.delivery!.read('rt1', '/etc/claudepilot/missing'), null);
  });

  it('exec() with stdin, shell() with a resize, usage()', async () => {
    rig.fake.onExecStream = (_cmd, io) => io.onStdin((d) => io.write(1, `echo:${d}`));
    const session = await rt.exec('rt1', ['cat']);
    const chunks: Buffer[] = [];
    session.onData((d) => chunks.push(d));
    session.write('typed');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(Buffer.concat(chunks).toString(), 'echo:typed');
    session.close();
    rig.fake.onExecStream = null;

    const shell = await rt.shell('rt1', { cols: 80, rows: 24 });
    const out: Buffer[] = [];
    shell.onData((d) => out.push(d));
    shell.write(Buffer.from('hello\n'));
    await new Promise((r) => setTimeout(r, 150));
    shell.resize(100, 30);
    await new Promise((r) => setTimeout(r, 150));
    assert.match(Buffer.concat(out).toString(), /hello/);
    const tty = [...rig.fake.execs.values()].find((e) => e.tty)!;
    assert.deepEqual(tty.resizes, [{ w: 80, h: 24 }, { w: 100, h: 30 }]);
    shell.close();

    const [u] = await rt.usage(['rt1']);
    assert.equal(u!.cores, 2);
    assert.ok(u!.memoryBytes! > 0 && u!.cpuPercent! > 0);
  });

  it('watch() and watchStarts(): events of this portal’s workspaces arrive through the forced filters, others do not', async () => {
    const changes: number[] = [];
    const starts: string[] = [];
    const stopWatch = rt.watch((() => changes.push(1)) as () => void);
    const stopStarts = rt.delivery!.watchStarts((n) => starts.push(n));
    await new Promise((r) => setTimeout(r, 200));
    const mine = [...rig.fake.containers.values()].find((x) => x.name === 'claudepilot-rt1')!;
    const foreign = rig.fake.addContainer({ name: 'claudepilot-foreign', labels: { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'foreign', 'claudepilot.portal': 'another' } });
    const bare = rig.fake.addContainer({ name: 'bare', labels: {} });
    for (const c of [foreign, bare, mine]) rig.fake.emit('start', c);
    await new Promise((r) => setTimeout(r, 300));
    stopWatch();
    stopStarts();
    assert.deepEqual(starts, ['rt1']);
    assert.equal(changes.length, 1);
  });

  it('pulls an image by reference when it is not on the host, and never builds', async () => {
    const pulling = runtime(PULLED);
    const steps: string[] = [];
    await pulling.create({ name: 'rt2' }, (d) => steps.push(d));
    assert.ok(rig.fake.images.has(PULLED), 'the daemon pulled it');
    assert.ok(steps.some((s) => /Pulling/i.test(s)));
    assert.equal(rig.fake.seen('POST', /^\/build/).length, 0);
    await pulling.remove('rt2');
  });

  it('remove(): the container and its home volume, 404s ignored', async () => {
    rig.fake.volumes.add('claudepilot-rt1-home');
    await rt.remove('rt1');
    assert.ok(![...rig.fake.containers.values()].some((c) => c.name === 'claudepilot-rt1'));
    assert.equal(rig.fake.volumes.has('claudepilot-rt1-home'), false);
    await rt.remove('rt1'); // again: both 404
    assert.deepEqual(await rt.list(), []);
  });

  it('the policy refused none of it', () => {
    assert.deepEqual(rig.denied(), [], `refused: ${JSON.stringify(rig.denied())}`);
    assert.equal(rig.log.text().includes('policy.denied'), false);
  });
});
