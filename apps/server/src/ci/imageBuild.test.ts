// scripts/image-build.sh (T-141): an image built by a kaniko Job in the cluster, against a fake kubectl that keeps Jobs and Secrets in a JSON
// file and plays the Job's two logs, and a fake registry (a local HTTP server: basic auth, a bearer challenge, manifest HEAD). Nothing here
// reaches a cluster or a real registry: the environment is built from scratch (no KUBECONFIG, the fakes first on PATH). The credential is made
// at runtime and checked never to reach the output, the log file, the manifest or a kubectl command line.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO, 'scripts/image-build.sh');
const TEMPLATE = join(REPO, 'deploy/k3s-build/image-build-job.yaml');
const roots: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
after(() => {
  children.forEach((c) => c.kill('SIGKILL'));
  servers.forEach((s) => s.close());
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});

/** The fake kubectl: Jobs and Secrets in state.json (a mkdir lock around each change), every call's arguments in calls.log (stdin never). */
const FAKE_KUBECTL = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const F = process.env.FAKE, S = path.join(F, 'state.json');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(F, 'calls.log'), 'kubectl ' + args.join(' ') + '\n');
const a = args[0] === '-n' ? args.slice(2) : args;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lock = (fn) => { const l = path.join(F, 'lock'); for (;;) { try { fs.mkdirSync(l); break; } catch { sleep(5); } } try { const s = JSON.parse(fs.readFileSync(S, 'utf8')); const r = fn(s); fs.writeFileSync(S + '.tmp', JSON.stringify(s)); fs.renameSync(S + '.tmp', S); return r; } finally { fs.rmdirSync(l); } };
const read = () => JSON.parse(fs.readFileSync(S, 'utf8'));
const sc = () => JSON.parse(fs.readFileSync(path.join(F, 'scenario.json'), 'utf8'));
const k8s = (j) => ({ metadata: { name: j.name, uid: 'uid-' + j.name, creationTimestamp: '2026-01-01T00:' + String(Math.floor(j.seq / 60)).padStart(2, '0') + ':' + String(j.seq % 60).padStart(2, '0') + 'Z',
  labels: { app: 'claudepilot-image-build', 'image-build/chat': j.chat }, annotations: { 'image-build/owner': j.owner || '', 'image-build/destination': j.dest || '' } },
  spec: { suspend: j.suspend }, status: j.done ? { [j.rc === 0 ? 'succeeded' : 'failed']: 1, conditions: [{ type: j.rc === 0 ? 'Complete' : 'Failed', status: 'True', reason: j.reason || 'BackoffLimitExceeded' }] } : {} });
const pod = (j) => ({ items: j && !j.suspend ? [{ spec: { nodeName: 'k3s-master' }, status: {
  initContainerStatuses: [{ name: 'clone', state: { terminated: { exitCode: 0 } } }],
  containerStatuses: [{ name: 'kaniko', state: j.done ? { terminated: { exitCode: j.rc, message: j.rc === 0 ? sc().digest : '' } } : { running: {} } }] } }] : [] });
const stdin = () => fs.readFileSync(0, 'utf8');
const job = (n) => read().jobs.find((j) => j.name === n);
const play = (n, c, follow) => {
  const s = sc();
  const sec = read().secrets[n] || {};
  const auth = (Object.values(JSON.parse(sec['config.json'] || '{"auths":{}}').auths)[0] || {}).auth || '';
  const pass = auth ? Buffer.from(auth, 'base64').toString().split(':').slice(1).join(':') : '';
  process.stdout.write((c === 'clone' ? s.clone : s.kaniko).replaceAll('{PASS}', pass).replaceAll('{AUTH}', auth));
  if (c === 'kaniko' && follow) lock((st) => { const j = st.jobs.find((x) => x.name === n); if (j) { j.done = true; j.rc = s.rc;
    if (s.rc === 0) { const m = fs.readFileSync(path.join(F, 'applied', n + '.yaml'), 'utf8'); const d = m.match(/--destination=([^"]+)/)[1];
      const p = path.join(F, 'pushed.json'); const pushed = JSON.parse(fs.readFileSync(p, 'utf8')); pushed[d.replace(/^[^/]+\//, '')] = s.digest; fs.writeFileSync(p, JSON.stringify(pushed)); } } });
};
const [verb, kind, name] = a;
if (verb === 'get' && kind === 'jobs') { process.stdout.write(JSON.stringify({ items: read().jobs.map(k8s) })); }
else if (verb === 'get' && kind === 'job') { const j = job(name); if (!j) process.exit(1); process.stdout.write(a.includes('json') ? JSON.stringify(k8s(j)) : 'uid-' + name); }
else if (verb === 'get' && kind === 'pods') { const j = job(a[3].replace('job-name=', '')); const p = pod(j); process.stdout.write(a.join(' ').includes('nodeName') ? (p.items.length ? 'k3s-master' : '') : JSON.stringify(p)); }
else if (verb === 'create' && kind === '-f') { const m = JSON.parse(stdin()); lock((s) => { s.secrets[m.metadata.name] = m.stringData; }); }
else if (verb === 'apply') { const m = stdin(); const n = m.match(/^ {2}name: (\S+)/m)[1]; fs.mkdirSync(path.join(F, 'applied'), { recursive: true }); fs.writeFileSync(path.join(F, 'applied', n + '.yaml'), m);
  lock((s) => { s.seq += 1; s.jobs.push({ name: n, chat: m.match(/image-build\/chat: ([^,}]+)/)[1].trim(), owner: m.match(/image-build\/owner: "([^"]*)"/)[1], suspend: true, seq: s.seq }); }); }
else if (verb === 'patch' && kind === 'job') { lock((s) => { const j = s.jobs.find((x) => x.name === name); if (j) j.suspend = false; }); }
else if (verb === 'patch' && kind === 'secret') { /* recorded in calls.log */ }
else if (verb === 'delete' && kind === 'job') { lock((s) => { s.jobs = s.jobs.filter((j) => j.name !== name); }); }
else if (verb === 'delete' && kind === 'secret') { lock((s) => { delete s.secrets[name]; }); }
else if (verb === 'logs') { const c = a[a.indexOf('-c') + 1]; const j = a.find((x) => x.startsWith('job/')).replace('job/', ''); play(j, c, a.includes('-f')); }
else { process.stderr.write('unexpected kubectl ' + args.join(' ') + '\n'); process.exit(9); }
`;

interface Seed { name: string; chat: string; suspend?: boolean; done?: boolean; rc?: number; owner?: string }
const hex = (n: number) => randomBytes(n).toString('hex');
const DIGEST = `sha256:${'ab'.repeat(32)}`;

/** A fake registry: tags in pushed.json ("<path>:<tag>" -> digest); with a user, HEAD answers 401 with a bearer challenge, /token swaps basic for a bearer. */
async function registry(root: string, login?: { user: string; pass: string }) {
  const bearer = `b${hex(12)}`;
  const seen: string[] = [];
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push(`${req.method} ${url.pathname} ${req.headers.authorization ?? ''}`);
    if (url.pathname === '/token') {
      const ok = login && req.headers.authorization === `Basic ${Buffer.from(`${login.user}:${login.pass}`).toString('base64')}`;
      if (!ok) { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: bearer }));
      return;
    }
    const m = url.pathname.match(/^\/v2\/(.+)\/manifests\/([^/]+)$/);
    if (!m) { res.writeHead(404).end(); return; }
    if (login && req.headers.authorization !== `Bearer ${bearer}`) {
      const port = (srv.address() as AddressInfo).port;
      res.writeHead(401, { 'www-authenticate': `Bearer realm="http://127.0.0.1:${port}/token",service="fake",scope="repository:${m[1]}:pull"` }).end();
      return;
    }
    const pushed = JSON.parse(readFileSync(join(root, 'pushed.json'), 'utf8')) as Record<string, string>;
    const d = pushed[`${m[1]}:${m[2]}`];
    if (!d) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'docker-content-digest': d, 'content-type': 'application/vnd.docker.distribution.manifest.v2+json' }).end();
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { host: `127.0.0.1:${(srv.address() as AddressInfo).port}`, seen };
}

function world(seeds: Seed[] = [], scenario: { rc?: number; clone?: string; kaniko?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-imagebuild-'));
  roots.push(root);
  const bin = join(root, 'bin'), home = join(root, 'home');
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL); chmodSync(join(bin, 'kubectl'), 0o755);
  writeFileSync(join(root, 'state.json'), JSON.stringify({ seq: seeds.length, secrets: {}, jobs: seeds.map((s, i) => ({ suspend: false, ...s, seq: i })) }));
  writeFileSync(join(root, 'pushed.json'), '{}');
  writeFileSync(join(root, 'scenario.json'), JSON.stringify({ rc: scenario.rc ?? 0, digest: DIGEST,
    clone: scenario.clone ?? '=== IMAGE-BUILD checked out abc1234 in 1s; building Dockerfile in .\n',
    kaniko: scenario.kaniko ?? 'INFO[0001] Retrieving image manifest busybox\nINFO[0003] Pushing image\n' }));
  // A pushed branch in a local "GitHub" (IMAGE_BUILD_GITHUB_BASE): the script asks it whether the ref is there.
  const git = (args: string[], cwd: string) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  mkdirSync(join(root, 'src'));
  git(['init', '-q', '-b', 'main'], join(root, 'src'));
  writeFileSync(join(root, 'src/Dockerfile'), 'FROM busybox\n');
  git(['add', '.'], join(root, 'src'));
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one'], join(root, 'src'));
  git(['branch', 'proof'], join(root, 'src'));
  mkdirSync(join(root, 'gh/acme'), { recursive: true });
  git(['clone', '-q', '--bare', join(root, 'src'), join(root, 'gh/acme/app.git')], root);
  const sha = git(['rev-parse', 'HEAD'], join(root, 'src')).stdout.trim();
  // Runtime-made credential (never a literal).
  const user = `u${hex(4)}`, pass = `p${hex(18)}`;
  const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: root, FAKE: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    IMAGE_BUILD_CLONE_IMAGE: 'registry.test/claudepilot/workspace:1-dev-1', IMAGE_BUILD_POLL_S: '0.1', IMAGE_BUILD_WATCH_PID: 'none',
    IMAGE_BUILD_GITHUB_BASE: `file://${join(root, 'gh')}`, IMAGE_BUILD_LOG: join(root, 'build.log'), PILOT_SESSION_ID: 'chat-a', PILOT_AGENT: 't141', ...over,
  });
  const start = (argv: string[], over: Record<string, string> = {}, input?: string) => {
    const p = spawn('bash', [SCRIPT, ...argv], { env: env(over), cwd: root });
    children.push(p);
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    // A script that refuses its arguments exits without reading stdin: the write then meets a closed pipe (EPIPE). That is the script's
    // right, not a failure; any other stream error still throws (and the exit code and output are asserted by each test).
    p.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE' && e.code !== 'ERR_STREAM_DESTROYED') throw e;
    });
    p.stdin.end(input ?? '');
    const done = new Promise<{ code: number | null; out: string }>((res) => p.on('close', (code) => res({ code, out })));
    return { p, done, out: () => out };
  };
  const run = (argv: string[], over: Record<string, string> = {}, input?: string) => start(argv, over, input).done;
  const state = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { secrets: Record<string, Record<string, string>>; jobs: (Seed & { suspend: boolean })[] };
  const edit = (fn: (s: ReturnType<typeof state>) => void) => { const s = state(); fn(s); writeFileSync(join(root, 'state.json'), JSON.stringify(s)); };
  const calls = () => (existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8') : '');
  const applied = () => { const d = join(root, 'applied'); return existsSync(d) ? readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')) : []; };
  const applied1 = () => { const [m] = applied(); assert.ok(m, 'a manifest was applied'); return m; };
  const credLine = JSON.stringify({ username: user, password: pass });
  return { root, sha, user, pass, credLine, start, run, state, edit, calls, applied, applied1, log: () => readFileSync(join(root, 'build.log'), 'utf8') };
}

async function waitFor(what: string, cond: () => boolean, ms = 15_000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

type C = { name: string; image: string; args: string[]; env?: { name: string; value?: string; valueFrom?: unknown }[]; resources: unknown; volumeMounts: unknown };
type Manifest = { metadata: { name: string; labels: Record<string, string>; annotations: Record<string, string> }; spec: Record<string, unknown> & { template: { spec: Record<string, unknown> & { initContainers: C[]; containers: C[]; volumes: unknown } } } };

test('a build with a credential on stdin: the manifest, the Secret from stdin (gone after), the bearer login, the digest last', async () => {
  const w = world([], { kaniko: 'INFO pushing\nauth was {AUTH} and {PASS}\n' });
  const reg = await registry(w.root, { user: w.user, pass: w.pass });
  const dest = `${reg.host}/acme/app:1.0`;
  const r = await w.run(['--repo', 'acme/app', '--ref', 'proof', '--dockerfile', 'Dockerfile', '--destination', dest, '--build-arg', 'MODE=stg', '--credential-stdin'],
    { IMAGE_BUILD_INSECURE_HOSTS: reg.host }, `${w.credLine}\n`);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.trimEnd().split('\n').at(-1), `DIGEST=${DIGEST}`, 'the digest is the last line');
  assert.match(r.out, /checked out abc1234/);
  assert.match(r.out, /auth was \[redacted\] and \[redacted\]/);
  assert.match(r.out, /WARNING: a credential was in the build log/);

  const text = w.applied1();
  const m = yamlLoad(text) as Manifest;
  assert.match(m.metadata.name, /^claudepilot-image-build-[0-9a-f]{8}$/);
  assert.deepEqual(m.metadata.labels, { app: 'claudepilot-image-build', 'image-build/chat': 'chat-a', 'image-build/role': 't141', 'image-build/repo': 'app' });
  assert.equal(m.metadata.annotations['image-build/destination'], dest);
  assert.equal(m.spec.suspend, true, 'created suspended: the queue lets it out');
  assert.equal(m.spec.backoffLimit, 0);
  assert.equal(m.spec.activeDeadlineSeconds, 3600);
  const pod = m.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.match(JSON.stringify(pod.affinity), /"podAntiAffinity".*"namespaces":\["isnan-claudepilot-workspaces"\].*"claudepilot.managed":"true"/);
  const [clone] = pod.initContainers, [kaniko] = pod.containers;
  assert.ok(clone && kaniko);
  assert.equal(clone.image, 'registry.test/claudepilot/workspace:1-dev-1');
  assert.deepEqual(Object.fromEntries((clone.env ?? []).filter((e) => e.value !== undefined).map((e) => [e.name, e.value])),
    { IB_REPO_URL: `file://${join(w.root, 'gh')}/acme/app.git`, IB_REF: 'proof', IB_DOCKERFILE: 'Dockerfile', IB_CONTEXT: '.' });
  assert.equal(kaniko.image, 'gcr.io/kaniko-project/executor:v1.23.2');
  assert.deepEqual(kaniko.args, ['--context=dir:///workspace/src/.', '--dockerfile=/workspace/src/Dockerfile', `--destination=${dest}`, '--custom-platform=linux/amd64',
    '--digest-file=/dev/termination-log', '--cache=false', '--snapshot-mode=redo', '--push-retry=3', '--build-arg=MODE=stg']);
  assert.deepEqual(kaniko.resources, { requests: { cpu: '1000m', memory: '2Gi' }, limits: { cpu: '4', memory: '8Gi' } });
  assert.ok(!text.includes(w.pass), 'the password is not in the manifest');

  const calls = w.calls();
  assert.match(calls, new RegExp(`-n isnan-claudepilot create -f -`));
  assert.match(calls, /patch secret claudepilot-image-build-[0-9a-f]{8} --type merge -p .*"ownerReferences":\[\{"apiVersion":"batch\/v1","kind":"Job"/);
  assert.match(calls, /delete secret claudepilot-image-build-/);
  assert.doesNotMatch(calls, /delete job /, 'a finished Job stays for its TTL');
  assert.deepEqual(w.state().secrets, {}, 'the Secret is deleted on exit');
  for (const where of [calls, r.out, w.log()]) assert.ok(!where.includes(w.pass) && !where.includes(Buffer.from(`${w.user}:${w.pass}`).toString('base64')));
  assert.ok(reg.seen.some((s) => s.startsWith('GET /token Basic ')), 'logged in for the bearer');
  assert.ok(reg.seen.some((s) => /^HEAD \/v2\/acme\/app\/manifests\/1\.0 Bearer /.test(s)), 'the tag read back with the bearer');
});

test('the Secret holds the docker config for the push host (made from stdin), and nothing else without Gitea', async () => {
  const w = world();
  const reg = await registry(w.root, { user: w.user, pass: w.pass });
  const s = w.start(['--repo', 'acme/app', '--ref', w.sha, '--dockerfile', 'Dockerfile', '--destination', `${reg.host}/acme/app:2`, '--credential-stdin'],
    { IMAGE_BUILD_INSECURE_HOSTS: reg.host, IMAGE_BUILD_MAX: '0', IMAGE_BUILD_QUEUE_WAIT_S: '600' }, `${w.credLine}\n`);
  await waitFor('queued (the cap 0 holds it)', () => /queued behind 0/.test(s.out()));
  const [sec] = Object.values(w.state().secrets);
  assert.ok(sec);
  assert.deepEqual(Object.keys(sec), ['config.json']);
  assert.deepEqual(JSON.parse(sec['config.json'] ?? ''), { auths: { [reg.host]: { auth: Buffer.from(`${w.user}:${w.pass}`).toString('base64') } } });
  s.p.kill('SIGTERM');
  const r = await s.done;
  assert.equal(r.code, 130, r.out);
  assert.deepEqual(w.state().secrets, {}, 'interrupted: the Secret is gone');
  assert.deepEqual(w.state().jobs, [], 'interrupted: the Job is gone');
});

test('the internal registry: pushed through the in-cluster service with --insecure, no credential, an empty docker config', async () => {
  const w = world();
  const reg = await registry(w.root);
  const r = await w.run(['--repo', 'claudepilot', '--ref', w.sha, '--dockerfile', 'deploy/x.Dockerfile', '--context', 'deploy', '--destination', `${reg.host}/claudepilot/image-build-proof:abc1234`],
    { DEPLOY_REGISTRY: reg.host, IMAGE_BUILD_INSECURE_HOSTS: reg.host });
  assert.equal(r.code, 0, r.out);
  const [kaniko] = (yamlLoad(w.applied1()) as Manifest).spec.template.spec.containers;
  assert.ok(kaniko);
  assert.ok(kaniko.args.includes('--destination=registry.isnan-registry.svc.cluster.local:5000/claudepilot/image-build-proof:abc1234'));
  assert.ok(kaniko.args.includes('--insecure'));
  assert.ok(kaniko.args.includes('--context=dir:///workspace/src/deploy'));
  assert.match(r.out, /credential in the build log: none/);
  assert.match(r.out, /DIGEST=sha256:(ab){32}\n$/);
});

test('a failed build: exit 1, no digest line, the Secret deleted', async () => {
  const w = world([], { rc: 1, kaniko: 'error building image: RUN false\n' });
  const reg = await registry(w.root);
  const r = await w.run(['--repo', 'acme/app', '--ref', 'main', '--dockerfile', 'Dockerfile', '--destination', `${reg.host}/acme/app:bad`], { IMAGE_BUILD_INSECURE_HOSTS: reg.host });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /error building image/);
  assert.match(r.out, /the build failed \(Failed:BackoffLimitExceeded\)/);
  assert.doesNotMatch(r.out, /DIGEST=/);
  assert.deepEqual(w.state().secrets, {});
});

test('one build at a time cluster-wide: the second says "queued behind 1" and starts when the first ends', async () => {
  const w = world([{ name: 'claudepilot-image-build-00000001', chat: 'chat-x' }]);
  const reg = await registry(w.root);
  const s = w.start(['--repo', 'acme/app', '--ref', 'main', '--dockerfile', 'Dockerfile', '--destination', `${reg.host}/acme/app:q`], { IMAGE_BUILD_INSECURE_HOSTS: reg.host });
  await waitFor('the queue line', () => /queued behind 1 \(at most 1 build\(s\) at once\)/.test(s.out()));
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(w.state().jobs.find((j) => j.name !== 'claudepilot-image-build-00000001')?.suspend, 'still suspended');
  w.edit((st) => { Object.assign(st.jobs[0] ?? {}, { done: true, rc: 0 }); });
  const r = await s.done;
  assert.equal(r.code, 0, r.out);
  assert.equal((r.out.match(/queued behind/g) ?? []).length, 1, 'said once, not every poll');
});

test('--check: 0 and the digest when the tag exists, 3 when not, 1 when the credential is refused; the credential never shown', async () => {
  const w = world();
  const reg = await registry(w.root, { user: w.user, pass: w.pass });
  writeFileSync(join(w.root, 'pushed.json'), JSON.stringify({ 'acme/app:1.0': DIGEST }));
  const over = { IMAGE_BUILD_INSECURE_HOSTS: reg.host };
  const yes = await w.run(['--check', '--destination', `${reg.host}/acme/app:1.0`, '--credential-stdin'], over, `${w.credLine}\n`);
  assert.equal(yes.code, 0, yes.out);
  assert.match(yes.out, new RegExp(`exists \\(${DIGEST}\\)\nDIGEST=${DIGEST}\n$`));
  const no = await w.run(['--check', '--destination', `${reg.host}/acme/app:2.0`, '--credential-stdin'], over, `${w.credLine}\n`);
  assert.equal(no.code, 3, no.out);
  assert.match(no.out, /does not exist/);
  const wrong = await w.run(['--check', '--destination', `${reg.host}/acme/app:1.0`, '--credential-stdin'], over, `${JSON.stringify({ username: w.user, password: `x${hex(10)}` })}\n`);
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /refused the credential/);
  for (const r of [yes, no, wrong]) assert.ok(!r.out.includes(w.pass));
  assert.equal(w.calls(), '', '--check never touches the cluster');
  // Without a login the registry answers directly.
  const open = await registry(w.root);
  assert.equal((await w.run(['--check', '--destination', `${open.host}/acme/app:1.0`], { IMAGE_BUILD_INSECURE_HOSTS: open.host })).code, 0);
});

test('usage errors: a destination with a space or shell characters, a ref not pushed, a short commit, bad build args; nothing is created', async () => {
  const w = world();
  const base = ['--repo', 'acme/app', '--dockerfile', 'Dockerfile'];
  const cases: [string[], RegExp, string?][] = [
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/a b:1'], /--destination: <host>/],
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/a;rm -rf /:1'], /--destination: <host>/],
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/$(id):1'], /--destination: <host>/],
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/a`id`:1'], /--destination: <host>/],
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/a#x:1'], /--destination: <host>/],
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/App:1'], /--destination: <host>/],
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/app'], /--destination: <host>/],
    [[...base, '--ref', 'main', '--destination', 'app:1'], /--destination/],
    [[...base, '--ref', 'not-pushed', '--destination', 'registry.int.isnan.me/a:1'], /not-pushed is not on acme\/app's remote: push it first/],
    [[...base, '--ref', 'abc1234', '--destination', 'registry.int.isnan.me/a:1'], /a commit is the full 40 characters/],
    [[...base, '--ref', 'a b', '--destination', 'registry.int.isnan.me/a:1'], /--ref: a branch, tag or commit/],
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/a:1', '--build-arg', 'X=a b'], /--build-arg K=V/],
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/a:1', '--build-arg', 'X=$(id)'], /--build-arg K=V/],
    [['--repo', 'acme/app', '--dockerfile', '../Dockerfile', '--ref', 'main', '--destination', 'registry.int.isnan.me/a:1'], /--dockerfile: a path inside/],
    [[...base, '--context', '/etc', '--ref', 'main', '--destination', 'registry.int.isnan.me/a:1'], /--context: a folder inside/],
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/a:1', '--timeout', '7200'], /--timeout: 60 to 3600/],
    [['--repo', 'a/b/c', '--dockerfile', 'D', '--ref', 'main', '--destination', 'registry.int.isnan.me/a:1'], /--repo:/],
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/a:1', '--credential-stdin'], /--credential-stdin: one JSON line/, 'not json\n'],
    [[...base, '--ref', 'main', '--destination', 'registry.int.isnan.me/a:1', '--credential-stdin'], /--credential-stdin: no line/, ''],
    [[...base, '--ref', 'main'], /--destination .* is required/],
  ];
  for (const [argv, re, input] of cases) {
    const r = await w.run(argv, {}, input);
    assert.equal(r.code, 2, `${argv.join(' ')}: ${r.out}`);
    assert.match(r.out, re);
  }
  assert.equal(w.calls(), '', 'no kubectl call for a refused build');
});

test('--list and --stop: a chat\'s builds stop, the others stay', async () => {
  const w = world([{ name: 'claudepilot-image-build-0000000a', chat: 'chat-a' }, { name: 'claudepilot-image-build-0000000b', chat: 'chat-b', suspend: true }]);
  assert.match((await w.run(['--list'])).out, /claudepilot-image-build-0000000b\tchat-b\t[^\t]*\tqueued/);
  const r = await w.run(['--stop', '--chat', 'chat-a']);
  assert.match(r.out, /stopped claudepilot-image-build-0000000a\n1 job\(s\) stopped/);
  assert.deepEqual(w.state().jobs.map((j) => j.name), ['claudepilot-image-build-0000000b']);
  assert.match((await w.run(['--stop', 'nope; rm -rf /'])).out, /usage/);
});

test('the init container\'s own script: checks out the ref; a ref not on the remote says push it first; a missing Dockerfile is named', () => {
  const w = world();
  const tpl = readFileSync(TEMPLATE, 'utf8');
  const body = tpl.slice(tpl.indexOf('# IMAGE-BUILD-CLONE BEGIN'), tpl.indexOf('# IMAGE-BUILD-CLONE END')).replace(/^ {14}/gm, '');
  const clone = (ref: string, dockerfile = 'Dockerfile') => {
    const root = join(w.root, `pod-${hex(3)}`);
    const r = spawnSync('bash', ['-c', body], { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', IB_ROOT: root,
      IB_REPO_URL: `file://${join(w.root, 'gh/acme/app.git')}`, IB_REF: ref, IB_DOCKERFILE: dockerfile, IB_CONTEXT: '.' } });
    return { ...r, root };
  };
  const ok = clone('proof');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /=== IMAGE-BUILD checked out [0-9a-f]+ in \d+s; building Dockerfile in \.\n$/);
  assert.equal(readFileSync(join(ok.root, 'src/Dockerfile'), 'utf8'), 'FROM busybox\n');
  assert.ok(!existsSync(join(ok.root, '.home')), 'the git config with the helper is gone before kaniko runs');
  const missing = clone('no-such-branch');
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /=== IMAGE-BUILD CLONE FAILED\nimage-build: no-such-branch of .* is not on the remote \(push it first\)/);
  const nofile = clone('proof', 'build/Dockerfile');
  assert.equal(nofile.status, 2);
  assert.match(nofile.stdout, /no file build\/Dockerfile in the repository/);
});
