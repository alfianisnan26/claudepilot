// The Docker runtime's part of Claude Code version pinning (docs/prd/claude-version-pinning.md FR2, FR3, FR7, FR11), against an in-memory Docker: the
// image per exact version is built with the build argument and refused when its label disagrees, a workspace's container carries the labels, a recreate
// keeps the home volume and puts the old container back when the new one will not start, and a throwaway container can never reach a workspace.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type Docker from 'dockerode';
import { DockerRuntime, repoOf } from './docker.js';
import { WorkspaceIdentities } from './identity.js';
import { LABEL } from './runtime.js';

interface Img {
  id: string;
  labels: Record<string, string>;
  tags: string[];
}
interface Ctr {
  id: string;
  name: string;
  image: string;
  imageId: string;
  labels: Record<string, string>;
  running: boolean;
  volume: string | null;
  spec: Record<string, any>;
  env: string[];
}

/** Just enough of a Docker daemon: images with labels, containers with state, the calls the runtime makes. */
function fakeDocker() {
  const images = new Map<string, Img>();
  const containers = new Map<string, Ctr>();
  const calls: { op: string; arg?: any }[] = [];
  let failNextCreate = false;
  let failStart = false;
  let n = 0;
  const notFound = () => Object.assign(new Error('no such thing'), { statusCode: 404 });
  const imageByRef = (ref: string) => [...images.values()].find((i) => i.id === ref || i.tags.includes(ref));
  const ctr = (name: string) => containers.get(name.replace(/^\//, ''));

  const handle = (c: Ctr) => ({
    inspect: async () => ({
      Id: c.id,
      Image: c.imageId,
      Config: { Image: c.image, Labels: c.labels, Env: c.env },
      Mounts: c.volume ? [{ Type: 'volume', Name: c.volume, Destination: '/home/node' }] : [],
      State: { Running: c.running },
      NetworkSettings: { Networks: { bridge: {} } },
    }),
    stop: async () => (calls.push({ op: 'stop', arg: c.name }), (c.running = false)),
    start: async () => {
      calls.push({ op: 'start', arg: c.name });
      if (failStart && !c.name.includes('canary')) throw Object.assign(new Error('driver failed'), { json: { message: 'driver failed programming external connectivity' } });
      c.running = true;
    },
    remove: async (o?: any) => (calls.push({ op: 'removeContainer', arg: { name: c.name, ...o } }), containers.delete(c.name)),
    exec: async () => { throw new Error('not in this fake'); },
    putArchive: async () => undefined,
    getArchive: async () => { throw notFound(); },
  });

  const docker = {
    modem: { followProgress: (_s: unknown, done: (e: Error | null, ev: unknown[]) => void) => done(null, []), demuxStream: () => undefined },
    getImage: (ref: string) => ({
      inspect: async () => {
        const i = imageByRef(ref);
        if (!i) throw notFound();
        return { Id: i.id, Created: '2026-10-12T00:00:00Z', Size: 123, Config: { Labels: i.labels } };
      },
      remove: async () => {
        const i = imageByRef(ref);
        if (!i) throw notFound();
        if ([...containers.values()].some((c) => c.imageId === i.id)) throw Object.assign(new Error('conflict'), { statusCode: 409 });
        calls.push({ op: 'removeImage', arg: ref });
        i.tags = i.tags.filter((t) => t !== ref);
        if (!i.tags.length) images.delete(i.id);
      },
      tag: async (o: { repo: string; tag: string }) => (calls.push({ op: 'tag', arg: o }), imageByRef(ref)!.tags.push(`${o.repo}:${o.tag}`)),
    }),
    listImages: async () => [...images.values()].map((i) => ({ Id: i.id, RepoTags: i.tags, Labels: i.labels, Created: 1_790_000_000, Size: 456 })),
    buildImage: async (ctx: unknown, o: { t: string; buildargs?: Record<string, string> }) => {
      calls.push({ op: 'build', arg: o });
      const v = o.buildargs?.CLAUDE_CODE_VERSION ?? '2.1.296';
      images.set(`sha256:img${++n}`, { id: `sha256:img${n}`, labels: { 'claudepilot.claude-version': mismatch ? '9.9.9' : v }, tags: [o.t] });
      return {};
    },
    pull: async () => ({}),
    listContainers: async (o: { filters?: { name?: string[]; label?: string[] } }) => {
      const labelFilter = o.filters?.label?.[0];
      const nameFilter = o.filters?.name?.[0];
      return [...containers.values()]
        .filter((c) => (labelFilter ? (labelFilter.includes('=') ? c.labels[labelFilter.split('=')[0]!] === labelFilter.split('=')[1] : labelFilter in c.labels) : true))
        .filter((c) => (nameFilter ? new RegExp(nameFilter.replace(/^\^\//, '^')).test(c.name) : true))
        .map((c) => ({ Id: c.id, Names: [`/${c.name}`], Image: c.image, Labels: c.labels, State: c.running ? 'running' : 'exited', Status: c.running ? 'Up' : 'Exited', Created: 1_790_000_000 }));
    },
    getContainer: (name: string) => {
      const c = ctr(name);
      if (!c) return { ...handle({ id: '', name } as Ctr), inspect: async () => { throw notFound(); }, remove: async () => { throw notFound(); }, stop: async () => { throw notFound(); }, start: async () => { throw notFound(); } };
      return handle(c);
    },
    createContainer: async (spec: any) => {
      calls.push({ op: 'createContainer', arg: spec });
      if (failNextCreate && !String(spec.name).includes('canary')) {
        failNextCreate = false;
        throw Object.assign(new Error('no space left'), { json: { message: 'no space left on device' } });
      }
      const i = imageByRef(spec.Image);
      if (!i) throw notFound();
      const mount = (spec.HostConfig?.Mounts ?? [])[0];
      const c: Ctr = { id: `c${++n}`, name: spec.name, image: spec.Image, imageId: i.id, labels: { ...i.labels, ...spec.Labels }, running: false, volume: mount?.Source ?? null, spec, env: spec.Env ?? [] };
      containers.set(c.name, c);
      return handle(c);
    },
    getNetwork: (name: string) => ({ disconnect: async (o: unknown) => void calls.push({ op: 'disconnect', arg: { name, ...(o as object) } }) }),
    getVolume: (name: string) => ({ remove: async () => void calls.push({ op: 'removeVolume', arg: name }) }),
  } as unknown as Docker;

  let mismatch = false;
  return {
    docker,
    images,
    containers,
    calls,
    setMismatch: (v: boolean) => (mismatch = v),
    failNextCreate: () => (failNextCreate = true),
    failStart: (v: boolean) => (failStart = v),
    addImage: (tag: string, version: string | null) => {
      const id = `sha256:seed${++n}`;
      images.set(id, { id, labels: version ? { 'claudepilot.claude-version': version } : {}, tags: [tag] });
      return id;
    },
  };
}

const REPO = 'claudepilot-workspace-t';
const PORTAL = 'portal-1';
let d: ReturnType<typeof fakeDocker>;
let rt: DockerRuntime;
beforeEach(() => {
  d = fakeDocker();
  rt = new DockerRuntime({ id: 'docker', label: 'Docker', socket: '/nonexistent.sock' }, `${REPO}:cc-2.1.296`, '/ctx', () => PORTAL, d.docker, { canaryPrefix: 'vc-canary-' });
});

test('repoOf: the tag comes off, a registry port does not', () => {
  assert.equal(repoOf('claudepilot-workspace:cc-2.1.296'), 'claudepilot-workspace');
  assert.equal(repoOf('registry:5000/team/ws:cc-2.1.296'), 'registry:5000/team/ws');
  assert.equal(repoOf('registry:5000/team/ws'), 'registry:5000/team/ws');
  assert.equal(repoOf('ws'), 'ws');
});

test('images.ensure builds the tag of an exact version with the build argument; anything else is refused before Docker is asked', async () => {
  const ref = await rt.images.ensure('2.1.300', () => undefined);
  assert.equal(ref, `${REPO}:cc-2.1.300`);
  const build = d.calls.find((c) => c.op === 'build')!.arg;
  assert.deepEqual([build.t, build.buildargs], [`${REPO}:cc-2.1.300`, { CLAUDE_CODE_VERSION: '2.1.300' }]);
  d.calls.length = 0;
  assert.equal(await rt.images.ensure('2.1.300', () => undefined), ref);
  assert.deepEqual(d.calls, [], 'an image that exists is not built again');
  for (const bad of ['latest', '^2.1.300', '2.1', '2.1.300; rm -rf /', '../x']) {
    await assert.rejects(() => rt.images.ensure(bad, () => undefined), (e) => isAppError(e) && e.code === 'VALIDATION_FAILED', bad);
  }
  assert.deepEqual(d.calls, []);
});

test('a built image whose label disagrees with its tag is refused: the tag cannot lie', async () => {
  d.setMismatch(true);
  await assert.rejects(() => rt.images.ensure('2.1.300', () => undefined), /says it has Claude Code 9\.9\.9, not 2\.1\.300/);
});

test('create: the version’s image, the labels the runtime is the record by, limits, and a named home volume', async () => {
  await rt.create({ name: 'api', cpus: 2, memoryMb: 2048, claudeVersion: '2.1.300' }, () => undefined);
  const c = d.containers.get('claudepilot-api')!;
  assert.equal(c.image, `${REPO}:cc-2.1.300`);
  assert.deepEqual(
    [c.labels[LABEL.managed], c.labels[LABEL.name], c.labels[LABEL.portal], c.labels['claudepilot.claude-version'], c.labels['claudepilot.image'], c.labels['claudepilot.cpus'], c.labels['claudepilot.memory-mb']],
    ['true', 'api', PORTAL, '2.1.300', `${REPO}:cc-2.1.300`, '2', '2048'],
  );
  assert.equal(c.volume, 'claudepilot-api-home');
  assert.equal(c.spec.HostConfig.NanoCpus, 2e9);
  const listed = (await rt.list())[0]!;
  assert.deepEqual([listed.name, listed.claude, listed.image], ['api', { pinned: '2.1.300', running: null, flags: [] }, `${REPO}:cc-2.1.300`]);
  // The default pin when no version is asked for: the configured image (and its build argument when it has to be built).
  await rt.create({ name: 'web' }, () => undefined);
  assert.equal(d.containers.get('claudepilot-web')!.image, `${REPO}:cc-2.1.296`);
  assert.equal(d.containers.get('claudepilot-web')!.labels['claudepilot.claude-version'], '2.1.296');
  await assert.rejects(() => rt.create({ name: 'bad', claudeVersion: 'latest' }, () => undefined), /exact version/);
  assert.equal(d.containers.has('claudepilot-bad'), false);
});

test('recreate keeps the home volume, the labels and limits, and the new container is made from the new image', async () => {
  await rt.create({ name: 'api', cpus: 2, memoryMb: 2048, claudeVersion: '2.1.296' }, () => undefined);
  const start = d.containers.get('claudepilot-api')!;
  start.running = true;
  const newer = await rt.images.ensure('2.1.300', () => undefined);
  d.calls.length = 0;
  const steps: string[] = [];
  const res = await rt.recreate('api', newer, (s) => steps.push(s));
  assert.deepEqual(res, { from: `${REPO}:cc-2.1.296`, to: newer });
  const now = d.containers.get('claudepilot-api')!;
  assert.notEqual(now.id, start.id, 'a new container');
  assert.deepEqual([now.image, now.running, now.volume], [newer, true, 'claudepilot-api-home']);
  assert.deepEqual([now.labels['claudepilot.claude-version'], now.labels['claudepilot.image'], now.labels[LABEL.portal], now.labels['claudepilot.cpus']], ['2.1.300', newer, PORTAL, '2']);
  assert.equal(now.spec.HostConfig.Memory, 2048 * 1024 * 1024);
  const ops = d.calls.map((c) => c.op);
  assert.deepEqual(ops.filter((o) => ['stop', 'removeContainer', 'createContainer', 'start'].includes(o)), ['stop', 'removeContainer', 'createContainer', 'start']);
  assert.equal(d.calls.find((c) => c.op === 'removeContainer')!.arg.v, false, 'the volume is never removed with the container');
  assert.ok(!d.calls.some((c) => c.op === 'removeVolume'), 'no volume call at all');
  assert.deepEqual(steps, ['Stopping', 'Replacing the container']);
  // A stopped workspace is replaced and left stopped.
  now.running = false;
  const back = await rt.recreate('api', `${REPO}:cc-2.1.296`, () => undefined);
  assert.equal(back.to, `${REPO}:cc-2.1.296`);
  assert.equal(d.containers.get('claudepilot-api')!.running, false);
});

test('recreate: when the new container cannot start, the old one is put back from the image it ran, and the home volume is untouched', async () => {
  await rt.create({ name: 'api', claudeVersion: '2.1.296' }, () => undefined);
  const old = d.containers.get('claudepilot-api')!;
  old.running = true;
  const oldImageId = old.imageId;
  const newer = await rt.images.ensure('2.1.300', () => undefined);
  d.failNextCreate();
  await assert.rejects(
    () => rt.recreate('api', newer, () => undefined),
    (e) => isAppError(e) && /Could not start .*no space left on device.*back on/.test(e.message),
  );
  const now = d.containers.get('claudepilot-api')!;
  assert.deepEqual([now.imageId, now.running, now.volume, now.labels['claudepilot.claude-version']], [oldImageId, true, 'claudepilot-api-home', '2.1.296'], 'back on the old image, by id');
  assert.equal(now.labels['claudepilot.image'], `${REPO}:cc-2.1.296`, 'and labelled with the tag it had');
  // A start that fails after the container was made is cleaned up the same way.
  d.failStart(true);
  await assert.rejects(() => rt.recreate('api', newer, () => undefined), /back on|put back/);
  d.failStart(false);
});

test('recreate refuses what it cannot do without risk: another portal’s workspace, a home that is not its own volume, a missing image, a stranger', async () => {
  await rt.create({ name: 'api', claudeVersion: '2.1.296' }, () => undefined);
  const newer = await rt.images.ensure('2.1.300', () => undefined);
  const c = d.containers.get('claudepilot-api')!;
  await assert.rejects(() => rt.recreate('api', `${REPO}:cc-2.9.9`, () => undefined), /not on this target yet/);
  c.volume = 'someone-elses-volume';
  await assert.rejects(() => rt.recreate('api', newer, () => undefined), /not a volume of its own/);
  c.volume = 'claudepilot-api-home';
  c.labels[LABEL.portal] = 'another-portal';
  await assert.rejects(() => rt.recreate('api', newer, () => undefined), /Another portal created this workspace/);
  c.labels[LABEL.portal] = PORTAL;
  delete c.labels[LABEL.managed];
  await assert.rejects(() => rt.recreate('api', newer, () => undefined), /not one of this portal’s workspaces/);
  assert.ok(!d.calls.some((x) => x.op === 'removeContainer'), 'nothing was removed by any refusal');
  await assert.rejects(() => rt.recreate('../escape', newer, () => undefined), (e) => isAppError(e) || /plain|name/i.test((e as Error).message));
});

test('imageOf reads the container: the tag it was made from, its version label and the image id', async () => {
  const id = d.addImage('legacy:latest', null);
  await d.docker.createContainer({ name: 'claudepilot-old', Image: id, Labels: { [LABEL.managed]: 'true', [LABEL.name]: 'old' }, HostConfig: { Mounts: [{ Type: 'volume', Source: 'claudepilot-old-home', Target: '/home/node' }] } });
  assert.deepEqual(await rt.imageOf('old'), { ref: id, version: null, id });
  assert.equal(await rt.imageOf('nobody'), null);
  await rt.create({ name: 'api', claudeVersion: '2.1.296' }, () => undefined);
  const info = (await rt.imageOf('api'))!;
  assert.deepEqual([info.ref, info.version], [`${REPO}:cc-2.1.296`, '2.1.296']);
});

test('images: listed for this repository only, removal is refused while a container uses the image', async () => {
  d.addImage('other-repo:cc-2.1.1', '2.1.1');
  await rt.create({ name: 'api', claudeVersion: '2.1.296' }, () => undefined);
  await rt.images.ensure('2.1.300', () => undefined);
  const listed = await rt.images.list();
  assert.deepEqual(listed.map((i) => [i.ref, i.version]).sort(), [[`${REPO}:cc-2.1.296`, '2.1.296'], [`${REPO}:cc-2.1.300`, '2.1.300']]);
  await assert.rejects(() => rt.images.remove(`${REPO}:cc-2.1.296`), (e) => isAppError(e) && e.code === 'CONFLICT' && /in use/.test(e.message));
  await rt.images.remove(`${REPO}:cc-2.1.300`);
  assert.equal(await rt.images.inspect(`${REPO}:cc-2.1.300`), null);
  await rt.images.remove(`${REPO}:cc-2.1.300`);
});

test('a throwaway container is not a workspace: no managed label, no network by default, no variables but TERM, and it cannot be used to reach a workspace', async () => {
  await rt.create({ name: 'api', claudeVersion: '2.1.296' }, () => undefined);
  const img = `${REPO}:cc-2.1.296`;
  const t = await rt.throwaway.start({ image: img, network: 'none', cpus: 2, memoryMb: 2048 });
  assert.match(t.name, /^vc-canary-[0-9a-f]{8}$/);
  const made = d.containers.get(t.name)!;
  assert.ok(!(LABEL.managed in made.labels) && !(LABEL.name in made.labels), 'never listed as a workspace');
  assert.equal(made.labels['claudepilot.canary'], PORTAL);
  assert.deepEqual(made.env, ['TERM=xterm-256color'], 'nothing from the portal’s own environment');
  assert.equal(made.spec.HostConfig.NetworkMode, 'none');
  assert.equal(made.spec.HostConfig.RestartPolicy.Name, 'no');
  assert.deepEqual((await rt.list()).map((w) => w.name), ['api'], 'the workspace list does not show it');
  // It can only be reached by names it made; a workspace's name is NOT_FOUND through it.
  for (const call of [
    () => rt.throwaway.run('claudepilot-api', 'id'),
    () => rt.throwaway.put('claudepilot-api', []),
    () => rt.throwaway.read('claudepilot-api', '/etc/passwd'),
    () => rt.throwaway.exec('claudepilot-api', ['id']),
    () => rt.throwaway.remove('claudepilot-api'),
    () => rt.throwaway.isolate('claudepilot-api'),
    () => rt.throwaway.run('vc-canary-../x', 'id'),
  ])
    await assert.rejects(call, (e) => isAppError(e) && e.code === 'NOT_FOUND');
  assert.ok(d.containers.has('claudepilot-api'), 'the workspace is untouched');
  assert.deepEqual((await rt.throwaway.leftovers()).map((l) => l.name), [t.name]);
  await rt.throwaway.isolate(t.name);
  assert.ok(d.calls.some((c) => c.op === 'disconnect'));
  await rt.throwaway.remove(t.name);
  assert.equal(d.containers.has(t.name), false);
  assert.deepEqual(await rt.throwaway.leftovers(), []);
  // Another portal's leftovers are none of this portal's business.
  d.containers.set('vc-canary-ffffffff', { id: 'x', name: 'vc-canary-ffffffff', image: img, imageId: 'x', labels: { 'claudepilot.canary': 'another-portal' }, running: true, volume: null, spec: {}, env: [] });
  assert.deepEqual(await rt.throwaway.leftovers(), []);
});

test('an optional moving alias follows the default pin’s image after it is built; off by default', async () => {
  const aliased = new DockerRuntime({ id: 'docker', label: 'Docker', socket: '/nonexistent.sock' }, `${REPO}:cc-2.1.296`, '/ctx', () => PORTAL, d.docker, { alias: 'latest' });
  await aliased.create({ name: 'a' }, () => undefined);
  assert.ok(d.calls.some((c) => c.op === 'tag' && c.arg.tag === 'latest' && c.arg.repo === REPO));
  const plain = fakeDocker();
  const rt2 = new DockerRuntime({ id: 'docker', label: 'Docker', socket: '/nonexistent.sock' }, `${REPO}:cc-2.1.296`, '/ctx', () => PORTAL, plain.docker);
  await rt2.create({ name: 'b' }, () => undefined);
  assert.ok(!plain.calls.some((c) => c.op === 'tag'));
});

test('T-42: a workspace’s container and home volume follow its stored runtime name, never its name; one made before keeps its own', async () => {
  const ids = WorkspaceIdentities.memory();
  rt.useNames(ids);
  // Made before T-42 (no record yet): named the old way, and recorded from what Docker says it is called.
  await rt.create({ name: 'old' }, () => undefined);
  assert.ok(d.containers.has('claudepilot-old'));
  const listed = (await rt.list()).find((w) => w.name === 'old')!;
  assert.equal(listed.runtimeName, 'claudepilot-old');
  ids.adopt('docker', 'old', listed.runtimeName);

  // A new one: its container and volume come from its id, its label and hostname are its name.
  const fresh = ids.allocate('docker', 'fresh');
  const rn = fresh.runtimeName!;
  assert.match(rn, /^ws-[0-9a-f]{12}$/);
  await rt.create({ name: 'fresh', runtimeName: rn }, () => undefined);
  const c = d.containers.get(rn)!;
  assert.deepEqual([c.labels[LABEL.name], c.volume, c.spec.Hostname], ['fresh', `${rn}-home`, 'fresh']);
  assert.ok(!d.containers.has('claudepilot-fresh'), 'nothing is named after the workspace');
  assert.equal((await rt.list()).find((w) => w.name === 'fresh')!.runtimeName, rn);

  d.calls.length = 0;
  await rt.stop('fresh');
  await rt.stop('old');
  assert.deepEqual(d.calls.filter((x) => x.op === 'stop').map((x) => x.arg), [rn, 'claudepilot-old'], 'calls by name reach the stored runtime name');

  // A recreate keeps the same container name and home volume; a remove takes exactly those.
  const newer = await rt.images.ensure('2.1.300', () => undefined);
  await rt.recreate('fresh', newer, () => undefined);
  assert.deepEqual([d.containers.get(rn)!.image, d.containers.get(rn)!.volume], [newer, `${rn}-home`]);
  d.calls.length = 0;
  await rt.remove('fresh');
  assert.ok(!d.containers.has(rn));
  assert.deepEqual(d.calls.filter((x) => x.op === 'removeVolume').map((x) => x.arg), [`${rn}-home`]);
  assert.ok(d.containers.has('claudepilot-old'), 'the other workspace is untouched');
});
