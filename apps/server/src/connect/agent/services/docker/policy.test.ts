// T-POL (docs/prd/targets-connect.md §19.3): the Docker policy proxy against a recording fake daemon. A table of what is allowed and
// what is denied with which rule (appendix A), the forcing of filters and the use of full container ids, the adversarial corpus of
// scenario A10, framing and smuggling attacks with raw bytes, and fuzzed create bodies. The point of every denial test is twofold:
// the client sees 403 with the rule id, and the daemon's request log shows it never saw the request.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { IMAGE, PORTAL_ID, startDockerRig, type Answer, type DockerRig } from '../../testkit/dockerRig.js';
import { classify, normalizeTarget, normalizeImageRef, ImageAllow, pullRef } from './rules.js';

let rig: DockerRig;
const NAME = 'claudepilot-w1';
const labels = (name = 'w1') => ({ 'claudepilot.managed': 'true', 'claudepilot.workspace': name, 'claudepilot.portal': PORTAL_ID });
const goodCreate = (over: Record<string, unknown> = {}, ws = 'w1') => ({
  Image: IMAGE,
  Hostname: ws,
  User: 'node',
  WorkingDir: '/home/node',
  Labels: labels(ws),
  Env: ['TERM=xterm-256color'],
  HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Mounts: [{ Type: 'volume', Source: `claudepilot-${ws}-home`, Target: '/home/node' }], NanoCpus: 1e9, Memory: 536_870_912 },
  ...over,
});
const withHost = (host: Record<string, unknown>) => goodCreate({ HostConfig: { ...goodCreate().HostConfig, ...host } });

const denied = (a: Answer, rule: string) => {
  assert.equal(a.status, 403, `expected a denial, got ${a.status} ${a.text.slice(0, 200)}`);
  assert.deepEqual(a.json(), { message: `denied by claudepilot policy (${rule})` });
};
const daemonSaw = (method: string, pattern: RegExp) => rig.fake.requests.filter((r) => r.method === method && pattern.test(r.url));

before(async () => {
  rig = await startDockerRig();
});
after(() => rig.stop());

describe('what a managed workspace needs is allowed', () => {
  it('answers the simple reads', async () => {
    assert.equal((await rig.request('GET', '/_ping')).text, 'OK');
    assert.equal((await rig.request('HEAD', '/_ping')).status, 200);
    assert.equal((await rig.request('GET', '/v1.46/version')).status, 200, 'an API version prefix is kept');
    assert.equal((await rig.request('GET', '/info')).status, 200);
  });

  it('creates, inspects by name, starts, stops and removes a workspace container, and uses the FULL id once it has checked', async () => {
    const created = await rig.request('POST', `/containers/create?name=${NAME}`, { body: goodCreate() });
    assert.equal(created.status, 201, created.text);
    const { Id } = created.json() as { Id: string };
    assert.equal((await rig.request('GET', `/containers/${NAME}/json`)).status, 200);
    assert.equal(daemonSaw('GET', new RegExp(`^/containers/${Id}/json$`)).length, 1, 'the daemon was asked about the id, not the name');
    assert.equal((await rig.request('POST', `/containers/${NAME}/start`)).status, 204);
    assert.equal((await rig.request('POST', `/containers/${Id.slice(0, 12)}/stop?t=5`)).status, 204, 'a short id resolves to the full one');
    assert.ok(daemonSaw('POST', new RegExp(`^/containers/${Id}/stop\\?t=5$`)).length === 1);
    assert.equal((await rig.request('DELETE', `/containers/${NAME}?force=true`)).status, 204);
    assert.equal(rig.fake.containers.size, 0);
  });

  it('rebuilds the create query: only name (and platform) go on, whatever else a client repeats there', async () => {
    rig.fake.requests.length = 0;
    const extra = new URLSearchParams({ name: 'claudepilot-w2', Image: IMAGE, Hostname: 'w2', Labels: '{"a":"b"}', HostConfig: '{}', foo: 'bar' }).toString();
    const created = await rig.request('POST', `/containers/create?${extra}`, { body: goodCreate({ name: 'claudepilot-w2' }, 'w2') });
    assert.equal(created.status, 201, created.text);
    const seen = daemonSaw('POST', /^\/containers\/create/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, '/containers/create?name=claudepilot-w2');
    assert.equal('name' in (JSON.parse(seen[0]!.body.toString()) as object), false, 'the body is rebuilt from validated fields only');
    await rig.request('DELETE', '/containers/claudepilot-w2?force=true');
  });

  it('runs an exec on a managed container and may start it (the id was made through this agent)', async () => {
    const c = rig.fake.addContainer({ name: 'claudepilot-ex', labels: labels('ex') });
    rig.fake.onExec = () => ({ stdout: 'hello\n', exitCode: 3 });
    const made = await rig.request('POST', '/containers/claudepilot-ex/exec', { body: { Cmd: ['echo', 'hello'], User: 'node', WorkingDir: '/home/node', Env: ['HOME=/home/node'], AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: false } });
    assert.equal(made.status, 201, made.text);
    const id = (made.json() as { Id: string }).Id;
    const started = await rig.request('POST', `/exec/${id}/start`, { body: { Detach: false, Tty: false, hijack: true, stdin: false } });
    assert.equal(started.status, 200);
    assert.match(started.text, /hello/);
    assert.equal(((await rig.request('GET', `/exec/${id}/json`)).json() as { ExitCode: number }).ExitCode, 3);
    assert.equal((await rig.request('POST', `/exec/${id}/resize?h=24&w=80`)).status, 200);
    assert.deepEqual(rig.fake.execs.get(id)!.resizes, [{ w: 80, h: 24 }]);
    const startBody = JSON.parse(daemonSaw('POST', new RegExp(`^/exec/${id}/start`))[0]!.body.toString()) as object;
    assert.deepEqual(startBody, { Detach: false, Tty: false }, 'docker-modem’s client-side switches are not forwarded');
    rig.fake.containers.delete(c.id);
  });

  it('allows stats, logs, archives, a home volume and an allowlisted image', async () => {
    rig.fake.addContainer({ name: 'claudepilot-misc', labels: labels('misc') });
    assert.equal((await rig.request('GET', '/containers/claudepilot-misc/stats?stream=false')).status, 200);
    assert.equal((await rig.request('GET', '/containers/claudepilot-misc/logs?stdout=1&stderr=1&tail=10')).status, 200);
    assert.equal((await rig.request('PUT', '/containers/claudepilot-misc/archive?path=%2F', { rawBody: Buffer.alloc(1024), headers: { 'Content-Type': 'application/x-tar' } })).status, 200);
    assert.equal((await rig.request('GET', '/containers/claudepilot-misc/archive?path=%2Fnope')).status, 404);
    assert.equal((await rig.request('POST', '/volumes/create', { body: { Name: 'claudepilot-misc-home', Labels: { a: 'b' } } })).status, 201);
    assert.equal((await rig.request('GET', '/volumes/claudepilot-misc-home')).status, 200);
    assert.equal((await rig.request('DELETE', '/volumes/claudepilot-misc-home')).status, 204);
    assert.equal((await rig.request('GET', `/images/${IMAGE}/json`)).status, 200);
    assert.equal((await rig.request('GET', `/images/docker.io/library/alpine/json`)).status, 403, 'only an allowlisted reference');
    assert.equal((await rig.request('POST', '/images/create?fromImage=claudepilot-workspace&tag=latest')).status, 200);
  });

  it('answers 404 for a container that does not exist (not a denial) and never forwards it by name', async () => {
    rig.fake.requests.length = 0;
    for (const [m, p] of [['GET', '/containers/claudepilot-ghost/json'], ['POST', '/containers/claudepilot-ghost/start'], ['DELETE', '/containers/claudepilot-ghost?force=1']] as const) {
      const a = await rig.request(m, p);
      assert.equal(a.status, 404, `${m} ${p}`);
      assert.match((a.json() as { message: string }).message, /No such container/);
    }
    assert.equal(daemonSaw('POST', /start/).length + daemonSaw('DELETE', /ghost/).length, 0, 'only the lookup reached the daemon');
  });
});

describe('what it must refuse, with the rule id, and the daemon never sees it', () => {
  const create = (body: unknown, name = NAME) => rig.request('POST', `/containers/create?name=${name}`, { body });

  const before_ = () => rig.fake.requests.length;
  const nothingNew = (n: number, pattern: RegExp = /./) => assert.equal(rig.fake.requests.slice(n).filter((r) => pattern.test(r.url)).length, 0, `the daemon saw: ${rig.fake.requests.slice(n).map((r) => `${r.method} ${r.url}`).join(', ')}`);

  it('refuses a create the schema does not allow, each with its own rule', async () => {
    const n = before_();
    const cases: [string, unknown, string][] = [
      ['a privileged container', withHost({ Privileged: true }), 'create.privileged'],
      ['host pid', withHost({ PidMode: 'host' }), 'create.namespace'],
      ['host ipc', withHost({ IpcMode: 'host' }), 'create.namespace'],
      ['host uts', withHost({ UTSMode: 'host' }), 'create.namespace'],
      ['host userns', withHost({ UsernsMode: 'host' }), 'create.namespace'],
      ['a bind of /', withHost({ Binds: ['/:/host'] }), 'create.bind'],
      ['a bind mount', withHost({ Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] }), 'create.bind'],
      ['a tmpfs mount', withHost({ Mounts: [{ Type: 'tmpfs', Target: '/t' }] }), 'create.bind'],
      ['volumes-from', withHost({ VolumesFrom: ['other'] }), 'create.bind'],
      ['another container’s volume', withHost({ Mounts: [{ Type: 'volume', Source: 'claudepilot-other-data', Target: '/x' }] }), 'create.volume'],
      ['another workspace’s home volume', withHost({ Mounts: [{ Type: 'volume', Source: 'claudepilot-w2-home', Target: '/home/node' }] }), 'create.volume'],
      ['a volume with options', withHost({ Mounts: [{ Type: 'volume', Source: 'claudepilot-w1-home', Target: '/home/node', VolumeOptions: { DriverConfig: {} } }] }), 'create.volume'],
      ['a mount under /var/run', withHost({ Mounts: [{ Type: 'volume', Source: 'claudepilot-w1-home', Target: '/var/run/docker.sock' }] }), 'create.volume'],
      ['a device', withHost({ Devices: [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda' }] }), 'create.device'],
      ['a gpu request', withHost({ DeviceRequests: [{ Count: -1 }] }), 'create.device'],
      ['an added capability', withHost({ CapAdd: ['SYS_ADMIN'] }), 'create.capability'],
      ['a seccomp opt-out', withHost({ SecurityOpt: ['seccomp=unconfined'] }), 'create.capability'],
      ['sysctls', withHost({ Sysctls: { 'net.ipv4.ip_forward': '1' } }), 'create.capability'],
      ['another runtime', withHost({ Runtime: 'nvidia' }), 'create.capability'],
      ['published ports', withHost({ PortBindings: { '80/tcp': [{ HostPort: '80' }] } }), 'create.port'],
      ['exposed ports', goodCreate({ ExposedPorts: { '80/tcp': {} } }), 'create.port'],
      ['publish all', withHost({ PublishAllPorts: true }), 'create.port'],
      ['the host network', withHost({ NetworkMode: 'host' }), 'create.network'],
      ['a container network', withHost({ NetworkMode: 'container:abc' }), 'create.network'],
      ['links', withHost({ Links: ['db:db'] }), 'create.network'],
      ['a networking config', goodCreate({ NetworkingConfig: { EndpointsConfig: { net1: {} } } }), 'create.network'],
      ['an unknown top-level field', goodCreate({ Domainname: 'x' }), 'create.field'],
      ['an unknown HostConfig field', withHost({ OomKillDisable: true }), 'create.field'],
      ['a cgroup parent', withHost({ CgroupParent: '/x' }), 'create.field'],
      ['an image that is not allowed', goodCreate({ Image: 'alpine:latest' }), 'create.image'],
      ['no image', goodCreate({ Image: undefined }), 'create.image'],
      ['no managed label', goodCreate({ Labels: { 'claudepilot.workspace': 'w1', 'claudepilot.portal': PORTAL_ID } }), 'create.label'],
      ['no labels at all', goodCreate({ Labels: undefined }), 'create.label'],
      ['another portal’s id', goodCreate({ Labels: { ...labels(), 'claudepilot.portal': 'other-portal' } }), 'create.label'],
      ['no portal id', goodCreate({ Labels: { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'w1' } }), 'create.label'],
      ['a workspace label that differs from the name', goodCreate({ Labels: labels('w9') }), 'create.label'],
      ['the agent’s own label', goodCreate({ Labels: { ...labels(), 'claudepilot.connect': 'agent' } }), 'create.label'],
      ['a mount whose target is /', withHost({ Mounts: [{ Type: 'volume', Source: 'claudepilot-w1-home', Target: '/' }] }), 'create.volume'],
      ['an unreasonable memory value', withHost({ Memory: -5 }), 'create.field'],
      ['a body that is not an object', [1, 2, 3], 'body'],
    ];
    for (const [what, body, rule] of cases) denied(await create(body), rule);
    for (const name of ['evil', 'claudepilot-', 'claudepilot-UPPER', 'claudepilot-../x', 'claudepilot-a b', `claudepilot-${'a'.repeat(70)}`]) {
      denied(await rig.request('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body: goodCreate() }), 'create.name');
    }
    denied(await rig.request('POST', '/containers/create', { body: goodCreate() }), 'create.name');
    denied(await rig.request('POST', `/containers/create?name=${NAME}`, { rawBody: '{"Image": ' }), 'body');
    nothingNew(n, /containers\/create/);
  });

  it('only manages containers that are this portal’s: an unmanaged, unlabelled, other-portal or agent container is refused everywhere', async () => {
    const agent = rig.fake.addContainer({ name: 'claudepilot-agent-x', labels: { 'claudepilot.connect': 'agent' } });
    const bare = rig.fake.addContainer({ name: 'someones-db', labels: {} });
    const foreign = rig.fake.addContainer({ name: 'claudepilot-foreign', labels: { ...labels('foreign'), 'claudepilot.portal': 'another-portal' } });
    const n = before_();
    for (const c of [agent, bare, foreign]) {
      for (const [m, p] of [['GET', `/containers/${c.name}/json`], ['POST', `/containers/${c.name}/start`], ['POST', `/containers/${c.name}/stop`], ['POST', `/containers/${c.name}/kill`], ['DELETE', `/containers/${c.name}?force=true`], ['GET', `/containers/${c.id}/stats`], ['GET', `/containers/${c.id}/logs`], ['PUT', `/containers/${c.name}/archive?path=/`], ['GET', `/containers/${c.name}/archive?path=/etc/passwd`]] as const) {
        denied(await rig.request(m, p, m === 'PUT' ? { rawBody: Buffer.alloc(512) } : {}), 'unmanaged');
      }
      denied(await rig.request('POST', `/containers/${c.name}/exec`, { body: { Cmd: ['sh'] } }), 'unmanaged');
    }
    nothingNew(n, /^\/containers\/(?!create).*\/(start|stop|kill|exec|archive|logs|stats)|DELETE/);
    assert.ok(rig.fake.containers.has(agent.id), 'the agent’s own container is still there');
  });

  it('refuses privileged and odd execs, and execs it did not create', async () => {
    rig.fake.addContainer({ name: 'claudepilot-ex2', labels: labels('ex2') });
    const n = before_();
    denied(await rig.request('POST', '/containers/claudepilot-ex2/exec', { body: { Cmd: ['sh'], Privileged: true } }), 'exec.privileged');
    denied(await rig.request('POST', '/containers/claudepilot-ex2/exec', { body: { Cmd: ['sh'], Foo: 1 } }), 'body');
    denied(await rig.request('POST', '/containers/claudepilot-ex2/exec', { body: { User: 'root' } }), 'body');
    const stranger = 'f'.repeat(64);
    for (const [m, p] of [['POST', `/exec/${stranger}/start`], ['POST', `/exec/${stranger}/resize?h=1&w=1`], ['GET', `/exec/${stranger}/json`]] as const) denied(await rig.request(m, p, { body: {} }), 'unmanaged');
    nothingNew(n, /exec/);
  });

  it('refuses volumes and images outside the allowlist', async () => {
    const n = before_();
    denied(await rig.request('POST', '/volumes/create', { body: { Name: 'claudepilot-x-home', DriverOpts: { type: 'none', o: 'bind', device: '/' } } }), 'volume.options');
    denied(await rig.request('POST', '/volumes/create', { body: { Name: 'claudepilot-x-home', Driver: 'nfs' } }), 'volume.options');
    denied(await rig.request('POST', '/volumes/create', { body: { Name: 'evil' } }), 'volume.name');
    denied(await rig.request('POST', '/volumes/create', { body: { Name: 'claudepilot-x-home', Extra: 1 } }), 'body');
    denied(await rig.request('GET', '/volumes/evil'), 'volume.name');
    denied(await rig.request('DELETE', '/volumes/claudepilot-other'), 'volume.name');
    denied(await rig.request('GET', '/images/alpine:latest/json'), 'image.ref');
    denied(await rig.request('POST', '/images/create?fromImage=alpine&tag=latest'), 'image.ref');
    denied(await rig.request('POST', `/images/create?fromImage=${IMAGE.split(':')[0]}&tag=latest&fromSrc=http://evil/x.tar`), 'image.ref');
    denied(await rig.request('POST', '/images/create?fromSrc=-'), 'image.ref');
    nothingNew(n, /^\/(volumes|images)/);
  });

  it('refuses everything else in the Engine API: builds, networks, swarm, plugins, system, commit, other methods', async () => {
    const n = before_();
    const c = rig.fake.addContainer({ name: 'claudepilot-else', labels: labels('else') });
    denied(await rig.request('POST', '/build?t=x', { rawBody: Buffer.alloc(100) }), 'build');
    denied(await rig.request('POST', '/build'), 'build');
    for (const [m, p, rule] of [
      ['GET', '/networks', 'path'],
      ['POST', '/networks/create', 'path'],
      ['POST', '/swarm/init', 'path'],
      ['GET', '/services', 'path'],
      ['GET', '/nodes', 'path'],
      ['GET', '/tasks', 'path'],
      ['GET', '/secrets', 'path'],
      ['GET', '/configs', 'path'],
      ['GET', '/plugins', 'path'],
      ['GET', '/system/df', 'path'],
      ['POST', '/commit?container=x', 'path'],
      ['POST', '/auth', 'path'],
      ['POST', '/session', 'path'],
      ['GET', '/distribution/x/json', 'path'],
      ['POST', '/containers/prune', 'path'],
      ['GET', '/images/json', 'path'],
      ['POST', '/images/prune', 'path'],
      ['GET', '/volumes', 'path'],
      ['POST', '/volumes/prune', 'path'],
      ['POST', `/containers/${c.name}/update`, 'path'],
      ['POST', `/containers/${c.name}/attach`, 'path'],
      ['POST', `/containers/${c.name}/rename?name=x`, 'path'],
      ['GET', `/containers/${c.name}/top`, 'path'],
      ['GET', `/containers/${c.name}/changes`, 'path'],
      ['GET', `/containers/${c.name}/export`, 'path'],
      ['POST', `/containers/${c.name}/resize`, 'path'],
      ['POST', '/containers/json', 'method'],
      ['DELETE', '/containers/json', 'method'],
      ['GET', '/containers/create', 'method'],
      ['GET', `/containers/${c.name}/start`, 'method'],
      ['GET', `/containers/${c.name}/kill`, 'method'],
      ['PUT', `/containers/${c.name}`, 'method'],
      ['DELETE', '/images/x/json', 'method'],
      ['PATCH', '/containers/json', 'method'],
      ['OPTIONS', '/containers/json', 'method'],
      ['TRACE', '/info', 'method'],
      ['POST', '/info', 'method'],
      ['POST', '/_ping', 'method'],
    ] as const) {
      denied(await rig.request(m, p), rule);
    }
    nothingNew(n);
  });

  it('refuses a request with values the daemon would read differently: flags, signals, times, timeouts', async () => {
    rig.fake.addContainer({ name: 'claudepilot-q', labels: labels('q') });
    const n = before_();
    denied(await rig.request('POST', '/containers/claudepilot-q/kill?signal=SIGUSR1'), 'path');
    denied(await rig.request('POST', '/containers/claudepilot-q/stop?t=-1'), 'path');
    denied(await rig.request('POST', '/containers/claudepilot-q/stop?t=99999'), 'path');
    denied(await rig.request('DELETE', '/containers/claudepilot-q?force=maybe'), 'path');
    denied(await rig.request('GET', '/containers/claudepilot-q/stats?stream=2'), 'path');
    denied(await rig.request('GET', '/containers/claudepilot-q/archive'), 'path');
    denied(await rig.request('GET', '/events?since=yesterday'), 'events.filter');
    denied(await rig.request('GET', '/events?filters=not-json'), 'events.filter');
    denied(await rig.request('GET', `/events?filters=${encodeURIComponent('{"event":["start; drop"]}')}`), 'events.filter');
    denied(await rig.request('GET', '/containers/json?all=yes'), 'path');
    denied(await rig.request('GET', '/containers/json?limit=-3'), 'path');
    nothingNew(n, /(kill|stop|archive|stats|events|containers\/json)/);
  });
});

describe('filters are forced, not asked for', () => {
  it('lists only this portal’s workspaces, whatever the client filters on', async () => {
    rig.fake.addContainer({ name: 'claudepilot-list-a', labels: labels('list-a') });
    rig.fake.addContainer({ name: 'claudepilot-list-b', labels: { ...labels('list-b'), 'claudepilot.portal': 'another-portal' } });
    rig.fake.addContainer({ name: 'claudepilot-list-c', labels: {} });
    const mine = (await rig.request('GET', `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ['claudepilot.managed=true'] }))}`)).json() as { Names: string[] }[];
    const names = mine.flatMap((c) => c.Names);
    assert.ok(names.includes('/claudepilot-list-a'));
    assert.ok(!names.includes('/claudepilot-list-b') && !names.includes('/claudepilot-list-c'));
    // Asking for nothing, or for everyone else’s, changes nothing.
    for (const filters of [undefined, { label: ['claudepilot.portal!=' + PORTAL_ID] }, { label: [] }, { name: ['.*'] }, { ancestor: ['x'] }, { label: 'claudepilot.managed' }]) {
      const q = filters === undefined ? 'all=1' : `all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`;
      const a = await rig.request('GET', `/containers/json?${q}`);
      if (a.status === 200) {
        const listed = (a.json() as { Names: string[] }[]).flatMap((c) => c.Names);
        assert.ok(!listed.includes('/claudepilot-list-b') && !listed.includes('/claudepilot-list-c'), JSON.stringify(filters));
      }
    }
    const lastList = rig.fake.seen('GET', /^\/containers\/json/).at(-1)!;
    const sent = JSON.parse(new URL(lastList.url, 'http://x').searchParams.get('filters')!) as { label: string[] };
    assert.ok(sent.label.includes('claudepilot.managed=true') && sent.label.includes(`claudepilot.portal=${PORTAL_ID}`), 'the daemon was given both labels');
  });

  it('events: the daemon is asked for container events of this portal’s workspaces only, and an unmanaged one never arrives', async () => {
    const got: string[] = [];
    const req = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const r = http.request({ host: 'tunnel.invalid', port: 2375, path: `/events?filters=${encodeURIComponent(JSON.stringify({ type: ['network', 'container'], label: ['x=y'], event: ['start'] }))}`, agent: rig.agent }, resolve);
      r.on('error', reject);
      r.end();
    });
    req.on('data', (c: Buffer) => got.push(...c.toString().trim().split('\n')));
    await new Promise((r) => setTimeout(r, 100));
    const mine = rig.fake.addContainer({ name: 'claudepilot-ev-a', labels: labels('ev-a') });
    const other = rig.fake.addContainer({ name: 'claudepilot-ev-b', labels: { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'ev-b', 'claudepilot.portal': 'another-portal' } });
    const bare = rig.fake.addContainer({ name: 'bare', labels: {} });
    for (const c of [mine, other, bare]) {
      rig.fake.emit('start', c);
      rig.fake.emit('die', c);
    }
    await new Promise((r) => setTimeout(r, 150));
    req.destroy();
    assert.deepEqual(got.map((l) => (JSON.parse(l) as { Actor: { Attributes: { name: string } }; Action: string }).Actor.Attributes.name + ':' + (JSON.parse(l) as { Action: string }).Action), ['claudepilot-ev-a:start']);
    const asked = JSON.parse(new URL(rig.fake.seen('GET', /^\/events/).at(-1)!.url, 'http://x').searchParams.get('filters')!) as { type: string[]; label: string[]; event: string[] };
    assert.deepEqual(asked.type, ['container']);
    assert.deepEqual(asked.label, ['claudepilot.managed=true', `claudepilot.portal=${PORTAL_ID}`]);
    assert.deepEqual(asked.event, ['start']);
  });
});

describe('framing and smuggling', () => {
  const sawNothingOf = (n: number, pattern: RegExp) => assert.equal(rig.fake.requests.slice(n).filter((r) => pattern.test(r.url) || pattern.test(r.method)).length, 0, rig.fake.requests.slice(n).map((r) => `${r.method} ${r.url}`).join(', '));
  const statusLines = (text: string) => [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]);

  it('refuses a request with both Content-Length and Transfer-Encoding, or two Content-Lengths', async () => {
    const n = rig.fake.requests.length;
    const body = JSON.stringify(goodCreate());
    const both = await rig.raw(`POST /containers/create?name=${NAME} HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`);
    assert.match(both, /HTTP\/1\.1 4\d\d/);
    const twice = await rig.raw(`POST /containers/create?name=${NAME} HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    assert.match(twice, /HTTP\/1\.1 4\d\d/);
    sawNothingOf(n, /create/);
    assert.ok((rig.service.report!().denied ?? []).some((d) => d.rule === 'body' && d.count >= 2));
  });

  it('refuses an absolute-form target, //, ., .., a backslash, %-encoding, a NUL and non-ASCII in the path', async () => {
    const n = rig.fake.requests.length;
    for (const target of ['http://evil/containers/json', '//containers/json', '/containers//json', '/./info', '/containers/../info', '/v1.46//info', '/containers%2Fjson', '/containers/json%00', '/%2e%2e/info', '/info\\x', '/café', '/containers/json/', '*']) {
      const out = await rig.raw(`GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`, { quietMs: 80 });
      assert.match(out, /HTTP\/1\.1 (403|400)/, target);
    }
    sawNothingOf(n, /.*/);
    for (const t of ['/a//b', '/a/./b', '/a/../b', '/a%2fb', '/a\\b', 'relative', '//x']) assert.ok('rule' in normalizeTarget(t), t);
    assert.ok(!('rule' in normalizeTarget('/v1.46/containers/json?all=1')));
  });

  it('treats a second request hidden in a body as body bytes, and checks pipelined requests one by one', async () => {
    const c = rig.fake.addContainer({ name: 'claudepilot-smug', labels: labels('smug') });
    const n = rig.fake.requests.length;
    const hidden = `DELETE /containers/${c.name}?force=1 HTTP/1.1\r\nHost: x\r\n\r\n`;
    const out = await rig.raw(`PUT /containers/${c.name}/archive?path=/ HTTP/1.1\r\nHost: x\r\nContent-Length: ${hidden.length}\r\n\r\n${hidden}GET /info HTTP/1.1\r\nHost: x\r\n\r\nGET /networks HTTP/1.1\r\nHost: x\r\n\r\n`, { quietMs: 200 });
    assert.deepEqual(statusLines(out), ['200', '200', '403'], out);
    assert.ok(rig.fake.containers.has(c.id), 'the hidden DELETE was never a request');
    const seen = rig.fake.requests.slice(n).map((r) => `${r.method} ${r.url.split('?')[0]}`);
    assert.ok(!seen.some((s) => s.startsWith('DELETE')), seen.join(', '));
    assert.ok(seen.some((s) => s.startsWith('PUT /containers/') && s.endsWith('/archive')));
    assert.ok(!seen.includes('GET /networks'));
  });

  it('refuses a header block over 16 KiB and a JSON body over 1 MiB', async () => {
    const n = rig.fake.requests.length;
    const big = await rig.raw(`GET /info HTTP/1.1\r\nHost: x\r\nX-Pad: ${'a'.repeat(17 * 1024)}\r\n\r\n`, { quietMs: 80 });
    assert.match(big, /HTTP\/1\.1 431/);
    const huge = JSON.stringify(goodCreate({ Env: [`A=${'x'.repeat(1_100_000)}`] }));
    denied(await rig.request('POST', `/containers/create?name=${NAME}`, { rawBody: huge }), 'body');
    sawNothingOf(n, /create|info/);
  });

  it('refuses a take-over of the connection anywhere but exec start (rule upgrade)', async () => {
    const c = rig.fake.addContainer({ name: 'claudepilot-up', labels: labels('up') });
    const n = rig.fake.requests.length;
    for (const target of [`/containers/${c.name}/exec`, '/containers/json', `/containers/${c.name}/attach?stream=1`, '/info', `/containers/${c.name}/start`]) {
      const out = await rig.raw(`POST ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n`, { quietMs: 80 });
      assert.match(out, /HTTP\/1\.1 403/, target);
      assert.match(out, /\(upgrade\)/, target);
    }
    const ws = await rig.raw('GET /containers/json HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n', { quietMs: 80 });
    assert.match(ws, /\(upgrade\)/);
    sawNothingOf(n, /.*/);
  });

  it('exec start may upgrade, only for an exec this agent made, and then the stream is raw both ways', async () => {
    rig.fake.addContainer({ name: 'claudepilot-hj', labels: labels('hj') });
    rig.fake.onExec = (_cmd, { stdin }) => ({ stdout: `got:${stdin.toString()}`, exitCode: 0 });
    const made = await rig.request('POST', '/containers/claudepilot-hj/exec', { body: { Cmd: ['cat'], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false } });
    const id = (made.json() as { Id: string }).Id;
    const body = JSON.stringify({ hijack: true, stdin: true });
    const out = await rig.raw(`POST /exec/${id}/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}typed`, { quietMs: 120, keepOpen: true });
    assert.match(out, /^HTTP\/1\.1 101 /);
    // stdin was not closed by the raw helper, so the exec is still waiting; ending it is the client's half-close.
    const unknown = await rig.raw(`POST /exec/${'e'.repeat(64)}/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 2\r\n\r\n{}`, { quietMs: 80 });
    assert.match(unknown, /HTTP\/1\.1 403/);
    assert.match(unknown, /\(unmanaged\)/);
    const badBody = await rig.raw(`POST /exec/${id}/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 14\r\n\r\n{"Privileged":`, { quietMs: 80 });
    assert.match(badBody, /HTTP\/1\.1 403/);
  });
});

describe('fuzzed create bodies never reach the daemon unless they are valid', () => {
  it('mutates a valid body 400 times: whatever is let through satisfies the schema, and the rest is refused', async () => {
    const FORBIDDEN_HOST = ['Privileged', 'PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'Binds', 'VolumesFrom', 'Tmpfs', 'Devices', 'DeviceCgroupRules', 'DeviceRequests', 'CapAdd', 'Sysctls', 'Runtime', 'StorageOpt', 'MaskedPaths', 'ReadonlyPaths', 'PortBindings', 'PublishAllPorts', 'Links'];
    const ALLOWED_HOST = new Set(['RestartPolicy', 'Mounts', 'NanoCpus', 'Memory', 'MemorySwap', 'CpuShares', 'PidsLimit', 'ShmSize', 'AutoRemove', 'Init', 'CapDrop', 'NetworkMode', 'SecurityOpt']);
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const junk: unknown[] = [true, false, null, 0, -1, 1e18, '', 'host', '/', ['x'], [{ a: 1 }], { a: 1 }, 'private', ['SYS_ADMIN'], { '1': 2 }, '../..', 'claudepilot-x-home'];
    const fields = [...FORBIDDEN_HOST, 'RestartPolicy', 'Mounts', 'NanoCpus', 'Memory', 'NetworkMode', 'CapDrop', 'Init', 'Whatever', '__proto__', 'constructor'];
    const before = rig.fake.requests.length;
    let allowed = 0;
    for (let i = 0; i < 400; i++) {
      const body = goodCreate({}, `fz${i}`);
      const host = body.HostConfig as Record<string, unknown>;
      for (let k = 0; k < 1 + rnd(3); k++) host[fields[rnd(fields.length)]!] = junk[rnd(junk.length)];
      if (rnd(4) === 0) (body as Record<string, unknown>)[['Image', 'Labels', 'User', 'Env', 'Cmd', 'Tty', 'Hostname'][rnd(7)]!] = junk[rnd(junk.length)];
      const name = `claudepilot-fz${i}`;
      (body as { Labels?: unknown }).Labels = typeof body.Labels === 'object' && body.Labels !== null && !Array.isArray(body.Labels) ? { ...(body.Labels as object), 'claudepilot.workspace': `fz${i}` } : body.Labels;
      const answer = await rig.request('POST', `/containers/create?name=${name}`, { body });
      if (answer.status === 201) allowed++;
      else assert.ok([403, 409].includes(answer.status), `${answer.status} ${answer.text}`);
    }
    const creates = rig.fake.requests.slice(before).filter((r) => r.method === 'POST' && r.url.startsWith('/containers/create'));
    assert.equal(creates.length, allowed, 'every create that reached the daemon was one the policy allowed');
    for (const r of creates) {
      const sent = JSON.parse(r.body.toString()) as { Image: string; HostConfig?: Record<string, unknown>; Labels: Record<string, string> };
      assert.equal(sent.Image, IMAGE);
      assert.equal(sent.Labels['claudepilot.managed'], 'true');
      for (const key of Object.keys(sent.HostConfig ?? {})) assert.ok(ALLOWED_HOST.has(key), `the daemon was sent HostConfig.${key}`);
      const h = sent.HostConfig ?? {};
      assert.ok(!('Privileged' in h) && !('Binds' in h) && !('CapAdd' in h) && !('PidMode' in h) && !('Devices' in h));
      for (const m of (h.Mounts as { Type: string; Source: string }[] | undefined) ?? []) assert.ok(m.Type === 'volume' && /^claudepilot-.*-home$/.test(m.Source));
      if (h.NetworkMode !== undefined) assert.ok(['', 'default', 'bridge'].includes(h.NetworkMode as string));
    }
    assert.ok(allowed > 0 && allowed < 400, `the fuzz is neither all refused nor all allowed (${allowed} allowed)`);
  });
});

describe('the rule table and its helpers', () => {
  it('classifies routes, and says method when only the method is wrong', () => {
    assert.deepEqual(classify('GET', '/containers/json'), { kind: 'list', json: false });
    assert.equal((classify('POST', '/containers/abc/start') as { verb: string }).verb, 'start');
    assert.deepEqual(classify('GET', '/containers/abc/start'), { rule: 'method', message: 'GET is not allowed on this path.' });
    assert.equal((classify('POST', '/build') as { rule: string }).rule, 'build');
    assert.equal((classify('GET', '/networks') as { rule: string }).rule, 'path');
  });

  it('matches image references the way Docker names them', () => {
    assert.equal(normalizeImageRef('claudepilot-workspace'), 'claudepilot-workspace:latest');
    assert.equal(normalizeImageRef('docker.io/library/node'), 'node:latest');
    assert.equal(normalizeImageRef('ghcr.io/a/b@sha256:abc'), 'ghcr.io/a/b@sha256:abc');
    assert.equal(normalizeImageRef('localhost:5000/x'), 'localhost:5000/x:latest');
    const allow = new ImageAllow(['ghcr.io/a/b:latest', 'node']);
    assert.ok(allow.has('ghcr.io/a/b') && allow.has('docker.io/library/node:latest') && !allow.has('ghcr.io/a/b:v2') && !allow.has('ghcr.io/a/bb'));
    assert.equal(pullRef('ghcr.io/a/b', 'latest'), 'ghcr.io/a/b:latest');
    assert.equal(pullRef('ghcr.io/a/b', 'sha256:abc'), 'ghcr.io/a/b@sha256:abc');
    assert.equal(pullRef('bad ref', null), null);
  });
});
