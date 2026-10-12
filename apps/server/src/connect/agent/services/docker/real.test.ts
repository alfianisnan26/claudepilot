// T-POL against the REAL daemon (docs/prd/targets-connect.md §19.3): the policy proxy in front of this machine's Docker (the dev container's own DinD),
// opt-in like the other real-Docker tests: CLAUDEPILOT_DOCKER_TESTS=1. The one workspace the real DockerRuntime makes carries `claudepilot.managed` (it must: the
// policy and the runtime both require it) for a few seconds, with a portal id of its own that no other portal shares, so they skip it; nothing else here does. The real `DockerRuntime` makes one workspace through it (the image must exist
// locally; nothing is pulled), every operation is allowed and the container really is what the portal asked for; then the attacks of scenario A10 are
// sent and the daemon is asked, directly, whether any of them left anything behind. Everything it makes is named `claudepilot-cx2real-*` and removed.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import Docker from 'dockerode';
import { DockerRuntime } from '../../../../workspaces/docker.js';
import { collectingLogger } from '../../log.js';
import { streamPair } from '../../testkit/streams.js';
import { createService, type DockerService } from './index.js';

const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const SOCKET = process.env.PORTAL_DOCKER_SOCKET ?? '/var/run/docker.sock';
const IMAGE = process.env.CX2_REAL_IMAGE ?? 'claudepilot-workspace:latest';
const PORTAL_ID = '00000000-cx20-4000-8000-real00000001';
const NAME = 'cx2real-w1';
const DECOY = 'cx2real-decoy';

let service: DockerService;
let direct: Docker;
let agent: http.Agent;
const log = collectingLogger();

class StreamAgent extends http.Agent {
  override createConnection(_o: http.ClientRequestArgs, _cb?: (err: Error | null, s: never) => void) {
    const [portal, side] = streamPair();
    service.handle(side as never, 'real0001');
    portal.once('end', () => portal.end());
    return portal;
  }
}

const raw = async (bytes: string): Promise<string> => {
  const [portal, side] = streamPair();
  service.handle(side as never, 'real0002');
  const parts: Buffer[] = [];
  portal.on('data', (c: Buffer) => parts.push(c));
  portal.on('error', () => undefined);
  portal.write(bytes);
  await new Promise((r) => setTimeout(r, 600));
  portal.destroy();
  return Buffer.concat(parts).toString('latin1');
};
const post = (path: string, body: unknown) => `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(JSON.stringify(body))}\r\n\r\n${JSON.stringify(body)}`;

describe('the policy proxy in front of the real Docker daemon', { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 (a real daemon and the workspace image are needed)' }, () => {
  before(async () => {
    direct = new Docker({ socketPath: SOCKET });
    await direct.getImage(IMAGE).inspect(); // nothing is pulled or built here: the image must exist
    service = createService({ socket: SOCKET, images: [IMAGE], portalId: () => PORTAL_ID, log: log.logger });
    await service.refresh!();
    assert.equal(service.status().ok, true, JSON.stringify(service.status()));
    agent = new StreamAgent({ keepAlive: true });
  });
  after(async () => {
    agent?.destroy();
    for (const name of [NAME, DECOY, 'cx2real-evil', 'cx2real-bind']) {
      await direct?.getContainer(`claudepilot-${name}`).remove({ force: true }).catch(() => undefined);
      await direct?.getVolume(`claudepilot-${name}-home`).remove().catch(() => undefined);
    }
    service?.close();
  });

  it('reports the real engine in the status the portal shows', () => {
    const { docker } = service.report!();
    assert.ok(docker!.engine && docker!.ncpu > 0 && docker!.memTotal > 0, JSON.stringify(docker));
    assert.deepEqual(docker!.images, [IMAGE]);
  });

  it('the real DockerRuntime makes, runs and removes a workspace through it, and the container is what was asked for', async () => {
    const client = new Docker({ protocol: 'http', host: 'tunnel.invalid', port: 2375, agent } as never);
    const rt = new DockerRuntime({ id: 'real', label: 'Real', socket: SOCKET }, IMAGE, '/nonexistent', () => PORTAL_ID, client, { tunnel: { reach: async () => void (await client.ping()), where: 'real' } });
    await rt.check();
    await rt.create({ name: NAME, cpus: 1, memoryMb: 512 }, () => undefined);
    const info = await direct.getContainer(`claudepilot-${NAME}`).inspect();
    assert.equal(info.Config.Labels['claudepilot.managed'], 'true');
    assert.equal(info.Config.Labels['claudepilot.portal'], PORTAL_ID);
    assert.equal(info.HostConfig.Privileged, false);
    assert.deepEqual(info.HostConfig.Binds ?? [], []);
    assert.deepEqual(info.Mounts.map((m) => [m.Type, m.Name, m.Destination]), [['volume', `claudepilot-${NAME}-home`, '/home/node']]);
    assert.equal(info.HostConfig.Memory, 512 * 1024 * 1024);
    assert.equal(info.State.Running, true);

    assert.deepEqual((await rt.list()).map((w) => [w.name, w.status]), [[NAME, 'running']]);
    const r = await rt.delivery!.run(NAME, 'cat; echo "id=$(id -un)"', { user: 'node', stdin: 'typed\n' });
    assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 0, stdout: 'typed\nid=node\n' });
    await rt.delivery!.put(NAME, [{ path: '/home/node/cx2-note', type: 'file', content: 'kept', mode: 0o600, uid: 1000, gid: 1000 }]);
    assert.equal(await rt.delivery!.read(NAME, '/home/node/cx2-note'), 'kept');
    const session = await rt.shell(NAME, { cols: 90, rows: 28 }, ['sh']);
    const out: Buffer[] = [];
    session.onData((d) => out.push(d));
    session.write(Buffer.from('stty size; exit\n'));
    await new Promise((resolve) => session.onExit(() => resolve(undefined)));
    assert.match(Buffer.concat(out).toString(), /28 90/);
    const [u] = await rt.usage([NAME]);
    assert.ok(u!.memoryBytes! > 0);
    await rt.stop(NAME);
    assert.equal((await rt.list())[0]!.status, 'stopped');
    await rt.start(NAME);
    await rt.remove(NAME);
    assert.deepEqual(await rt.list(), []);
    assert.deepEqual(service.report!().denied ?? [], [], 'the policy refused nothing of it');
  });

  it('the attacks of A10 are refused with their rule, and the daemon is left as it was', async () => {
    const labels = { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'cx2real-evil', 'claudepilot.portal': PORTAL_ID };
    const attacks: [string, string, string][] = [
      ['privileged', post('/containers/create?name=claudepilot-cx2real-evil', { Image: IMAGE, Labels: labels, HostConfig: { Privileged: true } }), 'create.privileged'],
      ['a bind of /', post('/containers/create?name=claudepilot-cx2real-bind', { Image: IMAGE, Labels: { ...labels, 'claudepilot.workspace': 'cx2real-bind' }, HostConfig: { Binds: ['/:/host'] } }), 'create.bind'],
      ['the host pid namespace', post('/containers/create?name=claudepilot-cx2real-evil', { Image: IMAGE, Labels: labels, HostConfig: { PidMode: 'host' } }), 'create.namespace'],
      ['an o=bind volume', post('/volumes/create', { Name: 'claudepilot-cx2real-evil-home', DriverOpts: { type: 'none', o: 'bind', device: '/' } }), 'volume.options'],
      ['a build', 'POST /build?t=x HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n', 'build'],
      ['a network', 'GET /networks HTTP/1.1\r\nHost: x\r\n\r\n', 'path'],
      ['a smuggled absolute target', 'GET http://evil/containers/json HTTP/1.1\r\nHost: x\r\n\r\n', 'path'],
    ];
    for (const [what, bytes, rule] of attacks) {
      const answer = await raw(bytes);
      assert.match(answer, /^HTTP\/1\.1 403 /, what);
      assert.match(answer, new RegExp(`denied by claudepilot policy \\(${rule.replace('.', '\\.')}\\)`), what);
    }
    const names = (await direct.listContainers({ all: true })).flatMap((c) => c.Names);
    assert.ok(!names.some((n) => n.startsWith('/claudepilot-cx2real-evil') || n.startsWith('/claudepilot-cx2real-bind')), 'no container of an attack exists');
    assert.equal((await direct.listVolumes()).Volumes.some((v) => v.Name.startsWith('claudepilot-cx2real-evil')), false);
  });

  it('it never touches a container that is not this portal’s: a decoy of another portal, by name and by id, is exactly as it was', async () => {
    // A stand-in for "someone else's container on the same daemon" (made here, so no other agent's workspace is ever attacked).
    const decoy = await direct.createContainer({
      name: `claudepilot-${DECOY}`,
      Image: 'node:22-trixie-slim',
      Cmd: ['sleep', '300'],
      // Not labelled `claudepilot.managed`: other portals on this daemon poll that label (PLAN-2 A.13). An unlabelled container is just as "unmanaged"
      // to the policy; the other-portal branch (managed, wrong portal id) is covered against the fake daemon in policy.test.ts.
      Labels: { 'cx2.rig': '1', 'claudepilot.portal': 'another-portal-id' },
    });
    await decoy.start();
    for (const ref of [decoy.id, `claudepilot-${DECOY}`]) {
      for (const [method, path, body] of [['GET', `/containers/${ref}/json`, ''], ['POST', `/containers/${ref}/stop`, ''], ['POST', `/containers/${ref}/kill`, ''], ['DELETE', `/containers/${ref}?force=true`, ''], ['POST', `/containers/${ref}/exec`, '{"Cmd":["sh"]}'], ['GET', `/containers/${ref}/archive?path=/etc/passwd`, '']] as const) {
        const answer = await raw(`${method} ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
        assert.match(answer, /^HTTP\/1\.1 403 /, `${method} ${path}`);
        assert.match(answer, /\(unmanaged\)/);
      }
    }
    assert.equal((await decoy.inspect()).State.Running, true, 'the other portal’s container is exactly as it was');
  });

  it('lists only this portal’s workspaces on a daemon that has others', async () => {
    const answer = await raw('GET /containers/json?all=true HTTP/1.1\r\nHost: x\r\n\r\n');
    const body = answer.slice(answer.indexOf('\r\n\r\n') + 4);
    const json = body.slice(body.indexOf('['), body.lastIndexOf(']') + 1);
    assert.deepEqual(JSON.parse(json), [], 'this portal has no workspace here, whatever else runs on the daemon (the decoy and everyone else’s are not listed)');
  });
});
