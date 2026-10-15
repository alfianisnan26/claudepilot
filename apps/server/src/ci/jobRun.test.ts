// scripts/job-run.sh (T-107): heavy agent work as a cluster Job, against a fake kubectl that keeps Jobs and Secrets in a JSON file and plays
// a Job's log. Nothing here reaches a cluster: the environment is built from scratch (no KUBECONFIG, no real tokens, the fakes first on PATH).
// The credentials are made at runtime and checked never to reach the output, the log file or a kubectl command line.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';
import { runPod } from './jobRunTestkit.js';

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
// The Job's pod: Pending with the scheduler's message while the file "pending" holds one; at the end OOMKilled or Evicted as the scenario says.
const podOf = (j) => {
  if (!j || j.suspend) return { items: [] };
  const pf = path.join(F, 'pending');
  if (fs.existsSync(pf)) return { items: [{ spec: {}, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: fs.readFileSync(pf, 'utf8') }] } }] };
  const sc = JSON.parse(fs.readFileSync(path.join(F, 'scenario.json'), 'utf8'));
  const status = { phase: j.done ? (j.rc === 0 ? 'Succeeded' : 'Failed') : 'Running' };
  if (j.done && sc.oom) status.containerStatuses = [{ name: 'run', state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }];
  if (j.done && sc.evicted) Object.assign(status, { reason: 'Evicted', message: sc.evicted });
  return { items: [{ spec: { nodeName: 'k3s-master' }, status }] };
};
const [verb, kind, name] = a;
if (verb === 'get' && kind === 'jobs') { process.stdout.write(JSON.stringify({ items: read().jobs.map(k8s) })); }
else if (verb === 'get' && kind === 'job') { const j = job(name); if (!j) process.exit(1); process.stdout.write(a.includes('json') ? JSON.stringify(k8s(j)) : 'uid-' + name); }
else if (verb === 'get' && kind === 'pods' && a.includes('json')) { process.stdout.write(JSON.stringify(podOf(job(a[3].replace('job-name=', ''))))); }
else if (verb === 'create' && kind === 'secret') { const t = stdin(); lock((s) => { s.secrets[a[3]] = t; }); }
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

interface Seed { name: string; chat: string; suspend?: boolean; done?: boolean; rc?: number; owner?: string; program?: string; repo?: string }
interface Scenario { log?: string; rc?: number; hang?: boolean; oom?: boolean; evicted?: string; reason?: string }

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
  writeFileSync(join(root, 'scenario.json'), JSON.stringify({ ...scenario, rc, hang: scenario.hang ?? false, log: scenario.log ?? jobLog(root, rc) }));
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

type Container = { image: string; env: { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }[]; resources: unknown; args: string[]; volumeMounts: unknown };
type Manifest = { metadata: { name: string; labels: Record<string, string>; annotations: Record<string, string> }; spec: Record<string, unknown> & { template: { metadata: { labels: Record<string, string> }; spec: Record<string, unknown> & { initContainers?: Container[]; containers: Container[]; volumes: unknown } } } };
const container = (m: Manifest) => { const c = m.spec.template.spec.containers[0]; assert.ok(c); return c; };
const envOf = (m: Manifest) => Object.fromEntries(container(m).env.map((e) => [e.name, e.value ?? e.valueFrom]));
/** T-401: the credentials are in the init container `fetch` alone. */
const fetchEnvOf = (m: Manifest) => { const c = m.spec.template.spec.initContainers?.[0]; assert.ok(c, 'the fetch init container'); return Object.fromEntries(c.env.map((e) => [e.name, e.value ?? e.valueFrom])); };

test('a run: the suspended Job manifest, the stream, the exit code, the artifacts, the Secret gone and the Job kept for its TTL', () => {
  const w = world([], { rc: 3 });
  const r = w.run(['--repo', 'claudepilot', '--ref', 'dev/t107-job-run', '--artifacts', 'reports', '--out', 'got', '--role', 'T107 Runner', '--', 'npm test -w @portal/server']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /hello from the job/);
  assert.match(r.out, /=== JOB-RUN SUMMARY claudepilot@abc1234 .* rc=3/);
  assert.match(r.out, /job-run: claudepilot-job-[0-9a-f]{8} rc=3 in \d+s \(queued \d+s\) on k3s-master with 4Gi; log: /);
  assert.doesNotMatch(r.out, /OOM|Pending|evicted/, 'a plain failure is not reported as memory');
  assert.doesNotMatch(r.out, /ARTIFACTS BEGIN/, 'the artifacts block is not shown');
  assert.equal(readFileSync(join(w.root, 'got/reports/junit.xml'), 'utf8'), '<testsuites tests="1"/>');
  assert.match(w.log(), /hello from the job/);

  const text = w.applied1();
  const m = yamlLoad(text) as Manifest;
  assert.match(m.metadata.name, /^claudepilot-job-[0-9a-f]{8}$/);
  assert.deepEqual(m.metadata.labels, { app: 'claudepilot-job-run', 'job-run/chat': 'chat-a', 'job-run/role': 't107-runner', 'job-run/repo': 'claudepilot', 'job-run/program': 'claudepilot' });
  assert.match(m.metadata.annotations['job-run/owner'] ?? '', new RegExp(`^${hostname()}/\\d+/\\d+$`));
  assert.equal(m.spec.suspend, true, 'created suspended: the queue lets it out');
  assert.equal(m.spec.backoffLimit, 0);
  assert.equal(m.spec.activeDeadlineSeconds, 3600);
  assert.equal(m.spec.ttlSecondsAfterFinished, 1800);
  const pod = m.spec.template.spec, c = container(m);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.match(JSON.stringify(pod.affinity), /"podAntiAffinity".*"namespaces":\["isnan-claudepilot-workspaces"\].*"claudepilot.managed":"true"/);
  // T-524: memory requested = limited, so the scheduler only places the Job where all of it fits; /tmp (in memory) inside that limit.
  assert.deepEqual(c.resources, { requests: { cpu: '1000m', memory: '4Gi' }, limits: { cpu: '4', memory: '4Gi' } });
  // T-401: fetch-home holds the fetch container's credential helper and .npmrc; the run container never mounts it.
  assert.deepEqual(pod.volumes, [{ name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '2Gi' } }, { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } }, { name: 'fetch-home', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } }]);
  assert.ok(!JSON.stringify(c.volumeMounts).includes('fetch-home'), 'T-401: the run container does not mount the fetch home');
  assert.ok(!/__[A-Z_]+__/.test(text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')), 'every placeholder is filled');
  assert.equal(c.image, 'registry.test/claudepilot/workspace:1-dev-1');
  const e = envOf(m);
  assert.equal(e.JR_REPO_URL, 'https://github.com/alfianisnan26/claudepilot.git');
  assert.equal(e.JR_REF, 'dev/t107-job-run');
  assert.equal(e.JR_STEPS, 'npm-ci');
  assert.equal(e.JR_ARTIFACTS, 'reports');
  assert.equal(Buffer.from(String(e.JR_CMD), 'base64').toString(), 'npm test -w @portal/server');
  assert.equal(e.NODE_AUTH_TOKEN, undefined, 'T-401: no credential in the run container');
  assert.deepEqual(fetchEnvOf(m).NODE_AUTH_TOKEN, { secretKeyRef: { name: m.metadata.name, key: 'node-auth-token', optional: true } });
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
  assert.equal(e.GIT_TOKEN, undefined, 'T-401: no credential in the run container');
  assert.deepEqual(fetchEnvOf(m).GIT_TOKEN, { secretKeyRef: { name: m.metadata.name, key: 'git-token', optional: true } });
  for (const where of [r.out, w.log(), w.calls(), w.applied1()]) assert.ok(!where.includes(w.giteaToken));
  assert.match(r.out, /git said \[redacted\]/);
});

test('T-491 Event: exactly GitHub isnanme/event, the GitHub token as npm token and git credential in the Secret (never on a command line)', () => {
  const w = world();
  writeFileSync(join(w.root, 'scenario.json'), JSON.stringify({ rc: 0, log: jobLog(w.root, 0, 'npm said {TOKEN}\n') }));
  const r = w.run(['--repo', 'event', '--ref', 'main', '--', 'npm run check']);
  assert.equal(r.code, 0, r.out);
  const text = w.applied1();
  const m = yamlLoad(text) as Manifest;
  const e = envOf(m);
  assert.equal(e.JR_REPO_URL, 'https://github.com/isnanme/event.git');
  assert.equal(m.metadata.labels['job-run/repo'], 'event');
  assert.equal(e.NODE_AUTH_TOKEN ?? e.GIT_TOKEN, undefined, 'T-401: no credential in the run container');
  const f = fetchEnvOf(m);
  assert.deepEqual(f.NODE_AUTH_TOKEN, { secretKeyRef: { name: m.metadata.name, key: 'node-auth-token', optional: true } });
  assert.deepEqual(f.GIT_TOKEN, { secretKeyRef: { name: m.metadata.name, key: 'git-token', optional: true } });
  const sent = w.calls(); // the Secret went in on stdin; its content is checked in the next test, while the Job waits in the queue
  assert.match(sent, new RegExp(`create secret generic ${m.metadata.name} --from-env-file=/dev/stdin`));
  for (const where of [r.out, w.log(), sent, text]) assert.ok(!where.includes(w.npmToken), 'the token is nowhere but the Secret');
  assert.match(r.out, /npm said \[redacted\]/);
  assert.deepEqual(w.state().secrets, {}, 'the Secret is deleted at the end');
});

test('T-491 Event: the Secret holds the token for npm and for the clone; claudepilot keeps only the npm token', async () => {
  // Hold the Job in the queue so the Secret can be read before the script deletes it.
  const seeds = [1, 2, 3].map((i) => ({ name: `claudepilot-job-0000000${i}`, chat: 'chat-x' }));
  for (const [repo, git] of [['event', true], ['claudepilot', false]] as const) {
    const w = world(seeds);
    const s = w.start(['--repo', repo, '--ref', 'main', '--', 'true']);
    await waitFor('queued', () => /queued behind 3/.test(s.out()));
    const secrets = Object.values(w.state().secrets);
    assert.equal(secrets.length, 1);
    const lines = (secrets[0] ?? '').split('\n');
    assert.ok(lines.includes(`node-auth-token=${w.npmToken}`), `${repo}: the npm token`);
    assert.equal(lines.includes(`git-token=${w.npmToken}`), git, `${repo}: the git credential only for event`);
    assert.equal(lines.includes('git-user=x-access-token'), git);
    s.p.kill('SIGTERM');
    await s.done;
  }
});

test('T-491 Event: without a GitHub token the run is refused before anything is created (the repository is private)', () => {
  const w = world();
  const r = w.run(['--repo', 'event', '--ref', 'main', '--', 'true'], { NODE_AUTH_TOKEN: '' });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /--repo event: no GitHub token/);
  assert.doesNotMatch(w.calls(), /create secret|apply/);
});

test('the cluster-wide cap: three running Jobs, the fourth says "queued behind 3" and starts when one ends', async () => {
  const w = world([{ name: 'claudepilot-job-00000001', chat: 'chat-x' }, { name: 'claudepilot-job-00000002', chat: 'chat-y' }, { name: 'claudepilot-job-00000003', chat: 'chat-z' }]);
  const s = w.start(['--repo', 'claudepilot', '--ref', 'main', '--', 'true']);
  await waitFor('the queue line', () => /queued behind 3 \(at most 3 at once, 2 per chat, 2 per program\)/.test(s.out()));
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

test('T-524 the per-program cap: two Konfersi Jobs running (one from before the label, known by its repo), a third waits; ClaudePilot goes past it', async () => {
  const w = world([{ name: 'claudepilot-job-0000000a', chat: 'chat-x', program: 'konfersi' }, { name: 'claudepilot-job-0000000b', chat: 'chat-y', repo: 'konfersi-backend' }]);
  const k = w.start(['--repo', 'konfersi:platform/konfersi-backend', '--ref', 'main', '--', 'true'], { PILOT_SESSION_ID: 'chat-a' });
  await waitFor('konfersi queued', () => /queued behind 2 \(at most 3 at once, 2 per chat, 2 per program\)/.test(k.out()));
  const c = await w.start(['--repo', 'claudepilot', '--ref', 'main', '--', 'true'], { PILOT_SESSION_ID: 'chat-b' }).done;
  assert.equal(c.code, 0, c.out);
  assert.doesNotMatch(c.out, /queued behind/, 'another program is not held up');
  assert.doesNotMatch(k.out(), /rc=/, 'konfersi still waits');
  w.edit((st) => { Object.assign(st.jobs[0] ?? {}, { done: true, rc: 0 }); });
  const r = await k.done;
  assert.equal(r.code, 0, r.out);
  assert.match(w.applied().find((m) => m.includes('konfersi-backend')) ?? '', /job-run\/program: konfersi\}/);
  // An event Job is its own program.
  const e = w.run(['--repo', 'event', '--ref', 'main', '--', 'true'], { PILOT_SESSION_ID: 'chat-c' });
  assert.equal(e.code, 0, e.out);
  assert.ok(w.applied().some((m) => /job-run\/program: event\}/.test(m)));
  assert.equal(w.run(['--list'], { JOB_RUN_MAX_PER_PROGRAM: 'x' }).code, 2, 'the cap is a number');
});

test('T-524 --big: 8Gi requested = limited, /tmp 4Gi; the default is 4Gi with /tmp 2Gi; both prefer a node other than the control plane', () => {
  for (const [argv, mem, tmp] of [[[], '4Gi', '2Gi'], [['--big'], '8Gi', '4Gi']] as const) {
    const w = world();
    const r = w.run([...argv, '--repo', 'claudepilot', '--ref', 'main', '--', 'true']); // --big first: it takes no value
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`on k3s-master with ${mem}; log: `));
    const m = yamlLoad(w.applied1()) as Manifest;
    assert.deepEqual(container(m).resources, { requests: { cpu: '1000m', memory: mem }, limits: { cpu: '4', memory: mem } });
    assert.deepEqual((m.spec.template.spec.volumes as { name: string; emptyDir: unknown }[])[0], { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: tmp } });
    assert.deepEqual((m.spec.template.spec.affinity as { nodeAffinity: unknown }).nodeAffinity, { preferredDuringSchedulingIgnoredDuringExecution: [
      { weight: 100, preference: { matchExpressions: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'DoesNotExist' }] } }] });
  }
});

test('T-524 OOMKilled: the container killed at its limit says so with the limit and the hint --big (exit 137); with --big, split it', () => {
  const killed = '=== JOB-RUN checked out claudepilot at abc1234 in 1s\nrunning the suite\n'; // no exit line: bash itself was killed
  for (const [argv, re] of [[[], /was OOMKilled: it reached its memory limit of 4Gi \(the in-memory \/tmp counts too\); rerun with --big \(8Gi, prefers k3s-node2\)/],
    [['--big'], /was OOMKilled: it reached its memory limit of 8Gi .*; 8Gi is the most a Job gets: split the command/]] as const) {
    const w = world([], { oom: true, rc: 1, reason: 'BackoffLimitExceeded', log: killed });
    const r = w.run(['--repo', 'claudepilot', '--ref', 'main', ...argv, '--', 'npm test']);
    assert.equal(r.code, 137, r.out);
    assert.match(r.out, re);
    assert.doesNotMatch(r.out, /ended without an exit code/, 'the reason is named, not a generic failure');
  }
  // One process killed inside the container (the shell lives on): the memory line counts it, and the run says so.
  const w = world([], { rc: 1, log: '=== JOB-RUN SUMMARY claudepilot@abc1234 checkout=1s steps=1s run=1s rc=1 node=k3s-node2\n=== JOB-RUN MEMORY peak=4095Mi limit=4096Mi oom_kills=2\n=== JOB-RUN EXIT 1\n' });
  const r = w.run(['--repo', 'claudepilot', '--ref', 'main', '--', 'npm test']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /2 process\(es\) were OOM-killed at the memory limit of 4Gi; rerun with --big/);
  // Evicted for /tmp over its sizeLimit.
  const ev = world([], { rc: 1, reason: 'BackoffLimitExceeded', evicted: 'Usage of EmptyDir volume "tmp" exceeds the limit "2Gi".', log: killed });
  const e = ev.run(['--repo', 'claudepilot', '--ref', 'main', '--', 'npm test']);
  assert.match(e.out, /was evicted: Usage of EmptyDir volume "tmp" exceeds the limit "2Gi"\. \(\/tmp holds at most 2Gi in memory; --big gives 4Gi\)/);
});

test('T-524 Pending for memory: one clear line (not a silent wait), then the Job starts when room frees', async () => {
  const w = world();
  writeFileSync(join(w.root, 'pending'), '0/2 nodes are available: 2 Insufficient memory. preemption: 0/2 nodes are available: 2 No preemption victims found for incoming pod.');
  const s = w.start(['--repo', 'claudepilot', '--ref', 'main', '--', 'true']);
  await waitFor('the Pending line', () => /is Pending: no node has 4Gi of memory free to request \(0\/2 nodes are available: 2 Insufficient memory\./.test(s.out()));
  assert.match(s.out(), /it starts when a Job ends and frees memory \(waits up to 900s\)/);
  await new Promise((r) => setTimeout(r, 400));
  rmSync(join(w.root, 'pending'));
  const r = await s.done;
  assert.equal(r.code, 0, r.out);
  assert.equal((r.out.match(/is Pending/g) ?? []).length, 1, 'said once, not every poll');
  // Another reason is passed on as the scheduler gives it; past the start wait, the reason is in the last line.
  const w2 = world();
  writeFileSync(join(w2.root, 'pending'), '0/2 nodes are available: 2 node(s) had untolerated taint.');
  const r2 = w2.run(['--repo', 'claudepilot', '--ref', 'main', '--', 'true'], { JOB_RUN_START_WAIT_S: '1' });
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /is Pending: 0\/2 nodes are available: 2 node\(s\) had untolerated taint\. \(waits up to 1s\)/);
  assert.match(r2.out, /did not start in 1s \(pod: Pending: 0\/2 nodes are available/);
});

test('T-524 a full in-memory /tmp: "No space left on device" in a failed Job gives the --big hint (no eviction comes); a passing Job does not', () => {
  const full = 'npm error nospc ENOSPC: No space left on device, write\n';
  for (const [argv, re] of [[[], /: No space left on device: \/tmp holds at most 2Gi in memory \(it and \/dev\/shm count against the 4Gi limit\); rerun with --big \(\/tmp 4Gi\)/],
    [['--big'], /: No space left on device: \/tmp holds at most 4Gi in memory .*the 8Gi limit\); 4Gi is the most \/tmp gets/]] as const) {
    const w = world();
    writeFileSync(join(w.root, 'scenario.json'), JSON.stringify({ rc: 1, log: jobLog(w.root, 1, full) }));
    const r = w.run([...argv, '--repo', 'claudepilot', '--ref', 'main', '--', 'npm ci']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, re);
  }
  const ok = world();
  writeFileSync(join(ok.root, 'scenario.json'), JSON.stringify({ rc: 0, log: jobLog(ok.root, 0, full) }));
  const r = ok.run(['--repo', 'claudepilot', '--ref', 'main', '--', 'true']);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /job-run: .*No space left/, 'the text in a passing Job is not a failure');
});

/** scripts/gate-job.sh in a scratch checkout, against a fake kubectl: the Job is done when the file "done" exists, its pod Pending while "pending" holds the scheduler's message. */
const FAKE_GATE_KUBECTL = String.raw`#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >> "$FAKE/calls.log"
case " $* " in
  *" create secret "*|*" apply -f -"*) cat > /dev/null ;;
  *" get job "*"metadata.uid"*) printf 'uid-1' ;;
  *" get job "*) if [ -f "$FAKE/done" ]; then printf '1/'; else printf '/'; fi ;;
  *" get pods "*) if [ -f "$FAKE/pending" ]; then jq -n --rawfile m "$FAKE/pending" '{items: [{status: {phase: "Pending", conditions: [{type: "PodScheduled", status: "False", reason: "Unschedulable", message: $m}]}}]}'
    else printf '{"items":[{"status":{"phase":"Running"}}]}'; fi ;;
  *" logs job/"*) if [ -f "$FAKE/joblog" ]; then cat "$FAKE/joblog"; else printf '=== SUMMARY\ntypecheck rc=0 1s\nGATE-VERDICT: green\n'; fi ;;
  *) ;;
esac
`;

function gateWorld() {
  const root = mkdtempSync(join(tmpdir(), 'cp-gatejob-'));
  roots.push(root);
  const bin = join(root, 'bin'), repo = join(root, 'repo');
  mkdirSync(bin); mkdirSync(join(repo, 'scripts'), { recursive: true }); mkdirSync(join(repo, 'deploy/k3s-build'), { recursive: true });
  writeFileSync(join(bin, 'kubectl'), FAKE_GATE_KUBECTL); chmodSync(join(bin, 'kubectl'), 0o755);
  writeFileSync(join(root, 'token'), `gx${hex(18)}`); // made at runtime, never a literal
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ "$1 $2" = "auth token" ] && cat "$FAKE/token"\n'); chmodSync(join(bin, 'gh'), 0o755);
  for (const f of ['scripts/gate-job.sh', 'scripts/gate-verdict.sh', 'deploy/k3s-build/gate-job.yaml']) writeFileSync(join(repo, f), readFileSync(join(REPO, f), 'utf8'));
  const env = { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: root, TMPDIR: root, FAKE: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, env, encoding: 'utf8' });
  git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'gate']);
  const start = (over: Record<string, string>) => {
    const p = spawn('bash', ['scripts/gate-job.sh', 'HEAD', 'typecheck'], { cwd: repo, env: { ...env, GATE_IMAGE: 'registry.test/claudepilot/workspace:1-dev-1', GATE_JOB_LOG: join(root, 'gate.log'), GATE_JOB_POLL_S: '1', ...over } });
    children.push(p);
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    return { done: new Promise<{ code: number | null; out: string }>((res) => p.on('close', (code) => res({ code, out }))), out: () => out };
  };
  return { root, start };
}

test('T-524 gate-job.sh: a gate Pending for room says so with the reason; never scheduled ends red naming that, not "did not finish"', async () => {
  const why = '0/2 nodes are available: 2 Insufficient memory. preemption: 0/2 nodes are available: 2 No preemption victims found for incoming pod.';
  const w = gateWorld();
  writeFileSync(join(w.root, 'pending'), why);
  const r = await w.start({ GATE_JOB_WAIT_S: '3' }).done;
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /gate job claudepilot-gate-[0-9a-f]{7}-[0-9a-f]{4} is Pending: 0\/2 nodes are available: 2 Insufficient memory\. .*; it waits for a node with room \(a Job that ends frees memory\), up to 3s\n/);
  assert.equal((r.out.match(/is Pending/g) ?? []).length, 1, 'said once, not every poll');
  assert.match(r.out, /\nGATE-VERDICT: red: not scheduled in \d+s: 0\/2 nodes are available: 2 Insufficient memory\./);
  assert.doesNotMatch(r.out, /did not finish/, 'the cause is named');

  // Pending, then room frees: it says so and the gate's own verdict stands (green, exit 0).
  const w2 = gateWorld();
  writeFileSync(join(w2.root, 'pending'), why);
  writeFileSync(join(w2.root, 'joblog'), '=== SUMMARY\ntypecheck rc=0 1s\nmemory peak=5120Mi limit=8192Mi oom_kills=0\nGATE-VERDICT: green\n');
  const s = w2.start({ GATE_JOB_WAIT_S: '60' });
  await waitFor('the Pending line', () => /is Pending/.test(s.out()));
  rmSync(join(w2.root, 'pending'));
  await waitFor('scheduled', () => /scheduled after \d+s Pending/.test(s.out()));
  writeFileSync(join(w2.root, 'done'), '');
  const r2 = await s.done;
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /GATE-VERDICT: green\n$/);
  assert.match(r2.out, /\ntypecheck rc=0 1s\nmemory peak=5120Mi limit=8192Mi oom_kills=0\nlog: /, 'the Job\'s memory peak in the summary');
  assert.equal((r2.out.match(/memory peak=/g) ?? []).length, 1, 'one memory line');

  // A Job that printed no memory line (an older manifest): the summary says unavailable, never a guess; the verdict is unchanged.
  const w4 = gateWorld();
  writeFileSync(join(w4.root, 'done'), '');
  const r4 = await w4.start({ GATE_JOB_WAIT_S: '10' }).done;
  assert.equal(r4.code, 0, r4.out);
  assert.match(r4.out, /\ntypecheck rc=0 1s\nmemory peak=unavailable \(the gate Job printed no memory line\)\nlog: [^\n]+\nGATE-VERDICT: green\n$/);

  // Scheduled but not finished in time: the old message, unchanged.
  const w3 = gateWorld();
  const r3 = await w3.start({ GATE_JOB_WAIT_S: '2' }).done;
  assert.equal(r3.code, 1, r3.out);
  assert.match(r3.out, /GATE-VERDICT: red: the job did not finish in 2s\n$/);
  assert.doesNotMatch(r3.out, /Pending|not scheduled/);
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
    [['--repo', 'gitlab', '--ref', 'main', '--', 'x'], /--repo: claudepilot, event or konfersi/],
    // T-491: the event door is exactly one repository; no free-form org/repo, no look-alikes.
    [['--repo', 'event:foo/bar', '--ref', 'main', '--', 'x'], /--repo: claudepilot, event or konfersi/],
    [['--repo', 'event:isnanme/event', '--ref', 'main', '--', 'x'], /--repo: claudepilot, event or konfersi/],
    [['--repo', 'Event', '--ref', 'main', '--', 'x'], /--repo: claudepilot, event or konfersi/],
    [['--repo', 'events', '--ref', 'main', '--', 'x'], /--repo: claudepilot, event or konfersi/],
    [['--repo', 'event ', '--ref', 'main', '--', 'x'], /--repo: claudepilot, event or konfersi/],
    [['--repo', 'event isnanme/event', '--ref', 'main', '--', 'x'], /--repo: claudepilot, event or konfersi/],
    [['--repo', 'isnanme/event', '--ref', 'main', '--', 'x'], /--repo: claudepilot, event or konfersi/],
    [['--repo', 'https://github.com/isnanme/event.git', '--ref', 'main', '--', 'x'], /--repo: claudepilot, event or konfersi/],
    [['--repo=event', '--ref', 'main', '--', 'x'], /unknown option --repo=event/], // the script defines no --repo=value form: refused as an unknown option
    // T-491: the Event token is for that one repository; no second one rides along.
    [['--repo', 'event', '--also', 'x/y', '--ref', 'main', '--', 'x'], /--also cannot be used with --repo event/],
    [['--also', 'x/y', '--repo', 'event', '--ref', 'main', '--', 'x'], /--also cannot be used with --repo event/],
  ];
  for (const [argv, re] of cases) {
    const r = w.run(argv);
    assert.equal(r.code, 2, `${argv.join(' ')}: ${r.out}`);
    assert.match(r.out, re);
  }
  assert.equal(w.calls(), '');
});

test('T-379 --image: an allowed ref is the command container\'s image only; fetch keeps the workspace image; npm steps skipped; no --image changes nothing', () => {
  const ws = 'registry.test/claudepilot/workspace:1-dev-1';
  const digest = `sha256:${hex(32)}`;
  const base = ['--repo', 'claudepilot', '--ref', 'main'];
  const imagesOf = (text: string) => { const m = yamlLoad(text) as Manifest; return { fetch: m.spec.template.spec.initContainers?.[0]?.image, run: container(m).image, m }; };
  const norm = (text: string) => text.replace(/claudepilot-job-[0-9a-f]{8}/g, 'JOB').replace(/job-run\/owner: ".*"/, 'OWNER');
  // No --image: both containers on the workspace image, the manifest exactly as before (the only change in the template is the placeholder's name).
  const w0 = world();
  assert.equal(w0.run([...base, '--steps', 'none', '--', 'true']).code, 0);
  const none = w0.applied1();
  assert.deepEqual([imagesOf(none).fetch, imagesOf(none).run], [ws, ws]);
  assert.ok(!/__[A-Z_]+__/.test(none.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')));
  // The manifest is as before T-379: the template gained no text (the placeholder was renamed), and the run image is the same text as the fetch image.
  assert.ok(!none.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').includes('--image'), 'the rendered manifest carries nothing of the option');
  assert.equal(none.split(`image: ${ws}`).length, 3, 'exactly the two image lines, both the workspace image');
  for (const ref of ['registry.int.isnan.me/claudepilot/py-test:abc123', 'registry.int.isnan.me/konfersi/metocean/test-stage:req-9f2', 'registry.int.isnan.me/event/web-test:r1',`registry.int.isnan.me/claudepilot/py-test@${digest}`]) {
    const w = world();
    const r = w.run([...base, '--image', ref, '--', 'true']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /the npm steps are skipped/);
    const text = w.applied1();
    const { fetch, run, m } = imagesOf(text);
    assert.equal(run, ref, 'the command container runs the image');
    assert.equal(fetch, ws, 'the fetch container (the credentials) keeps the workspace image');
    assert.equal(envOf(m).JR_STEPS, 'none');
    assert.equal(envOf(m).NODE_AUTH_TOKEN, undefined);
    assert.ok(!JSON.stringify(container(m)).includes('secretKeyRef'), 'no Secret in the command container');
    // Against the same run without --image, only the run container's image line differs.
    const a = norm(none).split('\n'), b = norm(text).split('\n');
    assert.equal(a.length, b.length);
    const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
    assert.deepEqual(diff, [[`          image: ${ws}`, `          image: ${ref}`]]);
  }
  // The default step is skipped too; an explicit npm-ci is refused.
  const w1 = world();
  assert.equal(w1.run([...base, '--image', 'registry.int.isnan.me/claudepilot/py:1', '--steps', 'npm-ci', '--', 'true']).code, 2);
  assert.equal(w1.calls(), '');
});

test('T-379 --image: another registry, a path outside the prefix, an untagged or odd reference, --against: refused before any kubectl call', () => {
  const w = world();
  const bad = [
    'docker.io/library/python:3.11', 'registry.evil.example/claudepilot/x:1', 'registry.int.isnan.me.evil.example/claudepilot/x:1',
    'registry.int.isnan.me/other/x:1', 'registry.int.isnan.me/claudepilot/x:latest', 'registry.int.isnan.me/event/x:latest', 'registry.int.isnan.me/claudepilot', 'registry.int.isnan.me/claudepilot/x', 'registry.int.isnan.me/claudepilot/x:latest;id',
    'registry.int.isnan.me/claudepilot/x:1 --privileged', 'registry.int.isnan.me/claudepilot/x:$(id)', 'registry.int.isnan.me/claudepilot/../other/x:1',
    'registry.int.isnan.me/claudepilot/X:1', 'registry.int.isnan.me/claudepilot/x@sha256:abc', 'registry.int.isnan.me/claudepilot/x:1\nimage: y', 'registry.int.isnan.me/claudepilot/x:1#y',
    'http://registry.int.isnan.me/claudepilot/x:1', 'registry.int.isnan.me/konfersi//x:1', '',
  ];
  for (const ref of bad) {
    const r = w.run(['--repo', 'claudepilot', '--ref', 'main', '--image', ref, '--', 'true']);
    assert.equal(r.code, 2, `${JSON.stringify(ref)}: ${r.out}`);
    assert.match(r.out, /--image: an image on registry\.int\.isnan\.me under claudepilot\/, konfersi\/ or event\//);
  }
  const r = w.run(['--repo', 'claudepilot', '--ref', 'main', '--image', 'registry.int.isnan.me/claudepilot/x:1', '--against', 'abc1234', '--', 'true']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /--image cannot be used with --against/);
  assert.equal(w.calls(), '', 'kubectl was never called');
  assert.deepEqual(w.applied(), []);
});

test('T-379 --image: the header names the command\'s image next to the fetch image; none is named without --image', () => {
  const w = world();
  const r = w.run(['--repo', 'claudepilot', '--ref', 'main', '--image', 'registry.int.isnan.me/claudepilot/py-test:abc123', '--', 'true']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /job-run: claudepilot-job-[0-9a-f]{8}: claudepilot@main \(none\) on registry\.test\/claudepilot\/workspace:1-dev-1; the command runs in registry\.int\.isnan\.me\/claudepilot\/py-test:abc123\n/);
  const w0 = world();
  const r0 = w0.run(['--repo', 'claudepilot', '--ref', 'main', '--', 'true']);
  assert.match(r0.out, /\(npm-ci\) on registry\.test\/claudepilot\/workspace:1-dev-1\n/);
  assert.doesNotMatch(r0.out, /the command runs in/);
});

test('T-379 the command container needs no git: the short sha comes from fetch (no "git: command not found", none empty in SUMMARY)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-jobrun-nogit-'));
  roots.push(root);
  const git = (args: string[], cwd: string) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  mkdirSync(join(root, 'src'));
  git(['init', '-q', '-b', 'main'], join(root, 'src'));
  writeFileSync(join(root, 'src/README'), 'x');
  git(['add', '.'], join(root, 'src'));
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one'], join(root, 'src'));
  git(['clone', '-q', '--bare', join(root, 'src'), join(root, 'claudepilot.git')], root);
  const sha = git(['rev-parse', '--short', 'HEAD'], join(root, 'src')).stdout.trim();
  // A PATH of the tools a slim image has, without git.
  const bin = join(root, 'nogit-bin'); mkdirSync(bin);
  for (const t of ['bash', 'cat', 'mkdir', 'basename', 'date', 'base64', 'sed', 'grep', 'stat', 'tar', 'tr', 'cut', 'rm', 'dirname', 'head', 'wc']) {
    const src = ['/usr/bin', '/bin'].map((d) => join(d, t)).find((p) => existsSync(p));
    if (src) symlinkSync(src, join(bin, t));
  }
  assert.ok(!existsSync(join(bin, 'git')));
  const r = runPod(TEMPLATE, {
    PATH: process.env.PATH, JR_ROOT: join(root, 'run'), JR_REPO_URL: `file://${join(root, 'claudepilot.git')}`, JR_REF: 'main', JR_ALSO: '',
    JR_STEPS: 'none', JR_ARTIFACTS: '', JR_ARTIFACT_MAX: '1', JR_CMD: Buffer.from('echo hi').toString('base64'), NODE_NAME: 'n' }, {}, { PATH: bin });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /command not found/);
  assert.match(r.stdout, new RegExp(`=== JOB-RUN SUMMARY claudepilot@${sha} checkout=`));
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
  const pod = (ref: string, cmd: string) => runPod(TEMPLATE, {
    PATH: process.env.PATH, JR_ROOT: join(root, `run-${hex(3)}`), JR_REPO_URL: `file://${join(root, 'claudepilot.git')}`, JR_REF: ref, JR_ALSO: '',
    JR_STEPS: 'none', JR_ARTIFACTS: 'out', JR_ARTIFACT_MAX: '100000', JR_CMD: Buffer.from(cmd).toString('base64'), NODE_NAME: 'k3s-master' });
  const r = pod('main', 'mkdir -p out && echo report > out/r.txt && echo ran in $(basename $PWD); exit 3');
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /ran in claudepilot\n/);
  assert.match(r.stdout, /=== JOB-RUN ARTIFACTS BEGIN\n[A-Za-z0-9+/=\n]+=== JOB-RUN ARTIFACTS END\n/);
  assert.match(r.stdout, /=== JOB-RUN SUMMARY claudepilot@[0-9a-f]+ checkout=\d+s steps=\d+s run=\d+s rc=3 node=k3s-master\n=== JOB-RUN MEMORY peak=\S+ limit=\S+ oom_kills=\S+\n=== JOB-RUN EXIT 3\n$/);
  const b64 = (r.stdout.split('=== JOB-RUN ARTIFACTS BEGIN\n')[1] ?? '').split('=== JOB-RUN ARTIFACTS END')[0]?.replace(/\s/g, '') ?? '';
  const list = spawnSync('tar', ['-tzf', '-'], { input: Buffer.from(b64, 'base64'), encoding: 'utf8' }).stdout;
  assert.match(list, /out\/r\.txt/);
  const missing = pod('no-such-branch', 'true');
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /job-run: no-such-branch of .* is not on the remote \(push it first\)\n=== JOB-RUN EXIT 2\n$/);

  // T-524: the memory line reads the Job's own cgroup (peak, limit, OOM kills), the numbers the limit is sized from.
  const cg = join(root, 'cgroup'); mkdirSync(cg);
  writeFileSync(join(cg, 'memory.peak'), `${3 * 1024 * 1048576 + 5}\n`);
  writeFileSync(join(cg, 'memory.max'), `${4 * 1024 * 1048576}\n`);
  writeFileSync(join(cg, 'memory.events'), 'low 0\nhigh 0\nmax 2\noom 1\noom_kill 1\n');
  const mem = runPod(TEMPLATE, {
    PATH: process.env.PATH, JR_ROOT: join(root, `run-${hex(3)}`), JR_REPO_URL: `file://${join(root, 'claudepilot.git')}`, JR_REF: 'main', JR_ALSO: '',
    JR_STEPS: 'none', JR_ARTIFACTS: '', JR_ARTIFACT_MAX: '1', JR_CMD: Buffer.from('true').toString('base64'), JR_CGROUP: cg });
  assert.equal(mem.status, 0, mem.stdout + mem.stderr);
  assert.match(mem.stdout, /=== JOB-RUN MEMORY peak=3072Mi limit=4096Mi oom_kills=1\n=== JOB-RUN EXIT 0\n$/);
  writeFileSync(join(cg, 'memory.max'), 'max\n'); rmSync(join(cg, 'memory.peak')); rmSync(join(cg, 'memory.events'));
  const unl = runPod(TEMPLATE, {
    PATH: process.env.PATH, JR_ROOT: join(root, `run-${hex(3)}`), JR_REPO_URL: `file://${join(root, 'claudepilot.git')}`, JR_REF: 'main', JR_ALSO: '',
    JR_STEPS: 'none', JR_ARTIFACTS: '', JR_ARTIFACT_MAX: '1', JR_CMD: Buffer.from('true').toString('base64'), JR_CGROUP: cg });
  assert.match(unl.stdout, /=== JOB-RUN MEMORY peak=\? limit=max oom_kills=\?\n/, 'a missing file is "?", never a guessed number');

  // T-491: for Event only, with a token, the user npmrc maps @isnanme to GitHub Packages through a reference npm expands (the value is
  // never written) and the git credential helper is scoped to that one URL and path. The https URL is served from the local bare
  // repository through an environment-level insteadOf (the credential lookup still sees the https URL).
  const token = `fx${hex(18)}`;
  const eventUrl = 'https://github.com/isnanme/event.git';
  const asksFor = (url: string) => { // does `git credential fill` give a password for this URL?
    const m = /^https:\/\/([^/]+)\/(.*)$/.exec(url); // split by hand: new URL() would fold a "/../" away before git sees it
    return `printf 'protocol=https\\nhost=${m?.[1]}\\npath=${m?.[2]}\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null | grep -c '^password=' || true`;
  };
  // T-401: those files are in the fetch container's own HOME (JR_FETCH_HOME here), which the run container never mounts; the command
  // finds neither file and no helper.
  const podEvent = (url: string, cmd: string, tok: string | undefined) => {
    const jr = join(root, `run-${hex(3)}`);
    const insteadOf = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${join(root, 'claudepilot.git')}.insteadOf`, GIT_CONFIG_VALUE_0: url };
    const r = runPod(TEMPLATE, { PATH: process.env.PATH, JR_ROOT: jr, JR_FETCH_HOME: `${jr}-fh`, JR_REPO_URL: url, JR_REF: 'main', JR_ALSO: '', JR_STEPS: 'none', JR_ARTIFACTS: '',
      JR_ARTIFACT_MAX: '100000', JR_CMD: Buffer.from(cmd).toString('base64'), ...insteadOf }, tok ? { NODE_AUTH_TOKEN: tok, GIT_TOKEN: tok, GIT_USER: 'x-access-token' } : {});
    // What git would hand out from the fetch container's HOME, with its credential in the environment.
    const ask = (urls: string[]) => spawnSync('bash', ['-c', urls.map(asksFor).join('\n')], { encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: `${jr}-fh`, GIT_CONFIG_NOSYSTEM: '1', ...(tok ? { GIT_TOKEN: tok, GIT_USER: 'x-access-token' } : {}) } }).stdout;
    return { r, fetchHome: `${jr}-fh`, ask };
  };
  const ev = podEvent(eventUrl, ['test ! -e "$HOME/.npmrc" && echo no npmrc', 'git config --global --get-regexp "^credential" || echo no helper', asksFor(eventUrl)].join('\n'), token);
  assert.equal(ev.r.status, 0, ev.r.stdout + ev.r.stderr);
  assert.match(ev.r.stdout, /no npmrc\nno helper\n0\n/, 'T-401: the command has no npmrc, no git helper, no password for the Event URL');
  const npmrc = readFileSync(join(ev.fetchHome, '.npmrc'), 'utf8');
  assert.equal(npmrc, '@isnanme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n');
  const cfg = readFileSync(join(ev.fetchHome, '.gitconfig'), 'utf8');
  assert.ok(!npmrc.includes(token) && !cfg.includes(token), 'the files hold references, not the value');
  assert.match(cfg, /\[credential "https:\/\/github\.com\/isnanme\/event\.git"\]/);
  assert.match(cfg, /useHttpPath = true/);
  assert.equal((cfg.match(/\[credential/g) ?? []).length, 1, 'one credential section, no global helper');
  assert.doesNotMatch(cfg, /^\[credential\]/m, 'no unscoped credential section');
  assert.equal(ev.ask([eventUrl, 'https://github.com/isnanme/other.git', 'https://github.com/isnanme/event.git.evil/x', 'https://example.com/isnanme/event.git',
    'https://github.com/isnanme/event', 'https://github.com/isnanme/event-x.git', 'https://github.com/isnanme/event.git/../other.git']), '1\n0\n0\n0\n0\n0\n0\n',
  'a password for the Event URL only: not another path, a look-alike path, another host, the URL without .git, event-x.git or a /../ path');
  // claudepilot (its own URL, here the local bare repository): no npmrc and the global helper, in the fetch container's HOME; the command
  // sees neither.
  const cp = podEvent(`file://${join(root, 'claudepilot.git')}`, 'test ! -e "$HOME/.npmrc" && echo no npmrc; git config --global --get credential.helper >/dev/null || echo no helper', token);
  assert.match(cp.r.stdout, /no npmrc\nno helper\n/, 'the command: no npmrc, no helper');
  assert.ok(!existsSync(join(cp.fetchHome, '.npmrc')), 'not Event: no npmrc');
  assert.match(readFileSync(join(cp.fetchHome, '.gitconfig'), 'utf8'), /^\[credential\]\n\thelper = /m, 'not Event: the global helper, in the fetch HOME');
  const noToken = podEvent(eventUrl, 'true', undefined);
  assert.equal(noToken.r.status, 0, noToken.r.stdout + noToken.r.stderr);
  assert.ok(!existsSync(join(noToken.fetchHome, '.npmrc')), 'no token, no npmrc');
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
  // A fake npm that fails until it has been called NPM_FAIL_UNTIL times (a flake), and counts its calls.
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho x >> "${root}/npm.calls"\n[ "$(wc -l < "${root}/npm.calls")" -ge "\${NPM_FAIL_UNTIL:-2}" ] || exit 7\nmkdir -p node_modules\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  const pod = (over: Record<string, string>) => {
    rmSync(join(root, 'npm.calls'), { force: true });
    return runPod(TEMPLATE, {
      PATH: `${bin}:${process.env.PATH}`, JR_ROOT: join(root, `run-${hex(3)}`), JR_REPO_URL: `file://${join(root, 'claudepilot.git')}`, JR_REF: 'main', JR_ALSO: '',
      JR_STEPS: 'none', JR_ARTIFACTS: '', JR_ARTIFACT_MAX: '1', JR_CMD: Buffer.from('bash check.sh').toString('base64'), NODE_NAME: 'k3s-master', ...over });
  };
  const text = (r: ReturnType<typeof pod>) => r.stdout + r.stderr;

  const ok = pod({ JR_AGAINST: oldSha, JR_KEEP: 'check.sh' });
  assert.equal(ok.status, 0, text(ok));
  assert.match(ok.stdout, /SUMMARY claudepilot@[0-9a-f]+ .* rc=0/);
  assert.match(ok.stdout, /SUMMARY-AGAINST claudepilot@[0-9a-f]+ tests-from=[0-9a-f]+ kept=check.sh run=\d+s rc=1/);
  assert.match(ok.stdout, /=== JOB-RUN PROOF: passes on main \([0-9a-f]+\), fails on [0-9a-f]{40} \([0-9a-f]+\) \(rc=1\)\n=== JOB-RUN MEMORY [^\n]+\n=== JOB-RUN EXIT 0\n$/);

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

test('T-365: job-run and gate Jobs prefer a node away from the portal (preferred: a required rule left every Job Pending)', () => {
  for (const name of ['job-run.yaml', 'gate-job.yaml']) {
    const text = readFileSync(join(REPO, 'deploy/k3s-build', name), 'utf8').replace(/__[A-Z_]+__/g, 'x');
    type Term = { weight: number; podAffinityTerm: { namespaces: string[]; labelSelector: { matchLabels: Record<string, string> } } };
    const job = yamlLoad(text) as { spec: { template: { spec: { affinity?: { podAntiAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: unknown[]; preferredDuringSchedulingIgnoredDuringExecution?: Term[] } } } } } };
    const anti = job.spec.template.spec.affinity?.podAntiAffinity;
    // Never required: k3s-master's memory requests were at 96% (2026-10-15) and a required rule kept the gate from scheduling at all.
    assert.equal(anti?.requiredDuringSchedulingIgnoredDuringExecution, undefined, `${name}: no required anti-affinity`);
    const portal = (anti?.preferredDuringSchedulingIgnoredDuringExecution ?? []).find((t) => t.podAffinityTerm.labelSelector.matchLabels.app === 'claudepilot-portal');
    assert.ok(portal, `${name}: a preferred anti-affinity to the portal pod (label app=claudepilot-portal)`);
    assert.equal(portal.weight, 100);
    assert.deepEqual(portal.podAffinityTerm.namespaces, ['isnan-claudepilot']);
  }
  // The label the rule names is the portal Deployment's own pod label.
  assert.match(readFileSync(join(REPO, 'deploy/k3s/portal.yaml'), 'utf8'), /app: claudepilot-portal/);
});

test('T-524: the heavy Jobs prefer a node other than the control plane (preferred only) and request all the memory they may use', () => {
  type Pod = { affinity?: { nodeAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: unknown; preferredDuringSchedulingIgnoredDuringExecution?: unknown } };
    containers: { resources: { requests: { memory: string }; limits: { memory: string } } }[]; initContainers?: { resources: { requests: { memory: string }; limits: { memory: string } } }[];
    volumes?: { name: string; emptyDir?: { sizeLimit?: string } }[] };
  const gi = (v: string) => { const m = /^(\d+)(Gi|Mi)$/.exec(v); assert.ok(m, v); return Number(m[1]) / (m[2] === 'Mi' ? 1024 : 1); };
  for (const name of ['job-run.yaml', 'gate-job.yaml', 'browser-job.yaml']) {
    const text = readFileSync(join(REPO, 'deploy/k3s-build', name), 'utf8').replace(/__MEMORY__/g, '4Gi').replace(/__TMP_SIZE__/g, '2Gi').replace(/__[A-Z_]+__/g, 'x');
    const pod = (yamlLoad(text) as { spec: { template: { spec: Pod } } }).spec.template.spec;
    const na = pod.affinity?.nodeAffinity;
    assert.equal(na?.requiredDuringSchedulingIgnoredDuringExecution, undefined, `${name}: never required (a required rule left every Job Pending)`);
    assert.deepEqual(na?.preferredDuringSchedulingIgnoredDuringExecution, [{ weight: 100, preference: { matchExpressions: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'DoesNotExist' }] } }], name);
    for (const c of [...pod.containers, ...(pod.initContainers ?? [])]) assert.equal(c.resources.requests.memory, c.resources.limits.memory, `${name}: memory request = limit`);
    const tmp = pod.volumes?.find((v) => v.name === 'tmp')?.emptyDir?.sizeLimit;
    const lim = pod.containers[0]?.resources.limits.memory ?? '';
    if (tmp) assert.ok(gi(tmp) < gi(lim), `${name}: the in-memory /tmp (${tmp}) fits inside the limit (${lim}) with room for the processes`);
  }
  // The label the rule names is on k3s-master (kubectl get nodes --show-labels, 2026-10-15): node-role.kubernetes.io/control-plane=true.
});
