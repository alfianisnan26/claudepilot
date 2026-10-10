import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import Docker from 'dockerode';
import { config } from '../config.js';
import { DockerRuntime } from '../workspaces/docker.js';
import { LABEL } from '../workspaces/runtime.js';

/**
 * Runs against the real Docker-in-Docker daemon (CLAUDEPILOT_DOCKER_TESTS=1). Uses a throwaway
 * container from the workspace image; nothing else is touched.
 */
const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const socket = '/var/run/docker.sock';
const docker = new Docker({ socketPath: socket });
const runtime = new DockerRuntime({ id: 'docker', label: 'Docker', socket }, config.workspaces.dockerImage, config.workspaces.imageContext);
const d = runtime.delivery;
const name = `it-${randomBytes(3).toString('hex')}`;

before(async () => {
  if (!enabled) return;
  const c = await docker.createContainer({
    name: `claudepilot-${name}`,
    Image: config.workspaces.dockerImage,
    User: 'node',
    Labels: { [LABEL.managed]: 'true', [LABEL.name]: name, 'claudepilot.test': 'true' },
    HostConfig: { AutoRemove: false },
  });
  await c.start();
});
after(async () => {
  if (!enabled) return;
  await docker.getContainer(`claudepilot-${name}`).remove({ force: true }).catch(() => undefined);
});

const opts = { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 to run against Docker' };

test('put writes files and folders with owner and mode; read and run see them', opts, async () => {
  await d.put(name, [
    { path: '/etc/claudepilot', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
    { path: '/etc/claudepilot/account', type: 'directory', mode: 0o750, uid: 0, gid: 1000 },
    { path: '/etc/claudepilot/account/a.key', type: 'file', content: 'k1', mode: 0o440, uid: 0, gid: 1000 },
  ]);
  const ls = await d.run(name, "stat -c '%a %U:%G %n' /etc/claudepilot/account /etc/claudepilot/account/a.key");
  assert.equal(ls.code, 0, ls.stderr);
  assert.match(ls.stdout, /^750 root:node \/etc\/claudepilot\/account$/m);
  assert.match(ls.stdout, /^440 root:node \/etc\/claudepilot\/account\/a\.key$/m);
  assert.equal(await d.read(name, '/etc/claudepilot/account/a.key'), 'k1');
  assert.equal(await d.read(name, '/etc/claudepilot/missing'), null);
  const asNode = await d.run(name, 'cat /etc/claudepilot/account/a.key', { user: 'node' });
  assert.equal(asNode.stdout, 'k1', 'the workspace user can read it through the group');
});

test('run passes stdin and reports the exit code', opts, async () => {
  const r = await d.run(name, 'cat; echo; exit 3', { stdin: 'from stdin' });
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), 'from stdin');
});

test('state tells running from stopped, and read works on a stopped container', opts, async () => {
  assert.deepEqual(await d.state(name), { exists: true, running: true });
  assert.deepEqual(await d.state('no-such-workspace'), { exists: false, running: false });
  await docker.getContainer(`claudepilot-${name}`).stop({ t: 1 });
  assert.deepEqual(await d.state(name), { exists: true, running: false });
  assert.equal(await d.read(name, '/etc/claudepilot/account/a.key'), 'k1');
  await d.put(name, [{ path: '/etc/claudepilot/account/b.key', type: 'file', content: 'k2', mode: 0o440, uid: 0, gid: 1000 }]);
  await docker.getContainer(`claudepilot-${name}`).start();
  assert.equal(await d.read(name, '/etc/claudepilot/account/b.key'), 'k2', 'a write into a container stopped after running persists');
});

test('start events reach the watcher', opts, async () => {
  const seen: string[] = [];
  const stop = d.watchStarts((n) => seen.push(n));
  await new Promise((r) => setTimeout(r, 500));
  const c = docker.getContainer(`claudepilot-${name}`);
  await c.stop({ t: 1 });
  await c.start();
  for (let i = 0; i < 50 && !seen.includes(name); i++) await new Promise((r) => setTimeout(r, 100));
  stop();
  assert.ok(seen.includes(name));
});

/**
 * Foundation PRD §12 gate "Docker atomicity": a reader polling the file must never see it missing
 * or partial. Compares an in-place archive overwrite with a hidden temp file plus rename.
 */
test('temp file + rename is atomic for readers; reports what an in-place overwrite does', opts, async () => {
  const target = '/etc/claude-code/managed-settings.d/40-it.json';
  const big = (n: number) => JSON.stringify({ env: { CLAUDEPILOT_IT: String(n).padStart(4, '0'), PAD: 'x'.repeat(60_000) } });
  await d.put(name, [
    { path: '/etc/claude-code', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
    { path: '/etc/claude-code/managed-settings.d', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
    { path: target, type: 'file', content: big(0), mode: 0o644, uid: 0, gid: 0 },
  ]);
  // A reader loop inside the container: counts reads that found the file missing or not whole.
  const reader = `
    end=$(( $(date +%s) + 12 )); bad=0; reads=0
    while [ "$(date +%s)" -lt "$end" ]; do
      if c=$(cat ${target} 2>/dev/null); then
        case "$c" in *'"}}') ;; *) bad=$((bad+1));; esac
      else bad=$((bad+1)); fi
      reads=$((reads+1))
    done
    echo "$reads $bad"`;

  const measure = async (write: (i: number) => Promise<void>) => {
    const loop = d.run(name, reader, { timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 1; i <= 40; i++) await write(i);
    const r = await loop;
    const [reads, bad] = r.stdout.trim().split(' ').map(Number) as [number, number];
    return { reads, bad };
  };

  const inPlace = await measure((i) => d.put(name, [{ path: target, type: 'file', content: big(i), mode: 0o644, uid: 0, gid: 0 }]));
  const renamed = await measure(async (i) => {
    await d.put(name, [{ path: '/etc/claude-code/managed-settings.d/.40-it.json.tmp', type: 'file', content: big(i), mode: 0o644, uid: 0, gid: 0 }]);
    const r = await d.run(name, `mv -f /etc/claude-code/managed-settings.d/.40-it.json.tmp ${target}`);
    assert.equal(r.code, 0, r.stderr);
  });
  console.log(`  in-place archive overwrite: ${inPlace.bad} bad of ${inPlace.reads} reads; temp + rename: ${renamed.bad} bad of ${renamed.reads} reads`);
  assert.ok(renamed.reads > 100, 'the reader ran');
  assert.equal(renamed.bad, 0, 'temp + rename never shows a missing or partial file');
});
