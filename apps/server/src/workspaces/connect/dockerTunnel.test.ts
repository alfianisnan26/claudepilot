// T-RT (b): the whole of DockerRuntime through the tunnel (docs/prd/targets-connect.md §12.3): a ConnectDockerRuntime over one node whose
// `docker` streams are byte pipes to the DinD socket (the policy proxy is T2's and has its own suite). Create from the local workspace
// image, list with the portal's labels, exec with stdin and an exit code, a shell with a resize, put and read (a file over 150 KB: the
// archive response must be drained or destroyed), usage, start events, stop and start, remove. Needs CLAUDEPILOT_DOCKER_TESTS=1.
// Plus, always: firstFileOf destroys the archive response it leaves unread.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { pack } from 'tar-stream';
import { firstFileOf } from '../docker.js';
import type { ShellSession } from '../runtime.js';
import { ConnectDockerRuntime } from './dockerCluster.js';
import { FakeLink, memoryDeps, targetRecord } from './testkit.js';

describe('firstFileOf', () => {
  it('reads a file over 150 KB and destroys the rest of the response', async () => {
    const p = pack();
    p.entry({ name: 'big.txt', mode: 0o644 }, 'x'.repeat(200_000));
    p.finalize();
    const chunks: Buffer[] = [];
    for await (const c of p) chunks.push(c as Buffer);
    // The response never ends on its own (a kept-alive connection): only a destroy lets it go.
    let i = 0;
    const archive = Buffer.concat(chunks);
    const source = new Readable({
      read() {
        if (i < archive.length) {
          this.push(archive.subarray(i, i + 16_384));
          i += 16_384;
        }
      },
    });
    const text = await firstFileOf(source);
    assert.equal(text!.length, 200_000);
    assert.equal(source.destroyed, true);
  });
});

const docker = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const NAME = 'cx3-tun1';

describe('DockerRuntime through the tunnel (DinD)', { skip: !docker && 'set CLAUDEPILOT_DOCKER_TESTS=1' }, () => {
  let link: FakeLink;
  let rt: ConnectDockerRuntime;
  let hold: NodeJS.Timeout;
  let stopStarts = () => undefined as void;

  before(() => {
    hold = setInterval(() => undefined, 1000);
    link = new FakeLink('n1', 'cx3-dock', { dockerSocket: '/var/run/docker.sock' }).connect();
    rt = new ConnectDockerRuntime(targetRecord({ id: 'cx3-dock' }), [{ record: { id: 'n1', targetId: 'cx3-dock', name: 'dind', drained: false, keyFingerprint: 'x' }, link }], memoryDeps());
  });
  after(() => {
    clearInterval(hold);
    stopStarts();
    rt.dispose();
    link.drop();
    for (const args of [['rm', '-f', `claudepilot-${NAME}`], ['volume', 'rm', '-f', `claudepilot-${NAME}-home`]]) {
      try {
        execFileSync('docker', args, { stdio: 'ignore' });
      } catch {
        // already gone
      }
    }
  });

  it('creates, lists, runs, shells, delivers, reads, measures and removes', { timeout: 120_000 }, async () => {
    await rt.check();
    const started: string[] = [];
    stopStarts = rt.delivery!.watchStarts((n) => started.push(n));
    await new Promise((r) => setTimeout(r, 300)); // the events stream is up
    await rt.create({ name: NAME, cpus: 1, memoryMb: 512 }, () => undefined);
    const w = (await rt.list()).find((x) => x.name === NAME)!;
    assert.equal(w.status, 'running');
    assert.equal(w.id, `cx3-dock/${NAME}`);
    assert.equal(w.node, 'n1');
    const labels = JSON.parse(execFileSync('docker', ['inspect', '-f', '{{json .Config.Labels}}', `claudepilot-${NAME}`]).toString()) as Record<string, string>;
    assert.equal(labels['claudepilot.managed'], 'true');
    assert.equal(labels['claudepilot.portal'], 'cx3-portal');

    // exec with stdin and an exit code
    const ex = await rt.exec(NAME, ['sh', '-c', 'read x; echo "got $x"; exit 4']);
    let out = '';
    ex.onData((d) => (out += d.toString()));
    const code = new Promise<number | null>((r) => ex.onExit(r));
    ex.write('tunnel\n');
    assert.equal(await code, 4);
    assert.equal(out.trim(), 'got tunnel');

    // a shell with a resize
    const sh: ShellSession = await rt.shell(NAME, { cols: 80, rows: 24 }, ['sh', '-c', 'stty size; read x; stty size']);
    let term = '';
    sh.onData((d) => (term += d.toString()));
    const shExit = new Promise<number | null>((r) => sh.onExit(r));
    await new Promise((r) => setTimeout(r, 500));
    sh.resize(120, 40);
    await new Promise((r) => setTimeout(r, 300));
    sh.write(Buffer.from('\n'));
    assert.equal(await shExit, 0);
    // The first size races DockerRuntime's own first resize (as on a local socket); the resize afterwards is what matters.
    assert.match(term, /40 120/);

    // delivery: put with a mode, run as root with stdin, read a big file
    await rt.delivery!.put(NAME, [{ path: '/home/node/.cx3/big', type: 'file', content: 'y'.repeat(160_000), mode: 0o600, uid: 1000, gid: 1000 }]);
    const run = await rt.delivery!.run(NAME, 'stat -c %a /home/node/.cx3/big; cat', { stdin: 'in' });
    assert.deepEqual([run.code, run.stdout], [0, '600\nin']);
    assert.equal((await rt.delivery!.read(NAME, '/home/node/.cx3/big'))!.length, 160_000);
    assert.equal(await rt.delivery!.read(NAME, '/home/node/.cx3/none'), null);

    const [u] = await rt.usage([NAME]);
    assert.equal(typeof u!.memoryBytes, 'number');

    await rt.stop(NAME);
    assert.equal((await rt.list()).find((x) => x.name === NAME)!.status, 'stopped');
    await rt.start(NAME);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(started.includes(NAME), 'a start event came through the tunnel');
    stopStarts();

    await rt.remove(NAME);
    assert.equal((await rt.list()).some((x) => x.name === NAME), false);
    assert.ok(link.opened.length > 5);
  });
});
