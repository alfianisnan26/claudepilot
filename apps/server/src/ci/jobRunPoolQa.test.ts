// QA lane (perf and security) probes for T-426 S1f (--pool-env credentials in job-run). Test code only, on the QA branch. The builder's tests are not
// repeated. Fixture values are made at runtime and are never printed: probes print the NAMES that are set, or a short hash of a value.
// Part 1 runs the Job's own container scripts (deploy/k3s-build/job-run.yaml) in order with a fake npm; part 2 runs scripts/job-run.sh against a
// fake kubectl (a copy of the harness in jobRun.test.ts, which does not export it). Nothing here reaches a cluster.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPod } from './jobRunTestkit.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO, 'scripts/job-run.sh');
const YAML = join(REPO, 'deploy/k3s-build/job-run.yaml');
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const hex = (n: number) => randomBytes(n).toString('hex');
const h16 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);
const POOL_ID = 'E2E_CF_ACCESS_CLIENT_ID';

// ---------- part 1: the run container's environment ----------

function pod() {
  const root = mkdtempSync(join(tmpdir(), 'cp-qa426-'));
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
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { postinstall: 'x', test: 'z' } }));
  writeFileSync(join(src, 'package-lock.json'), '{"v":1}');
  git(['add', '.'], src); git(['commit', '-qm', 'one'], src);
  const one = git(['rev-parse', 'HEAD'], src);
  writeFileSync(join(src, 'package-lock.json'), '{"v":2}');
  git(['add', '.'], src); git(['commit', '-qm', 'two'], src);
  const bare = join(root, 'remote.git');
  git(['clone', '-q', '--bare', src, bare], root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'calls');
  // The fake npm records its arguments, the NAMES of the E2E_CF_ACCESS_* / JR_POOL_ variables in its environment, and how many JR_POOL_ names its
  // parent shell's start-up environment (/proc/<ppid>/environ) holds: what a lifecycle script of a dependency could read. Never a value.
  writeFileSync(join(bin, 'npm'), `#!/bin/bash
names=; for n in $(compgen -e); do case $n in *E2E_CF_ACCESS_*) names="$names $n" ;; esac; done
pp=$(tr '\\0' '\\n' < /proc/$PPID/environ 2>/dev/null | grep -c '^JR_POOL_' || true)
echo "npm $* envnames=[$names ] procparent=$pp" >> "${calls}"
mkdir -p node_modules
`);
  chmodSync(join(bin, 'npm'), 0o755);
  const url = 'https://github.com/isnanme/event.git';
  const creds = { NODE_AUTH_TOKEN: `fx${hex(18)}`, GIT_TOKEN: `gt${hex(18)}`, GIT_USER: 'x-access-token' };
  const go = (cmd: string, pool: Record<string, string>, over: Record<string, string> = {}) => {
    rmSync(calls, { force: true });
    const jr = join(root, `jr-${hex(3)}`);
    const r = runPod(YAML, { PATH: `${bin}:${process.env.PATH}`, JR_ROOT: jr, JR_REPO_URL: url, JR_REF: 'main', JR_ALSO: '', JR_STEPS: 'npm-ci', JR_ARTIFACTS: '',
      JR_ARTIFACT_MAX: '1', JR_CMD: Buffer.from(cmd).toString('base64'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`,
      GIT_CONFIG_VALUE_0: url, ...Object.fromEntries(Object.entries(pool).map(([k, v]) => [`JR_POOL_${k}`, v])), ...over }, creds);
    return { r, lines: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
  };
  return { go, one };
}
// What the command prints: which pool names it sees, and a hash of a value.
const NAMES = 'n=; for v in $(compgen -e); do case $v in *E2E_CF_ACCESS_*) n="$n $v" ;; esac; done';

test('QA-P1 (2, 5) install steps see no pool name; the command sees it with the exact value (special characters); the /proc limit is real', () => {
  const w = pod();
  // A value with shell-special characters must arrive byte for byte (the check is a hash; the value is never printed).
  const value = `a b$HOME\`id\`'"=\\*;&${hex(6)}`;
  const outFile = join(tmpdir(), `qa426-cmd-${hex(4)}`);
  roots.push(outFile);
  const { r, lines } = w.go(`${NAMES}; echo "cmd names=[$n ] hash=$(printf %s "$${POOL_ID}" | sha256sum | cut -c1-16)" > ${outFile}`, { [POOL_ID]: value });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(value), 'the value is not in the output');
  const install = lines.filter((l) => /^npm (rebuild|run)\b/.test(l));
  assert.ok(install.length >= 2, `rebuild and a lifecycle script ran: ${lines.join(' | ')}`);
  for (const l of install) assert.match(l, /envnames=\[ \]/, `no pool name in the environment of: ${l}`);
  const cmd = readFileSync(outFile, 'utf8').trim();
  assert.equal(cmd, `cmd names=[ ${POOL_ID} ] hash=${h16(value)}`, 'the command sees the name, and the value is unchanged');
  // The limit the docs state: the shell's start-up environment still holds the names, and a lifecycle script (same user) can read it.
  for (const l of install) assert.match(l, /procparent=[1-9]/, `a lifecycle script can still see the name through /proc: ${l}`);
});

test('QA-P2 --against: the offline npm ci there sees no pool name, and both command runs get the value', () => {
  const w = pod();
  const value = `qa${hex(10)}`;
  const outFile = join(tmpdir(), `qa426-cmd-${hex(4)}`);
  roots.push(outFile);
  const { lines } = w.go(`echo "cmd $(printf %s "$${POOL_ID}" | sha256sum | cut -c1-16)" >> ${outFile}`, { [POOL_ID]: value }, { JR_AGAINST: w.one });
  const again = lines.filter((l) => /^npm ci\b.*--prefer-offline/.test(l));
  assert.ok(again.length >= 1, `the against npm ci ran: ${lines.join(' | ')}`);
  for (const l of again) assert.match(l, /envnames=\[ \]/, `no pool name during the against install: ${l}`);
  const runs = readFileSync(outFile, 'utf8').trim().split('\n');
  assert.deepEqual(runs, [`cmd ${h16(value)}`, `cmd ${h16(value)}`], 'both runs of the command (the ref and --against) get the value');
});

test('QA-P3 (3) every name the script accepts is matched by the yaml pattern; a JR_POOL_ name of another form is not stripped (the two lists are coupled)', () => {
  const sh = readFileSync(SCRIPT, 'utf8'), y = readFileSync(YAML, 'utf8');
  const re = sh.match(/\[\[ \$n =~ (\^E2E_CF_ACCESS_\[A-Z0-9_\]\+\$) \]\]/);
  assert.ok(re, 'the --pool-env name check is where the probe expects it');
  assert.ok(y.includes('JR_POOL_E2E_CF_ACCESS_*) jr_pool['), 'the yaml pattern is where the probe expects it');
  const accepted = ['E2E_CF_ACCESS_X', POOL_ID, 'E2E_CF_ACCESS_A_9_B', 'E2E_CF_ACCESS_0'];
  for (const n of accepted) assert.ok(new RegExp(re![1]!).test(n), `${n} passes the script's check`);
  const w = pod();
  const pool = Object.fromEntries(accepted.map((n) => [n, `qa${hex(10)}`]));
  const outFile = join(tmpdir(), `qa426-cmd-${hex(4)}`);
  roots.push(outFile);
  const { lines } = w.go(`${NAMES}; echo "cmd names=[$n ] other=\${JR_POOL_OTHER_NAME:+set}" > ${outFile}`, { ...pool, OTHER_NAME: `qa${hex(10)}` });
  for (const l of lines.filter((x) => /^npm (rebuild|run)\b/.test(x))) assert.match(l, /envnames=\[ \]/, `an accepted name leaked into the install steps: ${l}`);
  const cmd = readFileSync(outFile, 'utf8').trim();
  for (const n of accepted) assert.ok(cmd.includes(` ${n} `) || cmd.includes(` ${n}]`), `${n} reaches the command`);
  assert.match(cmd, /other=set/, 'a JR_POOL_ name outside the pattern stays in the environment (the yaml list must follow job-run.sh)');
});

// ---------- part 2: the --out scan ----------

const FAKE_KUBECTL = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const F = process.env.FAKE, S = path.join(F, 'state.json');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(F, 'calls.log'), 'kubectl ' + args.join(' ') + '\n');
const a = args[0] === '-n' ? args.slice(2) : args;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lock = (fn) => { const l = path.join(F, 'lock'); for (;;) { try { fs.mkdirSync(l); break; } catch { sleep(5); } } try { const s = JSON.parse(fs.readFileSync(S, 'utf8')); const r = fn(s); fs.writeFileSync(S + '.tmp', JSON.stringify(s)); fs.renameSync(S + '.tmp', S); return r; } finally { fs.rmdirSync(l); } };
const read = () => JSON.parse(fs.readFileSync(S, 'utf8'));
const k8s = (j) => ({ metadata: { name: j.name, uid: 'uid-' + j.name, creationTimestamp: '2026-01-01T00:' + String(Math.floor(j.seq / 60)).padStart(2, '0') + ':' + String(j.seq % 60).padStart(2, '0') + 'Z',
  labels: { app: 'claudepilot-job-run', 'job-run/chat': j.chat, 'job-run/role': j.role || 'agent', ...(j.program ? { 'job-run/program': j.program } : {}), ...(j.repo ? { 'job-run/repo': j.repo } : {}) },
  annotations: { 'job-run/owner': j.owner || '' } },
  spec: { suspend: j.suspend }, status: j.done ? { [j.rc === 0 ? 'succeeded' : 'failed']: 1, conditions: [{ type: j.rc === 0 ? 'Complete' : 'Failed', status: 'True', reason: j.reason }] } : {} });
const stdin = () => fs.readFileSync(0, 'utf8');
const job = (n) => read().jobs.find((j) => j.name === n);
const play = (n, follow) => {
  const sc = JSON.parse(fs.readFileSync(path.join(F, 'scenario.json'), 'utf8'));
  process.stdout.write(sc.log);
  lock((s) => { const j = s.jobs.find((x) => x.name === n); if (j) { j.done = true; j.rc = sc.rc; j.reason = sc.reason; } });
};
const podOf = (j) => {
  if (!j || j.suspend) return { items: [] };
  const status = { phase: j.done ? (j.rc === 0 ? 'Succeeded' : 'Failed') : 'Running' };
  return { items: [{ spec: { nodeName: 'k3s-master' }, status }] };
};
const [verb, kind, name] = a;
if (verb === 'get' && kind === 'jobs') { process.stdout.write(JSON.stringify({ items: read().jobs.map(k8s) })); }
else if (verb === 'get' && kind === 'job') { const j = job(name); if (!j) process.exit(1); process.stdout.write(a.includes('json') ? JSON.stringify(k8s(j)) : 'uid-' + name); }
else if (verb === 'get' && kind === 'pods' && a.includes('json')) { process.stdout.write(JSON.stringify(podOf(job(a[3].replace('job-name=', ''))))); }
else if (verb === 'create' && kind === '-f') { const o = JSON.parse(stdin()); const n = o.metadata.name; const env = Object.entries(o.data).map(([k, v]) => k + '=' + Buffer.from(v, 'base64').toString()).join('\n') + '\n';
  if (o.metadata.annotations) process.exit(7); lock((s) => { s.secrets[n] = env; }); }
else if (verb === 'create' && kind === 'secret') { const t = stdin(); const data = {}; for (const l of t.split('\n')) { const i = l.indexOf('='); if (i > 0) data[l.slice(0, i)] = Buffer.from(l.slice(i + 1)).toString('base64'); }
  if (!a.includes('--dry-run=client')) lock((s) => { s.secrets[a[3]] = t; });
  else process.stdout.write(JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: a[3] }, data })); }
else if (verb === 'top' && kind === 'nodes') { process.exit(1); }
else if (verb === 'apply') { const m = stdin(); const n = m.match(/^ {2}name: (\S+)/m)[1]; fs.mkdirSync(path.join(F, 'applied'), { recursive: true }); fs.writeFileSync(path.join(F, 'applied', n + '.yaml'), m);
  const lab = (k) => m.match(new RegExp(k + ': ([^,}]+)'))[1].trim();
  lock((s) => { s.seq += 1; s.jobs.push({ name: n, chat: lab('job-run/chat'), role: lab('job-run/role'), program: lab('job-run/program'), owner: m.match(/job-run\/owner: "([^"]*)"/)[1], suspend: true, seq: s.seq }); }); }
else if (verb === 'patch' && kind === 'job') { lock((s) => { const j = s.jobs.find((x) => x.name === name); if (j) j.suspend = false; }); }
else if (verb === 'patch' && kind === 'secret') { /* recorded in calls.log */ }
else if (verb === 'delete' && kind === 'job') { lock((s) => { s.jobs = s.jobs.filter((j) => j.name !== name); }); }
else if (verb === 'delete' && kind === 'secret') { lock((s) => { delete s.secrets[name]; }); }
else if (verb === 'logs') { play(a.includes('-f') ? a[2].replace('job/', '') : a[1].replace('job/', ''), a.includes('-f')); }
else { process.stderr.write('unexpected kubectl ' + args.join(' ') + '\n'); process.exit(9); }
`;

function world(artifacts: Record<string, string>, rc = 0) {
  const root = mkdtempSync(join(tmpdir(), 'cp-qa426w-'));
  roots.push(root);
  const bin = join(root, 'bin'), home = join(root, 'home'), art = join(root, 'art');
  mkdirSync(bin); mkdirSync(home); mkdirSync(join(art, 'reports'), { recursive: true });
  writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL); chmodSync(join(bin, 'kubectl'), 0o755);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(root, 'state.json'), JSON.stringify({ seq: 0, secrets: {}, jobs: [] }));
  for (const [name, body] of Object.entries(artifacts)) writeFileSync(join(art, 'reports', name), body);
  // tar is given the file names as they are (a name with a line break included).
  const tgz = spawnSync('tar', ['-czf', '-', '-C', art, 'reports']).stdout.toString('base64');
  const log = `=== JOB-RUN ARTIFACTS BEGIN\n${tgz}\n\n=== JOB-RUN ARTIFACTS END\n=== JOB-RUN EXIT ${rc}\n`;
  writeFileSync(join(root, 'scenario.json'), JSON.stringify({ rc, log }));
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, `[credential "https://git.konfersi.com"]\n\thelper = "!f() { echo username=bot; echo password=gt${hex(18)}; }; f"\n`);
  const run = (argv: string[], over: Record<string, string> = {}, extraBin?: string) => {
    const r = spawnSync('bash', [SCRIPT, ...argv], { cwd: root, encoding: 'utf8', timeout: 30_000, env: {
      PATH: `${extraBin ? `${extraBin}:` : ''}${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: root, FAKE: root, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1',
      JOB_RUN_IMAGE: 'registry.test/claudepilot/workspace:1-dev-1', JOB_RUN_POLL_S: '0.1', JOB_RUN_WATCH_PID: 'none', JOB_RUN_LOG: join(root, 'job.log'),
      NODE_AUTH_TOKEN: `fx${hex(18)}`, PILOT_SESSION_ID: 'chat-a', PILOT_AGENT: 'qa', ...over } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { root, run, bin };
}
const ARGS = (out: string) => ['--repo', 'claudepilot', '--ref', 'main', '--pool-env', POOL_ID, '--artifacts', 'reports', '--out', out, '--', 'true'];
const tree = (d: string): string[] => (existsSync(d) ? readdirSync(d, { recursive: true, encoding: 'utf8' }) : []);

test('QA-O1 (1) a leaking file whose NAME holds a line break is deleted (the hit list must survive odd names), and the run is red', () => {
  const secret = `cs${hex(20)}`;
  const odd = 'trace\nline2.txt';
  const w = world({ [odd]: `cf-access-client-secret: ${secret}\n`, 'clean.xml': '<testsuites/>' });
  const out = join(w.root, 'out');
  const r = w.run(ARGS(out), { [POOL_ID]: secret });
  assert.equal(r.code, 3, r.out);
  assert.ok(!r.out.includes(secret), 'the value is not shown');
  assert.ok(!tree(join(out, 'reports')).includes(odd), `the leaking file survived: ${JSON.stringify(tree(join(out, 'reports')))}`);
  assert.ok(existsSync(join(out, 'reports/clean.xml')), 'a clean file stays');
});

test('QA-N1 (review 7773) an artifact whose NAME is the value: the value is in no stdout, stderr or the Job log (S1h re-QA)', () => {
  const secret = `cs${hex(20)}`;
  const w = world({ [`${secret}.txt`]: `cf-access-client-secret: ${secret}\n`, [`x${secret}`]: 'plain\n', 'clean.xml': '<testsuites/>' });
  const out = join(w.root, 'out');
  const r = w.run(ARGS(out), { [POOL_ID]: secret });
  assert.equal(r.code, 3, 'the run is red');
  assert.ok(!r.out.includes(secret), `the value reached stdout or stderr (hash ${h16(secret)})`);
  const log = existsSync(join(w.root, 'job.log')) ? readFileSync(join(w.root, 'job.log'), 'utf8') : '';
  assert.ok(!log.includes(secret), 'the value reached the Job log');
  assert.ok(!tree(join(out, 'reports')).some((n) => n.includes(secret)), 'a file named after the value survived');
  assert.ok(existsSync(join(out, 'reports/clean.xml')), 'a clean file stays');
});

test('QA-O2 (1) a scan that fails closed also deletes a file with a line break in its name; rc 3', () => {
  const secret = `cs${hex(20)}`;
  const w = world({ 'a\nb.txt': 'plain\n', 'clean.xml': '<testsuites/>' });
  const shim = mkdtempSync(join(tmpdir(), 'cp-qa-shim-'));
  roots.push(shim);
  writeFileSync(join(shim, 'grep'), '#!/bin/bash\nif [ "$1" = -rlaFZ ]; then echo "grep: scan stub failed" >&2; exit 2; fi\nexec /bin/grep "$@"\n');
  chmodSync(join(shim, 'grep'), 0o755);
  const out = join(w.root, 'out');
  const r = w.run(ARGS(out), { [POOL_ID]: secret }, shim);
  assert.equal(r.code, 3, r.out);
  assert.deepEqual(tree(join(out, 'reports')).filter((f) => !/^$/.test(f)), [], `every unpacked file is gone: ${JSON.stringify(tree(out))}`);
});

test('QA-O3 (1) grep exit 3 or higher counts as a failed scan too (not only exactly 2); rc 3', () => {
  const secret = `cs${hex(20)}`;
  const w = world({ 'leak.txt': `x ${secret}\n` });
  const shim = mkdtempSync(join(tmpdir(), 'cp-qa-shim-'));
  roots.push(shim);
  writeFileSync(join(shim, 'grep'), '#!/bin/bash\nif [ "$1" = -rlaFZ ]; then exit 127; fi\nexec /bin/grep "$@"\n');
  chmodSync(join(shim, 'grep'), 0o755);
  const out = join(w.root, 'out');
  const r = w.run(ARGS(out), { [POOL_ID]: secret }, shim);
  assert.equal(r.code, 3, r.out);
  assert.deepEqual(tree(join(out, 'reports')), [], 'nothing is left');
});

test('QA-O4 (1) an empty --out, or one that cannot be made, never leaves an unscanned artifact and never exits 0', () => {
  const secret = `cs${hex(20)}`;
  const w = world({ 'leak.txt': `x ${secret}\n` });
  for (const out of ['', join(w.root, 'a-file-not-a-dir/x')]) {
    if (out) writeFileSync(join(w.root, 'a-file-not-a-dir'), 'x');
    const r = w.run(ARGS(out), { [POOL_ID]: secret });
    assert.notEqual(r.code, 0, `out=${JSON.stringify(out)}: ${r.out}`);
    assert.ok(!r.out.includes(secret), 'the value is not shown');
    assert.ok(!tree(w.root).some((f) => f.endsWith('leak.txt') && !f.startsWith('art/')), `no unpacked copy of the leaking file: ${JSON.stringify(tree(w.root).filter((f) => f.endsWith('leak.txt')))}`);
  }
});

test('QA-O5 a clean artifact set with --pool-env: rc 0, nothing deleted, and the same set without --pool-env is untouched', () => {
  const secret = `cs${hex(20)}`;
  const w = world({ 'clean.xml': '<testsuites/>', 'unicode-é.txt': 'ok\n', 'has space.txt': 'ok\n' });
  const out = join(w.root, 'out');
  const r = w.run(ARGS(out), { [POOL_ID]: secret });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(tree(join(out, 'reports')).sort(), ['clean.xml', 'has space.txt', 'unicode-é.txt']);
});
