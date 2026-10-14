// scripts/job-run.sh (T-107): heavy agent work as a cluster Job, against a fake kubectl that keeps Jobs and Secrets in a JSON file and plays
// a Job's log. Nothing here reaches a cluster: the environment is built from scratch (no KUBECONFIG, no real tokens, the fakes first on PATH).
// The credentials are made at runtime and checked never to reach the output, the log file or a kubectl command line.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO, 'scripts/job-run.sh');
const TEMPLATE = join(REPO, 'deploy/k3s-build/job-run.yaml');
const roots: string[] = [];
const children: ChildProcess[] = [];
after(() => {
  children.forEach((c) => c.kill('SIGKILL'));
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
const k8s = (j) => ({ metadata: { name: j.name, uid: 'uid-' + j.name, creationTimestamp: '2026-01-01T00:' + String(Math.floor(j.seq / 60)).padStart(2, '0') + ':' + String(j.seq % 60).padStart(2, '0') + 'Z',
  labels: { app: 'claudepilot-job-run', 'job-run/chat': j.chat, 'job-run/role': j.role || 'agent' }, annotations: { 'job-run/owner': j.owner || '' } },
  spec: { suspend: j.suspend }, status: j.done ? { [j.rc === 0 ? 'succeeded' : 'failed']: 1, conditions: [{ type: j.rc === 0 ? 'Complete' : 'Failed', status: 'True', reason: j.reason }] } : {} });
const stdin = () => fs.readFileSync(0, 'utf8');
const job = (n) => read().jobs.find((j) => j.name === n);
const play = (n, follow) => {
  const sc = JSON.parse(fs.readFileSync(path.join(F, 'scenario.json'), 'utf8'));
  if (sc.hang && follow) { while (job(n)) sleep(50); process.exit(1); }
  const sec = read().secrets[n] || '';
  const tok = (sec.match(/^(?:node-auth-token|git-token)=(.*)$/m) || [])[1] || '';
  process.stdout.write(sc.log.replaceAll('{TOKEN}', tok));
  lock((s) => { const j = s.jobs.find((x) => x.name === n); if (j) { j.done = true; j.rc = sc.rc; } });
};
const [verb, kind, name] = a;
if (verb === 'get' && kind === 'jobs') { process.stdout.write(JSON.stringify({ items: read().jobs.map(k8s) })); }
else if (verb === 'get' && kind === 'job') { const j = job(name); if (!j) process.exit(1); process.stdout.write(a.includes('json') ? JSON.stringify(k8s(j)) : 'uid-' + name); }
else if (verb === 'get' && kind === 'pods') { const j = job(a[3].replace('job-name=', '')); const out = a.join(' ').includes('nodeName') ? 'k3s-master' : 'Running'; if (j && !j.suspend) process.stdout.write(out); }
else if (verb === 'create' && kind === 'secret') { const t = stdin(); lock((s) => { s.secrets[a[3]] = t; }); }
else if (verb === 'apply') { const m = stdin(); const n = m.match(/^ {2}name: (\S+)/m)[1]; fs.mkdirSync(path.join(F, 'applied'), { recursive: true }); fs.writeFileSync(path.join(F, 'applied', n + '.yaml'), m);
  const lab = (k) => m.match(new RegExp(k + ': ([^,}]+)'))[1].trim();
  lock((s) => { s.seq += 1; s.jobs.push({ name: n, chat: lab('job-run/chat'), role: lab('job-run/role'), owner: m.match(/job-run\/owner: "([^"]*)"/)[1], suspend: true, seq: s.seq }); }); }
else if (verb === 'patch' && kind === 'job') { lock((s) => { const j = s.jobs.find((x) => x.name === name); if (j) j.suspend = false; }); }
else if (verb === 'patch' && kind === 'secret') { /* recorded in calls.log */ }
else if (verb === 'delete' && kind === 'job') { lock((s) => { s.jobs = s.jobs.filter((j) => j.name !== name); }); }
else if (verb === 'delete' && kind === 'secret') { lock((s) => { delete s.secrets[name]; }); }
else if (verb === 'logs') { play(a.includes('-f') ? a[2].replace('job/', '') : a[1].replace('job/', ''), a.includes('-f')); }
else { process.stderr.write('unexpected kubectl ' + args.join(' ') + '\n'); process.exit(9); }
`;

interface Seed { name: string; chat: string; suspend?: boolean; done?: boolean; rc?: number; owner?: string }
interface Scenario { log?: string; rc?: number; hang?: boolean }

const hex = (n: number) => randomBytes(n).toString('hex');

/** A log like the Job's own: the command's output, an artifacts block (a real tar.gz made here), the summary and the exit line. */
function jobLog(root: string, rc: number, extra = '') {
  const art = join(root, 'art-src');
  mkdirSync(join(art, 'reports'), { recursive: true });
  writeFileSync(join(art, 'reports/junit.xml'), '<testsuites tests="1"/>');
  const tgz = spawnSync('tar', ['-czf', '-', '-C', art, 'reports']).stdout.toString('base64');
  return `=== JOB-RUN checked out claudepilot at abc1234 in 1s\nhello from the job\n${extra}=== JOB-RUN ARTIFACTS BEGIN\n${tgz}\n\n=== JOB-RUN ARTIFACTS END\n=== JOB-RUN SUMMARY claudepilot@abc1234 checkout=1s steps=2s run=3s rc=${rc} node=k3s-master\n=== JOB-RUN EXIT ${rc}\n`;
}

function world(seeds: Seed[] = [], scenario: Scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-jobrun-'));
  roots.push(root);
  const bin = join(root, 'bin'), home = join(root, 'home');
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL); chmodSync(join(bin, 'kubectl'), 0o755);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(root, 'state.json'), JSON.stringify({ seq: seeds.length, secrets: {}, jobs: seeds.map((s, i) => ({ suspend: false, ...s, seq: i })) }));
  const rc = scenario.rc ?? 0;
  writeFileSync(join(root, 'scenario.json'), JSON.stringify({ rc, hang: scenario.hang ?? false, log: scenario.log ?? jobLog(root, rc) }));
  // Runtime-made credentials (never literals): the npm token, and Gitea's through git's credential helper as the real script reads it.
  const npmToken = `fx${hex(18)}`, giteaToken = `gt${hex(18)}`;
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, `[credential "https://git.konfersi.com"]\n\thelper = "!f() { echo username=bot; echo password=${giteaToken}; }; f"\n`);
  const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: root, FAKE: root, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1',
    JOB_RUN_IMAGE: 'registry.test/claudepilot/workspace:1-dev-1', JOB_RUN_POLL_S: '0.1', JOB_RUN_WATCH_PID: 'none',
    JOB_RUN_LOG: join(root, 'job.log'), NODE_AUTH_TOKEN: npmToken, PILOT_SESSION_ID: 'chat-a', PILOT_AGENT: 't107', ...over,
  });
  const start = (argv: string[], over: Record<string, string> = {}) => {
    const p = spawn('bash', [SCRIPT, ...argv], { env: env(over), cwd: root });
    children.push(p);
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    const done = new Promise<{ code: number | null; out: string }>((res) => p.on('close', (code) => res({ code, out })));
    return { p, done, out: () => out };
  };
  const run = (argv: string[], over: Record<string, string> = {}) => {
    const r = spawnSync('bash', [SCRIPT, ...argv], { env: env(over), cwd: root, encoding: 'utf8', timeout: 30_000 });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const state = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { secrets: Record<string, string>; jobs: (Seed & { suspend: boolean })[] };
  const edit = (fn: (s: ReturnType<typeof state>) => void) => { const s = state(); fn(s); writeFileSync(join(root, 'state.json'), JSON.stringify(s)); };
  const calls = () => (existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8') : '');
  const applied = () => { const d = join(root, 'applied'); return existsSync(d) ? readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')) : []; };
  const applied1 = () => { const [m] = applied(); assert.ok(m, 'a manifest was applied'); return m; };
  return { root, npmToken, giteaToken, start, run, state, edit, calls, applied, applied1, log: () => readFileSync(join(root, 'job.log'), 'utf8') };
}

async function waitFor(what: string, cond: () => boolean, ms = 15_000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

type Manifest = { metadata: { name: string; labels: Record<string, string>; annotations: Record<string, string> }; spec: Record<string, unknown> & { template: { metadata: { labels: Record<string, string> }; spec: Record<string, unknown> & { containers: { image: string; env: { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }[]; resources: unknown; args: string[]; volumeMounts: unknown }[]; volumes: unknown } } } };
const container = (m: Manifest) => { const c = m.spec.template.spec.containers[0]; assert.ok(c); return c; };
const envOf = (m: Manifest) => Object.fromEntries(container(m).env.map((e) => [e.name, e.value ?? e.valueFrom]));

test('a run: the suspended Job manifest, the stream, the exit code, the artifacts, the Secret gone and the Job kept for its TTL', () => {
  const w = world([], { rc: 3 });
  const r = w.run(['--repo', 'claudepilot', '--ref', 'dev/t107-job-run', '--artifacts', 'reports', '--out', 'got', '--role', 'T107 Runner', '--', 'npm test -w @portal/server']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /hello from the job/);
  assert.match(r.out, /=== JOB-RUN SUMMARY claudepilot@abc1234 .* rc=3/);
  assert.match(r.out, /job-run: claudepilot-job-[0-9a-f]{8} rc=3 in \d+s \(queued \d+s\) on k3s-master; log: /);
  assert.doesNotMatch(r.out, /ARTIFACTS BEGIN/, 'the artifacts block is not shown');
  assert.equal(readFileSync(join(w.root, 'got/reports/junit.xml'), 'utf8'), '<testsuites tests="1"/>');
  assert.match(w.log(), /hello from the job/);

  const text = w.applied1();
  const m = yamlLoad(text) as Manifest;
  assert.match(m.metadata.name, /^claudepilot-job-[0-9a-f]{8}$/);
  assert.deepEqual(m.metadata.labels, { app: 'claudepilot-job-run', 'job-run/chat': 'chat-a', 'job-run/role': 't107-runner', 'job-run/repo': 'claudepilot' });
  assert.match(m.metadata.annotations['job-run/owner'] ?? '', new RegExp(`^${hostname()}/\\d+/\\d+$`));
  assert.equal(m.spec.suspend, true, 'created suspended: the queue lets it out');
  assert.equal(m.spec.backoffLimit, 0);
  assert.equal(m.spec.activeDeadlineSeconds, 3600);
  assert.equal(m.spec.ttlSecondsAfterFinished, 1800);
  const pod = m.spec.template.spec, c = container(m);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.match(JSON.stringify(pod.affinity), /"podAntiAffinity".*"namespaces":\["isnan-claudepilot-workspaces"\].*"claudepilot.managed":"true"/);
  assert.deepEqual(c.resources, { requests: { cpu: '1000m', memory: '2Gi' }, limits: { cpu: '4', memory: '8Gi' } });
  assert.deepEqual(pod.volumes, [{ name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '3Gi' } }, { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } }]);
  assert.equal(c.image, 'registry.test/claudepilot/workspace:1-dev-1');
  const e = envOf(m);
  assert.equal(e.JR_REPO_URL, 'https://github.com/alfianisnan26/claudepilot.git');
  assert.equal(e.JR_REF, 'dev/t107-job-run');
  assert.equal(e.JR_STEPS, 'npm-ci');
  assert.equal(e.JR_ARTIFACTS, 'reports');
  assert.equal(Buffer.from(String(e.JR_CMD), 'base64').toString(), 'npm test -w @portal/server');
  assert.deepEqual(e.NODE_AUTH_TOKEN, { secretKeyRef: { name: m.metadata.name, key: 'node-auth-token', optional: true } });
  assert.ok(!text.includes(w.npmToken), 'the token is not in the manifest');

  const calls = w.calls();
  assert.match(calls, new RegExp(`create secret generic ${m.metadata.name} --from-env-file=/dev/stdin`));
  assert.match(calls, /patch secret claudepilot-job-[0-9a-f]{8} --type merge -p .*"ownerReferences":\[\{"apiVersion":"batch\/v1","kind":"Job"/);
  assert.match(calls, /patch job claudepilot-job-[0-9a-f]{8} --type merge -p \{"spec":\{"suspend":false\}\}/);
  assert.match(calls, /delete secret claudepilot-job-/);
  assert.doesNotMatch(calls, /delete job /, 'a finished Job stays for its TTL');
  assert.deepEqual(w.state().secrets, {});
  assert.ok(!calls.includes(w.npmToken) && !r.out.includes(w.npmToken));
});

test('several words are one command, each quoted; the exit code 0 is passed on', () => {
  const w = world();
  const r = w.run(['--repo', 'claudepilot', '--ref', 'main', '--steps', 'none', '--', 'node', '--test', 'src/a b.test.ts']);
  assert.equal(r.code, 0, r.out);
  const e = envOf(yamlLoad(w.applied1()) as Manifest);
  assert.equal(Buffer.from(String(e.JR_CMD), 'base64').toString(), 'node --test src/a\\ b.test.ts ');
  assert.equal(e.JR_STEPS, 'none');
});

test('the token never reaches the output or the log: a Job that prints it is masked, and the run warns', () => {
  const w = world([], {});
  writeFileSync(join(w.root, 'scenario.json'), JSON.stringify({ rc: 0, log: jobLog(w.root, 0, 'npm http fetch authorization {TOKEN} and again {TOKEN}\n') }));
  const r = w.run(['--repo', 'claudepilot', '--ref', 'main', '--', 'npm ci']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes(w.npmToken), 'not in the output');
  assert.ok(!w.log().includes(w.npmToken), 'not in the log file');
  assert.ok(!w.calls().includes(w.npmToken), 'not on a kubectl command line');
  assert.match(r.out, /authorization \[redacted\] and again \[redacted\]/);
  assert.match(r.out, /WARNING: a credential was in the Job's log/);
});

test('Konfersi: from Gitea with the credential helper\'s token in the Secret (never on a command line), the shared repo next to it', () => {
  const w = world();
  writeFileSync(join(w.root, 'scenario.json'), JSON.stringify({ rc: 0, log: jobLog(w.root, 0, 'git said {TOKEN}\n') }));
  const r = w.run(['--repo', 'konfersi:platform/konfersi-backend', '--ref', 'work/x', '--also', 'platform/konfersi-shared', '--', 'npx vitest run src/a.test.ts']);
  assert.equal(r.code, 0, r.out);
  const m = yamlLoad(w.applied1()) as Manifest;
  const e = envOf(m);
  assert.equal(e.JR_REPO_URL, 'https://git.konfersi.com/platform/konfersi-backend.git');
  assert.equal(e.JR_ALSO, 'konfersi-shared=https://git.konfersi.com/platform/konfersi-shared.git@stg');
  assert.equal(m.metadata.labels['job-run/repo'], 'konfersi-backend');
  assert.deepEqual(e.GIT_TOKEN, { secretKeyRef: { name: m.metadata.name, key: 'git-token', optional: true } });
  for (const where of [r.out, w.log(), w.calls(), w.applied1()]) assert.ok(!where.includes(w.giteaToken));
  assert.match(r.out, /git said \[redacted\]/);
});

test('the cluster-wide cap: three running Jobs, the fourth says "queued behind 3" and starts when one ends', async () => {
  const w = world([{ name: 'claudepilot-job-00000001', chat: 'chat-x' }, { name: 'claudepilot-job-00000002', chat: 'chat-y' }, { name: 'claudepilot-job-00000003', chat: 'chat-z' }]);
  const s = w.start(['--repo', 'claudepilot', '--ref', 'main', '--', 'true']);
  await waitFor('the queue line', () => /queued behind 3 \(at most 3 at once, 2 per chat\)/.test(s.out()));
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(w.state().jobs.find((j) => j.name.startsWith('claudepilot-job-') && !/0000000\d$/.test(j.name))?.suspend, 'still suspended');
  w.edit((st) => { Object.assign(st.jobs[0] ?? {}, { done: true, rc: 0 }); });
  const r = await s.done;
  assert.equal(r.code, 0, r.out);
  assert.equal((r.out.match(/queued behind/g) ?? []).length, 1, 'said once, not every poll');
});

test('the per-chat cap: a chat with two running waits, another chat goes past it; the first goes when its own Job ends', async () => {
  const w = world([{ name: 'claudepilot-job-0000000a', chat: 'chat-a' }, { name: 'claudepilot-job-0000000b', chat: 'chat-a' }]);
  const a = w.start(['--repo', 'claudepilot', '--ref', 'main', '--', 'true'], { PILOT_SESSION_ID: 'chat-a' });
  await waitFor('chat-a queued', () => /queued behind 2/.test(a.out()));
  const b = await w.start(['--repo', 'claudepilot', '--ref', 'main', '--', 'true'], { PILOT_SESSION_ID: 'chat-b' }).done;
  assert.equal(b.code, 0, b.out);
  assert.doesNotMatch(b.out, /queued behind/, 'room cluster-wide: chat-b is not held up by chat-a\'s queued Job');
  assert.doesNotMatch(a.out(), /rc=/, 'chat-a still waits');
  w.edit((st) => { Object.assign(st.jobs[1] ?? {}, { done: true, rc: 0 }); });
  const r = await a.done;
  assert.equal(r.code, 0, r.out);
});

test('cleanup: interrupted while queued, the Job and its Secret are deleted', async () => {
  const w = world([1, 2, 3].map((i) => ({ name: `claudepilot-job-0000000${i}`, chat: 'chat-x' })));
  const s = w.start(['--repo', 'claudepilot', '--ref', 'main', '--', 'true'], { JOB_RUN_MAX_PER_CHAT: '5' });
  await waitFor('queued', () => /queued behind 3/.test(s.out()));
  s.p.kill('SIGTERM');
  const r = await s.done;
  assert.equal(r.code, 130, r.out);
  assert.deepEqual(w.state().jobs.map((j) => j.name).sort(), ['claudepilot-job-00000001', 'claudepilot-job-00000002', 'claudepilot-job-00000003']);
  assert.deepEqual(w.state().secrets, {});
});

test('cleanup: the chat ends (its Claude process exits) while the Job runs: the Job, its Secret and the script go', async () => {
  const w = world([], { hang: true });
  const claude = spawn('sleep', ['60']);
  children.push(claude);
  const s = w.start(['--repo', 'claudepilot', '--ref', 'main', '--', 'sleep 1000'], { JOB_RUN_WATCH_PID: String(claude.pid) });
  await waitFor('the Job running', () => w.state().jobs.some((j) => !j.suspend));
  claude.kill('SIGKILL');
  const r = await s.done;
  assert.notEqual(r.code, 0);
  assert.match(r.out, /the chat ended \(process \d+\): stopping claudepilot-job-/);
  assert.deepEqual(w.state().jobs, []);
  assert.deepEqual(w.state().secrets, {});
});

test('cleanup: a Job whose script is gone (killed before its trap) is removed by the next run; another host\'s is left alone', () => {
  const w = world([
    { name: 'claudepilot-job-dead0001', chat: 'chat-a', owner: `${hostname()}/999999999/1` },
    { name: 'claudepilot-job-0be10002', chat: 'chat-a', owner: 'other-host/1/1' },
  ]);
  const r = w.run(['--repo', 'claudepilot', '--ref', 'main', '--', 'true']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /removed claudepilot-job-dead0001 \(its job-run\.sh is gone\)/);
  assert.deepEqual(w.state().jobs.map((j) => j.name).filter((n) => /0001$|0002$/.test(n)), ['claudepilot-job-0be10002']);
});

test('--list and --stop: a chat\'s Jobs stop, the others stay', () => {
  const w = world([{ name: 'claudepilot-job-0000000a', chat: 'chat-a' }, { name: 'claudepilot-job-0000000b', chat: 'chat-b', suspend: true }]);
  assert.match(w.run(['--list']).out, /claudepilot-job-0000000b\tchat-b\tagent\tqueued/);
  const r = w.run(['--stop', '--chat', 'chat-a']);
  assert.match(r.out, /stopped claudepilot-job-0000000a\n1 job\(s\) stopped/);
  assert.deepEqual(w.state().jobs.map((j) => j.name), ['claudepilot-job-0000000b']);
  assert.match(w.run(['--stop', 'nope; rm -rf /']).out, /usage/);
});

test('usage errors: nothing is created', () => {
  const w = world();
  const cases: [string[], RegExp][] = [
    [['--repo', 'claudepilot', '--ref', 'main'], /usage/],
    [['--repo', 'claudepilot', '--ref', 'a b', '--', 'x'], /--ref: a branch or commit/],
    [['--repo', 'claudepilot', '--ref', '../x', '--', 'x'], /--ref: a branch or commit/],
    [['--repo', 'claudepilot', '--ref', 'main', '--artifacts', '../etc', '--', 'x'], /--artifacts: paths inside/],
    [['--repo', 'claudepilot', '--ref', 'main', '--timeout', '99999', '--', 'x'], /--timeout/],
    [['--repo', 'konfersi:x', '--ref', 'main', '--', 'x'], /--repo konfersi:<org>\/<repo>/],
    [['--repo', 'claudepilot', '--', 'x'], /--ref: the current folder is not a checkout/],
    [['--repo', 'gitlab', '--ref', 'main', '--', 'x'], /--repo: claudepilot or konfersi/],
  ];
  for (const [argv, re] of cases) {
    const r = w.run(argv);
    assert.equal(r.code, 2, `${argv.join(' ')}: ${r.out}`);
    assert.match(r.out, re);
  }
  assert.equal(w.calls(), '');
});

test('the Job\'s own script: checkout, the command\'s exit code, the artifacts block; a ref not on the remote says push it first', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-jobrun-pod-'));
  roots.push(root);
  const git = (args: string[], cwd: string) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  mkdirSync(join(root, 'src'));
  git(['init', '-q', '-b', 'main'], join(root, 'src'));
  writeFileSync(join(root, 'src/README'), 'x');
  git(['add', '.'], join(root, 'src'));
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one'], join(root, 'src'));
  git(['clone', '-q', '--bare', join(root, 'src'), join(root, 'claudepilot.git')], root);
  const tpl = readFileSync(TEMPLATE, 'utf8');
  const body = tpl.slice(tpl.indexOf('# JOB-RUN-SCRIPT BEGIN'), tpl.indexOf('# JOB-RUN-SCRIPT END')).replace(/^ {14}/gm, '');
  const pod = (ref: string, cmd: string) => spawnSync('bash', ['-c', body], { encoding: 'utf8', env: {
    PATH: process.env.PATH, JR_ROOT: join(root, `run-${hex(3)}`), JR_REPO_URL: `file://${join(root, 'claudepilot.git')}`, JR_REF: ref, JR_ALSO: '',
    JR_STEPS: 'none', JR_ARTIFACTS: 'out', JR_ARTIFACT_MAX: '100000', JR_CMD: Buffer.from(cmd).toString('base64'), NODE_NAME: 'k3s-master' } });
  const r = pod('main', 'mkdir -p out && echo report > out/r.txt && echo ran in $(basename $PWD); exit 3');
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /ran in claudepilot\n/);
  assert.match(r.stdout, /=== JOB-RUN ARTIFACTS BEGIN\n[A-Za-z0-9+/=\n]+=== JOB-RUN ARTIFACTS END\n/);
  assert.match(r.stdout, /=== JOB-RUN SUMMARY claudepilot@[0-9a-f]+ checkout=\d+s steps=\d+s run=\d+s rc=3 node=k3s-master\n=== JOB-RUN EXIT 3\n$/);
  const b64 = (r.stdout.split('=== JOB-RUN ARTIFACTS BEGIN\n')[1] ?? '').split('=== JOB-RUN ARTIFACTS END')[0]?.replace(/\s/g, '') ?? '';
  const list = spawnSync('tar', ['-tzf', '-'], { input: Buffer.from(b64, 'base64'), encoding: 'utf8' }).stdout;
  assert.match(list, /out\/r\.txt/);
  const missing = pod('no-such-branch', 'true');
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /=== JOB-RUN EXIT 2\njob-run: no-such-branch of .* is not on the remote \(push it first\)/);
});

test('--against and --keep-tests: parsed into the manifest, validated; absent, the manifest carries nothing', () => {
  const w = world();
  assert.equal(w.run(['--repo', 'claudepilot', '--ref', 'main', '--', 'true']).code, 0);
  const none = envOf(yamlLoad(w.applied1()) as Manifest);
  assert.equal(none.JR_AGAINST, '');
  assert.equal(none.JR_KEEP, '');
  const w2 = world();
  const r = w2.run(['--repo', 'claudepilot', '--ref', 'dev/x', '--against', 'abc1234def', '--keep-tests', 'a/x.test.ts,b/y.test.ts', '--', 'true']);
  assert.equal(r.code, 0, r.out);
  const e = envOf(yamlLoad(w2.applied1()) as Manifest);
  assert.equal(e.JR_AGAINST, 'abc1234def');
  assert.equal(e.JR_KEEP, 'a/x.test.ts b/y.test.ts');
  const bad: [string[], RegExp][] = [
    [['--against', 'a b'], /--against: a branch or commit/],
    [['--against', 'x..y'], /--against: a branch or commit/],
    [['--keep-tests', 'a.ts'], /--keep-tests needs --against/],
    [['--against', 'main', '--keep-tests', '../x'], /--keep-tests: file paths/],
  ];
  const w3 = world();
  for (const [argv, re] of bad) {
    const x = w3.run(['--repo', 'claudepilot', '--ref', 'main', ...argv, '--', 'true']);
    assert.equal(x.code, 2, x.out);
    assert.match(x.out, re);
  }
  assert.equal(w3.calls(), '');
});

test('the Job\'s own script: the proof (passes on the ref, fails on the other, kept test files), no proof, a missing ref; npm ci retried once', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-jobrun-proof-'));
  roots.push(root);
  const env0 = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args: string[], cwd: string) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', env: env0 });
  const src = join(root, 'src');
  mkdirSync(src);
  git(['init', '-q', '-b', 'main'], src);
  writeFileSync(join(src, 'value.txt'), 'old');
  writeFileSync(join(src, 'package-lock.json'), '{}');
  git(['add', '.'], src); git(['commit', '-qm', 'old'], src);
  const oldSha = git(['rev-parse', 'HEAD'], src).stdout.trim();
  // The fix: the source changes, and the test file arrives with it.
  writeFileSync(join(src, 'value.txt'), 'new');
  writeFileSync(join(src, 'check.sh'), 'test "$(cat value.txt)" = new\n');
  git(['add', '.'], src); git(['commit', '-qm', 'fix'], src);
  git(['clone', '-q', '--bare', src, join(root, 'claudepilot.git')], root);
  const tpl = readFileSync(TEMPLATE, 'utf8');
  const body = tpl.slice(tpl.indexOf('# JOB-RUN-SCRIPT BEGIN'), tpl.indexOf('# JOB-RUN-SCRIPT END')).replace(/^ {14}/gm, '');
  // A fake npm that fails until it has been called NPM_FAIL_UNTIL times (a flake), and counts its calls.
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho x >> "${root}/npm.calls"\n[ "$(wc -l < "${root}/npm.calls")" -ge "\${NPM_FAIL_UNTIL:-2}" ] || exit 7\nmkdir -p node_modules\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  const pod = (over: Record<string, string>) => {
    rmSync(join(root, 'npm.calls'), { force: true });
    return spawnSync('bash', ['-c', body], { encoding: 'utf8', env: {
      PATH: `${bin}:${process.env.PATH}`, JR_ROOT: join(root, `run-${hex(3)}`), JR_REPO_URL: `file://${join(root, 'claudepilot.git')}`, JR_REF: 'main', JR_ALSO: '',
      JR_STEPS: 'none', JR_ARTIFACTS: '', JR_ARTIFACT_MAX: '1', JR_CMD: Buffer.from('bash check.sh').toString('base64'), NODE_NAME: 'k3s-master', ...over } });
  };
  const text = (r: ReturnType<typeof pod>) => r.stdout + r.stderr;

  const ok = pod({ JR_AGAINST: oldSha, JR_KEEP: 'check.sh' });
  assert.equal(ok.status, 0, text(ok));
  assert.match(ok.stdout, /SUMMARY claudepilot@[0-9a-f]+ .* rc=0/);
  assert.match(ok.stdout, /SUMMARY-AGAINST claudepilot@[0-9a-f]+ tests-from=[0-9a-f]+ kept=check.sh run=\d+s rc=1/);
  assert.match(ok.stdout, /=== JOB-RUN PROOF: passes on main \([0-9a-f]+\), fails on [0-9a-f]{40} \([0-9a-f]+\) \(rc=1\)\n=== JOB-RUN EXIT 0\n$/);

  const same = pod({ JR_AGAINST: 'main', JR_KEEP: 'check.sh' });
  assert.equal(same.status, 1, text(same));
  assert.match(same.stdout, /PROOF: NO PROOF: it passes on both main/);

  const failing = pod({ JR_CMD: Buffer.from('false').toString('base64'), JR_AGAINST: oldSha });
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /PROOF: NO PROOF: it fails on main \([0-9a-f]+\) already \(rc=1\)/);

  const missing = pod({ JR_AGAINST: 'no-such-branch' });
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /PROOF: NO PROOF: no-such-branch is not on the remote.*\n=== JOB-RUN EXIT 2\n$/);
  const nokeep = pod({ JR_AGAINST: oldSha, JR_KEEP: 'nope.test.ts' });
  assert.equal(nokeep.status, 2);
  assert.match(nokeep.stdout, /NO PROOF: kept test path not at main: nope.test.ts/);

  const plain = pod({});
  assert.equal(plain.status, 0, text(plain));
  assert.doesNotMatch(plain.stdout, /PROOF|SUMMARY-AGAINST/, 'without --against the output is the old one');

  // npm ci: the first call fails, the retry passes and says so; two failures end the Job with npm's code.
  const retry = pod({ JR_STEPS: 'npm-ci', NPM_FAIL_UNTIL: '2' });
  assert.equal(retry.status, 0, text(retry));
  assert.match(retry.stdout, /npm ci failed in claudepilot \(rc=7\); retrying once\n=== JOB-RUN npm ci passed on the retry in claudepilot/);
  const dead = pod({ JR_STEPS: 'npm-ci', NPM_FAIL_UNTIL: '9' });
  assert.equal(dead.status, 7);
  assert.match(dead.stdout, /retrying once[\s\S]*npm ci failed in claudepilot \(rc=7\)\n=== JOB-RUN EXIT 7\n$/);
});
