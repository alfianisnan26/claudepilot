// T-401: the job-run and gate Jobs give their credentials (the npm token, the git token) to the init container `fetch` alone. It clones and
// runs `npm ci --ignore-scripts`; the install scripts and the command run in the main container, which has no credential in its
// environment, git config or files. Checked on the manifests and by running the containers' own scripts in order here, with credentials
// made at runtime (never a literal) and a fake npm that records, for each call, whether a credential was there (never its value).

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';
import { runPod, scriptPart } from './jobRunTestkit.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const JOB_RUN = join(REPO, 'deploy/k3s-build/job-run.yaml');
const GATE = join(REPO, 'deploy/k3s-build/gate-job.yaml');
const CRED_NAMES = ['NODE_AUTH_TOKEN', 'GIT_TOKEN', 'GIT_USER'];
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const hex = (n: number) => randomBytes(n).toString('hex');

type Env = { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } };
type C = { name: string; env?: Env[]; envFrom?: unknown[]; volumeMounts?: { name: string }[]; args?: string[] };
type Pod = { initContainers?: C[]; containers: C[]; volumes?: { name: string; secret?: unknown }[] };

function podOf(file: string): Pod {
  const text = readFileSync(file, 'utf8').replace(/__MEMORY__/g, '4Gi').replace(/__TMP_SIZE__/g, '2Gi').replace(/__[A-Z_]+__/g, 'x');
  return (yamlLoad(text) as { spec: { template: { spec: Pod } } }).spec.template.spec;
}

test('T-401 manifests: the main container of job-run and gate has no Secret; the fetch init container has it, and its HOME alone', () => {
  for (const [file, main] of [[JOB_RUN, 'run'], [GATE, 'gate']] as const) {
    const pod = podOf(file);
    const secretVolumes = (pod.volumes ?? []).filter((v) => v.secret).map((v) => v.name);
    for (const c of pod.containers) {
      assert.equal(c.name, main);
      assert.deepEqual((c.env ?? []).filter((e) => e.valueFrom?.secretKeyRef).map((e) => e.name), [], `${file}: no secretKeyRef in ${c.name}`);
      assert.deepEqual((c.env ?? []).filter((e) => CRED_NAMES.includes(e.name)).map((e) => e.name), [], `${file}: no credential name in ${c.name}`);
      assert.equal(c.envFrom, undefined, `${file}: no envFrom in ${c.name}`);
      const mounts = (c.volumeMounts ?? []).map((m) => m.name);
      assert.ok(!mounts.includes('fetch-home'), `${file}: the fetch HOME is not mounted in ${c.name}`);
      assert.deepEqual(mounts.filter((m) => secretVolumes.includes(m)), [], `${file}: no Secret volume in ${c.name}`);
    }
    const inits = pod.initContainers ?? [];
    assert.deepEqual(inits.map((c) => c.name), ['fetch'], `${file}: one init container, fetch`);
    const fetch = inits[0] as C;
    const refs = (fetch.env ?? []).filter((e) => e.valueFrom?.secretKeyRef).map((e) => e.name);
    assert.ok(refs.includes('NODE_AUTH_TOKEN'), `${file}: fetch has the npm token`);
    assert.ok((fetch.volumeMounts ?? []).some((m) => m.name === 'fetch-home'), `${file}: fetch has its own HOME`);
    assert.ok((fetch.volumeMounts ?? []).some((m) => m.name === 'tmp'), `${file}: fetch shares /tmp`);
  }
});

/** A local repository served as the Job's remote, a fake npm that records each call and whether a credential was there. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'cp-t401-'));
  roots.push(root);
  const env0 = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args: string[], cwd: string) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', env: env0 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const src = join(root, 'src');
  mkdirSync(src);
  git(['init', '-q', '-b', 'main'], src);
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { postinstall: 'x', prepare: 'y', test: 'z' } }));
  writeFileSync(join(src, 'package-lock.json'), '{"v":1}');
  git(['add', '.'], src); git(['commit', '-qm', 'one'], src);
  const one = git(['rev-parse', 'HEAD'], src);
  const bare = join(root, 'remote.git');
  const publish = () => { rmSync(bare, { recursive: true, force: true }); git(['clone', '-q', '--bare', src, bare], root); };
  publish();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'calls');
  // "set"/"" for each credential name, never the value; the git helpers and the user npmrc as this process would find them.
  const probe = 'tok=${NODE_AUTH_TOKEN:+set} gtok=${GIT_TOKEN:+set} guser=${GIT_USER:+set} helper=$(git config --global --get-regexp "^credential" 2>/dev/null | wc -l) npmrc=$([ -e "$HOME/.npmrc" ] && echo yes || echo no)';
  writeFileSync(join(bin, 'npm'), `#!/bin/bash\necho "npm $* ${probe}" >> "${calls}"\nmkdir -p node_modules\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  const creds = { NODE_AUTH_TOKEN: `fx${hex(18)}`, GIT_TOKEN: `gt${hex(18)}`, GIT_USER: 'x-access-token' };
  // Event's URL (the npmrc and the scoped helper are written for it alone, T-491), served from the local repository.
  const url = 'https://github.com/isnanme/event.git';
  const pod = (over: Record<string, string> = {}, c: Record<string, string> = creds) => {
    rmSync(calls, { force: true });
    const jr = join(root, `jr-${hex(3)}`);
    const r = runPod(JOB_RUN, { PATH: `${bin}:${process.env.PATH}`, JR_ROOT: jr, JR_REPO_URL: url, JR_REF: 'main', JR_ALSO: '', JR_STEPS: 'npm-ci',
      JR_ARTIFACTS: '', JR_ARTIFACT_MAX: '1', JR_CMD: Buffer.from(`echo "cmd ${probe}" >> "${calls}"`).toString('base64'), GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`, GIT_CONFIG_VALUE_0: url, ...over }, c);
    return { r, jr, lines: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
  };
  return { root, src, git, one, publish, creds, pod };
}

const noValue = (text: string, creds: Record<string, string>) => {
  for (const [k, v] of Object.entries(creds)) if (v.length >= 8) assert.ok(!text.includes(v), `the value of ${k} is not in the output`);
};

test('T-401 order: clone and npm ci --ignore-scripts with the credentials, then the install scripts and the command with none', () => {
  const w = world();
  const { r, lines } = w.pod();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  noValue(r.stdout + r.stderr, w.creds);
  const clean = 'tok= gtok= guser= helper=0 npmrc=no';
  assert.deepEqual(lines, [
    'npm ci --ignore-scripts --no-audit --no-fund --loglevel=error tok=set gtok=set guser=set helper=2 npmrc=yes',
    `npm rebuild --no-audit --no-fund --loglevel=error ${clean}`,
    `npm run --ignore-scripts --loglevel=error postinstall ${clean}`,
    `npm run --ignore-scripts --loglevel=error prepare ${clean}`,
    `cmd ${clean}`,
  ]);
  assert.match(r.stdout, /=== JOB-RUN checked out event at [0-9a-f]+ in \d+s\n[\s\S]*=== JOB-RUN credentials: used for the fetch only; none is in the files the command gets/);
  assert.match(r.stdout, /=== JOB-RUN EXIT 0\n$/);
});

test('T-401 the fetch check: a credential value in a file the command would get stops the Job (code 3), naming the file, never the value', () => {
  const w = world();
  writeFileSync(join(w.src, 'leak.txt'), `token ${w.creds.GIT_TOKEN}\n`);
  w.git(['add', '.'], w.src); w.git(['commit', '-qm', 'leak'], w.src); w.publish();
  const { r, lines } = w.pod();
  assert.equal(r.status, 3, r.stdout + r.stderr);
  noValue(r.stdout + r.stderr, w.creds);
  assert.match(r.stdout, /\/w\/event\/leak\.txt\n[\s\S]*the credential GIT_TOKEN is in the files above, which the command would see: stopping\n=== JOB-RUN EXIT 3\n$/);
  assert.ok(!lines.some((l) => l.startsWith('cmd ') || l.startsWith('npm rebuild')), 'nothing of the repository ran');
});

test('T-401 --against with another lockfile: fetched and cached by fetch; the run container installs offline, without a credential', () => {
  const w = world();
  writeFileSync(join(w.src, 'package-lock.json'), '{"v":2}');
  w.git(['add', '.'], w.src); w.git(['commit', '-qm', 'two'], w.src); w.publish();
  const { r, lines } = w.pod({ JR_AGAINST: w.one });
  assert.equal(r.status, 1, r.stdout + r.stderr); // the command passes on both: no proof, which is beside the point here
  assert.match(r.stdout, /lockfile differs on [0-9a-f]{40}: npm ci again \(offline, from the cache\)/);
  const withCred = lines.filter((l) => / tok=set /.test(l));
  assert.deepEqual(withCred.map((l) => l.split(' tok=')[0]), ['npm ci --ignore-scripts --no-audit --no-fund --loglevel=error', 'npm ci --ignore-scripts --no-audit --no-fund --loglevel=error'],
    'fetch: the ref and the other lockfile (into the cache), both without scripts');
  const last = lines.slice(lines.indexOf(withCred[1] as string) + 1);
  assert.ok(last.length > 0 && last.every((l) => l.endsWith('tok= gtok= guser= helper=0 npmrc=no')), last.join('\n'));
  assert.ok(last.includes('npm ci --ignore-scripts --prefer-offline --no-audit --no-fund --loglevel=error tok= gtok= guser= helper=0 npmrc=no'));
  noValue(r.stdout + r.stderr, w.creds);
});

test('T-401 gate: the fetch container clones and fills npm\'s cache without scripts, removes its copy and finds no token in /tmp', () => {
  const w = world();
  const root = join(w.root, 'gate-tmp');
  const bin = join(w.root, 'bin');
  const tok = w.creds.NODE_AUTH_TOKEN;
  const run = (commit: string) => {
    rmSync(root, { recursive: true, force: true }); mkdirSync(root);
    const f = spawnSync('bash', ['-c', scriptPart(GATE, '# GATE-FETCH BEGIN', '# GATE-FETCH END')], { encoding: 'utf8', env: {
      PATH: `${bin}:${process.env.PATH}`, GATE_ROOT: root, GATE_FETCH_HOME: join(w.root, 'gate-home'), GATE_REPO_URL: `file://${join(w.root, 'remote.git')}`,
      COMMIT: commit, GIT_CONFIG_NOSYSTEM: '1', NODE_AUTH_TOKEN: tok } });
    assert.equal(f.status, 0, f.stdout + f.stderr);
    return { rc: readFileSync(join(root, 'fetch.rc'), 'utf8').trim(), log: readFileSync(join(root, 'fetch.log'), 'utf8') };
  };
  const ok = run(w.one);
  assert.equal(ok.rc, '0', ok.log);
  assert.match(ok.log, /credentials: used for npm's cache only; none is in the files the gate gets/);
  assert.ok(existsSync(join(root, 'src/package.json')) && !existsSync(join(root, 'warm')), 'the commit in /tmp/src; the throwaway copy gone');
  assert.ok(readFileSync(join(w.root, 'calls'), 'utf8').includes('npm ci --ignore-scripts --no-audit --no-fund --loglevel=error tok=set'));
  assert.ok(!ok.log.includes(tok));
  const missing = run('0'.repeat(40));
  assert.equal(missing.rc, '1');
  assert.match(missing.log, /GATE-VERDICT: red: 0{40} is not on GitHub \(push it first\)/);
});
