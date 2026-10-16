// QA lane (perf and security) probes for T-731 (`job-run.sh --reuse`). Test code only, on the QA branch; the fake kubectl harness is a copy of the one in
// jobRun.test.ts (it is not exported). Probes are the QA lane's own: the builder's tests are not repeated. Nothing here reaches a cluster.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO, 'scripts/job-run.sh');
const TEMPLATE = join(REPO, 'deploy/k3s-build/job-run.yaml');
const roots: string[] = [];
const children: ChildProcess[] = [];
after(() => {
  children.forEach((c) => c.kill('SIGKILL'));
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});

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
  if (sc.hang && follow) { while (job(n)) sleep(50); process.exit(1); }
  const sec = read().secrets[n] || '';
  const tok = (sec.match(/^(?:node-auth-token|git-token)=(.*)$/m) || [])[1] || '';
  process.stdout.write(sc.log.replaceAll('{TOKEN}', tok));
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
else if (verb === 'create' && kind === 'secret') { const t = stdin(); lock((s) => { s.secrets[a[3]] = t; }); }
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

const hex = (n: number) => randomBytes(n).toString('hex');
const sha = () => hex(20);

function jobLog(rc: number, extra = '') {
  return `=== JOB-RUN checked out claudepilot at abc1234 in 1s\nhello from the job\n${extra}=== JOB-RUN SUMMARY claudepilot@abc1234 checkout=1s steps=2s run=3s rc=${rc} node=k3s-master\n=== JOB-RUN EXIT ${rc}\n`;
}

function world(scenario: { rc?: number; log?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-qa-reuse-'));
  roots.push(root);
  const bin = join(root, 'bin'), home = join(root, 'home');
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL); chmodSync(join(bin, 'kubectl'), 0o755);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(root, 'state.json'), JSON.stringify({ seq: 0, secrets: {}, jobs: [] }));
  const rc = scenario.rc ?? 0;
  writeFileSync(join(root, 'scenario.json'), JSON.stringify({ rc, hang: false, log: scenario.log ?? jobLog(rc) }));
  const npmToken = `fx${hex(18)}`, giteaToken = `gt${hex(18)}`;
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, `[credential "https://git.konfersi.com"]\n\thelper = "!f() { echo username=bot; echo password=${giteaToken}; }; f"\n`);
  const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: root, FAKE: root, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1',
    JOB_RUN_IMAGE: 'registry.test/claudepilot/workspace:1-dev-1', JOB_RUN_POLL_S: '0.1', JOB_RUN_WATCH_PID: 'none',
    JOB_RUN_LOG: join(root, 'job.log'), NODE_AUTH_TOKEN: npmToken, PILOT_SESSION_ID: 'chat-a', PILOT_AGENT: 'qa', ...over,
  });
  const run = (argv: string[], over: Record<string, string> = {}, script = SCRIPT) => {
    const r = spawnSync('bash', [script, ...argv], { env: env(over), cwd: root, encoding: 'utf8', timeout: 30_000 });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const start = (argv: string[], over: Record<string, string> = {}) => {
    const p = spawn('bash', [SCRIPT, ...argv], { env: env(over), cwd: root });
    children.push(p);
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    return new Promise<{ code: number | null; out: string }>((res) => p.on('close', (code) => res({ code, out })));
  };
  const applied = () => { const d = join(root, 'applied'); return existsSync(d) ? readdirSync(d).length : 0; };
  return { root, home, npmToken, run, start, jobs: applied };
}
type W = ReturnType<typeof world>;

const argvOf = (ref: string, cmd: string, extra: string[] = []) => ['--repo', 'claudepilot', '--reuse', '--ref', ref, ...extra, '--', cmd];
const go = (w: W, ref: string, cmd: string, extra: string[] = [], script = SCRIPT, env: Record<string, string> = {}) => w.run(argvOf(ref, cmd, extra), env, script);
const store = (w: W) => join(w.home, '.cache/claudepilot-job-run');
const files = (w: W, ext: string) => (existsSync(store(w)) ? readdirSync(store(w)).filter((f) => f.endsWith(ext)) : []);
const age = (w: W, days: number) => { const t = new Date(Date.now() - days * 86_400_000); for (const f of readdirSync(store(w))) utimesSync(join(store(w), f), t, t); };
const reused = (o: string) => /reused a passed result/.test(o);

function mutant(editScript: (s: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-qa-mut-'));
  roots.push(dir);
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'deploy/k3s-build'), { recursive: true });
  writeFileSync(join(dir, 'deploy/k3s-build/job-run.yaml'), readFileSync(TEMPLATE, 'utf8'));
  writeFileSync(join(dir, 'scripts/job-run.sh'), editScript(readFileSync(SCRIPT, 'utf8')));
  return join(dir, 'scripts/job-run.sh');
}
const cut = (from: string, to: string) => (s: string) => {
  assert.ok(s.includes(from), `the mutation applies: ${from}`);
  return s.replace(from, to);
};

test('QA1 a forged pair is trusted (the documented boundary: whoever writes the store decides); the hit names Job "unknown" when the .job file is missing', () => {
  const w = world();
  const c = sha();
  assert.equal(go(w, c, 'npm test').code, 0);
  const [rc] = files(w, '.rc');
  const key = rc!.replace(/\.rc$/, '');
  writeFileSync(join(store(w), `${key}.log`), 'FORGED log line\n');
  rmSync(join(store(w), `${key}.job`));
  const r = go(w, c, 'npm test');
  assert.equal(r.code, 0, r.out);
  assert.ok(reused(r.out), r.out);
  assert.match(r.out, /FORGED log line/);
  assert.match(r.out, /from Job unknown/);
  assert.equal(w.jobs(), 1, 'no second Job: the forged entry was served');
});

test('QA2 a damaged store is a miss, never a pass: rc 1, rc junk, rc missing, log empty; the run then saves a real pass', () => {
  const w = world();
  const c = sha();
  assert.equal(go(w, c, 'npm test').code, 0);
  const key = files(w, '.rc')[0]!.replace(/\.rc$/, '');
  const rcf = join(store(w), `${key}.rc`), logf = join(store(w), `${key}.log`);
  let n = 1;
  for (const [what, damage] of [
    ['rc is 1', () => writeFileSync(rcf, '1\n')],
    ['rc is junk', () => writeFileSync(rcf, 'x0\n')],
    ['rc is missing', () => rmSync(rcf)],
    ['log is empty', () => { writeFileSync(rcf, '0\n'); writeFileSync(logf, ''); }],
  ] as const) {
    damage();
    const r = go(w, c, 'npm test');
    assert.equal(r.code, 0, `${what}: ${r.out}`);
    assert.ok(!reused(r.out), `${what}: not reused`);
    assert.equal(w.jobs(), ++n, `${what}: a Job ran`);
    assert.match(r.out, /result saved for reuse/, `${what}: the real pass replaced it`);
  }
  assert.ok(reused(go(w, c, 'npm test').out), 'and the repaired entry is a hit');
  assert.deepEqual(readdirSync(store(w)).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');
});

test('QA3 the age limit: 6.9 days is a hit, 7.1 days a miss; JOB_RUN_REUSE_MAX_AGE_DAYS=0 never hits; a non-number dies with exit 2 before any Job, and only with --reuse', () => {
  const w = world();
  const c = sha();
  assert.equal(go(w, c, 'npm test').code, 0);
  age(w, 6.9);
  assert.ok(reused(go(w, c, 'npm test').out), '6.9 days');
  age(w, 7.1);
  assert.ok(!reused(go(w, c, 'npm test').out), '7.1 days');
  const before = w.jobs();
  const zero = go(w, c, 'npm test', [], SCRIPT, { JOB_RUN_REUSE_MAX_AGE_DAYS: '0' });
  assert.ok(!reused(zero.out), 'zero days: never a hit');
  assert.equal(w.jobs(), before + 1);
  const bad = go(w, c, 'npm test', [], SCRIPT, { JOB_RUN_REUSE_MAX_AGE_DAYS: 'abc' });
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /JOB_RUN_REUSE_MAX_AGE_DAYS is a number/);
  assert.equal(w.jobs(), before + 1, 'no Job for a bad value');
  const plain = w.run(['--repo', 'claudepilot', '--ref', c, '--', 'npm test'], { JOB_RUN_REUSE_MAX_AGE_DAYS: 'abc' });
  assert.equal(plain.code, 0, `without --reuse the value is not read: ${plain.out}`);
});

test('QA4 the command is exact: a trailing space or another quoting is a different key (a miss, no false hit)', () => {
  const w = world();
  const c = sha();
  assert.equal(go(w, c, 'npm test').code, 0);
  for (const [i, cmd] of ['npm test ', 'npm  test', "npm 'test'"].entries()) {
    const r = go(w, c, cmd);
    assert.ok(!reused(r.out), cmd);
    assert.equal(w.jobs(), i + 2, cmd);
  }
});

test('QA5 a store that is a symlink to the home folder is refused (exit 2, no Job); a store under a plain file runs the Job, says it could not save, and returns the Job\'s own code', () => {
  const w = world();
  const link = join(w.root, 'store-link');
  symlinkSync(w.home, link);
  const r = go(w, sha(), 'npm test', [], SCRIPT, { JOB_RUN_CACHE_DIR: link });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /must be a folder of its own/);
  assert.equal(w.jobs(), 0);
  const file = join(w.root, 'a-plain-file');
  writeFileSync(file, 'x');
  const u = go(w, sha(), 'npm test', [], SCRIPT, { JOB_RUN_CACHE_DIR: join(file, 'sub') });
  assert.equal(u.code, 0, u.out);
  assert.match(u.out, /could not save the result for reuse/);
  assert.equal(w.jobs(), 1);
  const bad = world({ rc: 3 });
  const f = go(bad, sha(), 'npm test', [], SCRIPT, { JOB_RUN_CACHE_DIR: join(file, 'sub') });
  assert.equal(f.code, 3, 'the failure code is not changed by the store');
});

test('QA6 the store is private when it is new (mode 700), and holds exactly .log, .rc, .job of the key', () => {
  const w = world();
  assert.equal(go(w, sha(), 'npm test').code, 0);
  const mode = (spawnSync('stat', ['-c', '%a', store(w)], { encoding: 'utf8' }).stdout ?? '').trim();
  assert.equal(mode, '700');
  assert.deepEqual(readdirSync(store(w)).map((f) => f.replace(/^[0-9a-f]{64}/, 'K')).sort(), ['K.job', 'K.log', 'K.rc']);
});

test('QA7 three runs of one key at the same time: every one exits 0, and a later hit returns a complete log (no .tmp, ends with the exit line)', async () => {
  const w = world();
  const c = sha();
  const rs = await Promise.all([1, 2, 3].map((i) => w.start(argvOf(c, 'npm test'), { PILOT_SESSION_ID: `chat-${i}` })));
  for (const r of rs) assert.equal(r.code, 0, r.out);
  assert.deepEqual(readdirSync(store(w)).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');
  const hit = go(w, c, 'npm test');
  assert.ok(reused(hit.out), hit.out);
  assert.match(hit.out, /=== JOB-RUN EXIT 0\s*$/);
  assert.match(hit.out, /hello from the job/);
});

// Mutants of the real script: each detector must say "the check would let it through" only on the mutant.
test('QA8 mutant: without the leak conditions a log that held the credential is saved', () => {
  const leaks = (script: string) => {
    const w = world({ log: jobLog(0, 'authorization {TOKEN}\n') });
    const r = go(w, sha(), 'npm test', [], script);
    assert.ok(!r.out.includes(w.npmToken));
    return files(w, '.rc').length > 0;
  };
  assert.equal(leaks(SCRIPT), false, 'the real script saves nothing');
  assert.equal(leaks(mutant(cut(' && [ -f "$work/n" ] && ! grep -qx leak "$work/n"', ''))), true, 'the mutant saves a leaking log: the probe catches it');
});

test('QA9 mutant: without the rc check on a hit a store entry with rc 1 is served as a pass', () => {
  const served = (script: string) => {
    const w = world();
    const c = sha();
    go(w, c, 'npm test', [], script);
    writeFileSync(join(store(w), files(w, '.rc')[0]!), '1\n');
    return reused(go(w, c, 'npm test', [], script).out);
  };
  assert.equal(served(SCRIPT), false);
  assert.equal(served(mutant(cut(' && [ "$(cat "$cache/$key.rc" 2>/dev/null)" = 0 ]', ''))), true);
});

test('QA10 mutant: without the age test an 8-day-old entry is served; without the command in the key another command is served', () => {
  const old = (script: string) => {
    const w = world();
    const c = sha();
    go(w, c, 'npm test', [], script);
    age(w, 8);
    return reused(go(w, c, 'npm test', [], script).out);
  };
  assert.equal(old(SCRIPT), false);
  assert.equal(old(mutant(cut(' && [ -n "$(find "$cache/$key.log" -mmin "-$((reuse_days * 1440))" 2>/dev/null)" ]', ''))), true, 'age mutant caught');
  const other = (script: string) => {
    const w = world();
    const c = sha();
    go(w, c, 'npm test', [], script);
    return reused(go(w, c, 'npm run lint', [], script).out);
  };
  assert.equal(other(SCRIPT), false);
  assert.equal(other(mutant(cut('"$ref" "$cmd" "$against"', '"$ref" "$against"'))), true, 'command mutant caught');
});
