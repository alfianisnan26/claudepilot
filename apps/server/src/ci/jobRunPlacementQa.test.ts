// QA T-611 S1 (lane-cp-qa-perf): scripts/job-run.sh against a fake kubectl: the Secret failure path never shows kubectl's text, the headroom edges,
// the PLACEMENT lines. Credential-like fixtures are made at run time and never printed. The builder's own tests are not repeated.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/job-run.sh');
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const hex = (n: number) => randomBytes(n).toString('hex');

const FAKE_KUBECTL = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const F = process.env.FAKE, S = path.join(F, 'state.json');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(F, 'calls.log'), 'kubectl ' + args.join(' ') + '\n');
const a = args[0] === '-n' ? args.slice(2) : args;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lock = (fn) => { const l = path.join(F, 'lock'); for (;;) { try { fs.mkdirSync(l); break; } catch { sleep(5); } } try { const s = JSON.parse(fs.readFileSync(S, 'utf8')); const r = fn(s); fs.writeFileSync(S + '.tmp', JSON.stringify(s)); fs.renameSync(S + '.tmp', S); return r; } finally { fs.rmdirSync(l); } };
const read = () => JSON.parse(fs.readFileSync(S, 'utf8'));
const k8s = (j) => ({ metadata: { name: j.name, uid: 'uid-' + j.name, creationTimestamp: '2026-01-01T00:00:' + String(j.seq % 60).padStart(2, '0') + 'Z',
  labels: { app: 'claudepilot-job-run', 'job-run/chat': j.chat, 'job-run/role': j.role || 'agent', ...(j.program ? { 'job-run/program': j.program } : {}) }, annotations: { 'job-run/owner': j.owner || '' } },
  spec: { suspend: j.suspend }, status: j.done ? { [j.rc === 0 ? 'succeeded' : 'failed']: 1, conditions: [{ type: j.rc === 0 ? 'Complete' : 'Failed', status: 'True' }] } : {} });
const stdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
const job = (n) => read().jobs.find((j) => j.name === n);
const [verb, kind, name] = a;
if (verb === 'top' && kind === 'nodes') { const f = path.join(F, 'top.txt'); if (!fs.existsSync(f)) process.exit(1); process.stdout.write(fs.readFileSync(f, 'utf8')); }
else if (verb === 'get' && kind === 'jobs') { process.stdout.write(JSON.stringify({ items: read().jobs.map(k8s) })); }
else if (verb === 'get' && kind === 'job') { const j = job(name); if (!j) process.exit(1); process.stdout.write(a.includes('json') ? JSON.stringify(k8s(j)) : 'uid-' + name); }
else if (verb === 'get' && kind === 'pods') {
  const j = job(a[3].replace('job-name=', '')); if (!j || j.suspend) { process.stdout.write('{"items":[]}'); }
  else { const pf = path.join(F, 'pend'); const left = fs.existsSync(pf) ? Number(fs.readFileSync(pf, 'utf8')) : 0;
    if (left > 0) { fs.writeFileSync(pf, String(left - 1)); process.stdout.write(JSON.stringify({ items: [{ spec: {}, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: fs.readFileSync(path.join(F, 'pendmsg'), 'utf8') }] } }] })); }
    else process.stdout.write(JSON.stringify({ items: [{ spec: { nodeName: 'k3s-node2' }, status: { phase: j.done ? 'Succeeded' : 'Running' } }] })); } }
else if (verb === 'create' && kind === 'secret') { const t = stdin(); const ef = path.join(F, 'kerr');
  if (fs.existsSync(ef)) { process.stderr.write(fs.readFileSync(ef, 'utf8') + '\n' + t + '\n'); process.exit(1); }
  lock((s) => { s.secrets[a[3]] = t; }); }
else if (verb === 'apply') { const m = stdin(); const n = m.match(/^ {2}name: (\S+)/m)[1]; fs.mkdirSync(path.join(F, 'applied'), { recursive: true }); fs.writeFileSync(path.join(F, 'applied', n + '.yaml'), m);
  const lab = (k) => m.match(new RegExp(k + ': ([^,}]+)'))[1].trim();
  lock((s) => { s.seq += 1; s.jobs.push({ name: n, chat: lab('job-run/chat'), role: lab('job-run/role'), program: lab('job-run/program'), owner: m.match(/job-run\/owner: "([^"]*)"/)[1], suspend: true, seq: s.seq }); }); }
else if (verb === 'patch' && kind === 'job') { lock((s) => { const j = s.jobs.find((x) => x.name === name); if (j) j.suspend = false; }); }
else if (verb === 'delete' && kind === 'job') { lock((s) => { s.jobs = s.jobs.filter((j) => j.name !== name); }); }
else if (verb === 'logs') { const n = (a.includes('-f') ? a[2] : a[1]).replace('job/', ''); process.stdout.write('hello\n=== JOB-RUN EXIT 0\n'); lock((s) => { const j = s.jobs.find((x) => x.name === n); if (j) { j.done = true; j.rc = 0; } }); }
else { /* patch secret, delete secret, anything else: accepted */ }
`;

function world() {
  const root = mkdtempSync(join(tmpdir(), 'cp-qa611-'));
  roots.push(root);
  const bin = join(root, 'bin'), home = join(root, 'home');
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL); chmodSync(join(bin, 'kubectl'), 0o755);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(root, 'state.json'), JSON.stringify({ seq: 0, secrets: {}, jobs: [] }));
  const npm = `fx${hex(18)}`, extra = `ev${hex(18)}`;
  const run = (over: Record<string, string> = {}, argv: string[] = []) => {
    const r = spawnSync('bash', [SCRIPT, '--repo', 'claudepilot', '--ref', 'main', ...argv, '--', 'true'], { cwd: root, encoding: 'utf8', timeout: 60_000, env: {
      PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: root, FAKE: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      JOB_RUN_IMAGE: 'registry.test/claudepilot/workspace:1-dev-1', JOB_RUN_POLL_S: '0.1', JOB_RUN_WATCH_PID: 'none', JOB_RUN_LOG: join(root, 'job.log'),
      NODE_AUTH_TOKEN: npm, SOME_OTHER_ENV_VALUE: extra, PILOT_SESSION_ID: 'chat-a', PILOT_AGENT: 'qa', ...over } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const file = (n: string) => (existsSync(join(root, n)) ? readFileSync(join(root, n), 'utf8') : '');
  const put = (n: string, body: string) => writeFileSync(join(root, n), body);
  const top = (used: string, pct: string) => put('top.txt', `k3s-master   310m   7%   ${used}   ${pct}\n`);
  return { root, npm, extra, run, file, put, top, log: () => file('job.log'), calls: () => file('calls.log') };
}
const placement = (s: string) => s.split('\n').filter((l) => l.includes('JOB-RUN PLACEMENT'));

test('QA-H1 (1) a failing Secret create never shows kubectl text (the stdin it was given included), in each category, "other" too', () => {
  const cats: [string, string][] = [
    ['already-exists', 'Error from server (AlreadyExists): secrets already exists'],
    ['not-allowed', 'Error from server (Forbidden): secrets is forbidden'],
    ['cluster-unreachable', 'Unable to connect to the server: dial tcp: connection refused'],
    ['invalid', 'The Secret is invalid: data'],
    ['other', 'something odd happened here'],
  ];
  for (const [cat, text] of cats) {
    const w = world();
    const marker = `mk${hex(12)}`;
    w.put('kerr', `${text} ${marker} ${w.npm}`);
    const r = w.run();
    assert.notEqual(r.code, 0, `${cat}: exit ${r.code}`);
    for (const [what, hay] of [['output', r.out], ['log', w.log()], ['calls', w.calls()]] as const) {
      assert.ok(!hay.includes(w.npm), `${cat}: the token reached the ${what}`);
      assert.ok(!hay.includes(marker), `${cat}: kubectl's text reached the ${what}`);
    }
    assert.match(r.out, new RegExp(`category: ${cat}`), `${cat}: the category is named: ${r.out.replace(w.npm, '<v>')}`);
  }
});

test('QA-H1b a category word inside the echoed value does not change the category into one that shows text, and the stdin echo never shows', () => {
  const w = world();
  const marker = `mk${hex(12)}`;
  w.put('kerr', `weird forbidden ${marker}`);
  const r = w.run();
  assert.notEqual(r.code, 0);
  assert.ok(!r.out.includes(marker) && !r.out.includes(w.npm));
});

test('QA-H2 (2) headroom edges: exactly at the line is preferred, one Mi less memory is required-away; odd and Gi columns; peak garbage, 0 and a leading zero', () => {
  const read = (used: string, pct: string, over: Record<string, string> = {}, argv: string[] = []) => {
    const w = world();
    w.top(used, pct);
    const r = w.run(over, argv);
    const l = placement(w.log()).find((x) => x.includes('node=control-plane')) ?? '';
    console.log(`QA-H2 used=${used} pct=${pct} env=${JSON.stringify(Object.keys(over))} argv=${argv.join(' ')} -> rc=${r.code} ${l.replace('=== JOB-RUN PLACEMENT ', '')}`);
    return { r, l };
  };
  // (used + 2300) * 60 == 75 * used at used = 9200: not over the line.
  assert.match(read('9200Mi', '60%').l, /decision=preferred/);
  assert.match(read('9200Mi', '60%').l, /projected=75 /);
  assert.match(read('9199Mi', '60%').l, /decision=required-away.*reason=headroom/);
  assert.match(read('9200Mi', '76%').l, /decision=required-away.*reason=over/);
  assert.match(read('8Gi', '60%').l, /decision=required-away.*reason=headroom/, 'Gi units are read as 1024 Mi');
  // Odd bytes columns keep the percentage-only test.
  for (const odd of ['9200Ki', 'abc', '3.5Gi', '0Mi', '', '123456789012Mi']) assert.match(read(odd, '60%').l, /decision=preferred/, `odd column ${JSON.stringify(odd)}`);
  assert.match(read('abc', '80%').l, /decision=required-away.*reason=over/);
  assert.match(read('9200Mi', 'abc').l, /pct=unknown.*decision=preferred-metrics-unavailable/);
  assert.match(read('9200Mi', '1000%').l, /^$|decision=/, 'a four-digit percentage is read as unavailable');
  // The peak variable.
  const g = read('9200Mi', '60%', { JOB_RUN_EXPECTED_PEAK_MI: 'garbage' });
  assert.equal(g.r.code, 2, `garbage peak: ${g.r.out}`);
  assert.match(g.r.out, /JOB_RUN_EXPECTED_PEAK_MI is a number of Mi/);
  assert.match(read('9199Mi', '60%', { JOB_RUN_EXPECTED_PEAK_MI: '0' }).l, /peak_mi=0 .*decision=preferred/, 'a zero peak adds nothing');
  assert.match(read('9199Mi', '60%', {}, ['--big']).l, /peak_mi=8192/, '--big uses its whole limit');
  const lead0 = read('9200Mi', '60%', { JOB_RUN_EXPECTED_PEAK_MI: '08' });
  assert.equal(lead0.r.code, 0, `a leading-zero peak (08) must not abort the run: ${lead0.r.out}`);
  assert.ok(lead0.l, 'and the placement line is written');
  const huge = read('9200Mi', '60%', { JOB_RUN_EXPECTED_PEAK_MI: '99999999999999999999' });
  assert.match(huge.l, /decision=required-away/, 'an enormous peak must not wrap around into "fits"');
});

test('QA-H3 (3) PLACEMENT lines hold only fixed keys: no token, no environment value; the node line is present once the Job started after a Pending wait', () => {
  const w = world();
  w.top('9199Mi', '80%');
  w.put('pend', '3'); w.put('pendmsg', `0/2 nodes are available: 1 node(s) didn't match Pod's node affinity/selector.`);
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  const lines = [...placement(r.out), ...placement(w.log())];
  assert.ok(lines.length >= 3, `placement lines: ${lines.length}`);
  for (const l of lines) {
    assert.match(l.trim(), /^=== JOB-RUN PLACEMENT( [a-z_]+=[A-Za-z0-9._?%-]+)+$/, 'a fixed-key line');
    assert.ok(!l.includes(w.npm) && !l.includes(w.extra), 'no secret or environment value');
  }
  const log = placement(w.log());
  assert.ok(log.some((l) => /pending=affinity .*decision=waits-for-node2/.test(l)), 'the Pending line is in the log');
  assert.ok(log.some((l) => /PLACEMENT node=k3s-node2 /.test(l)), `the final node line is in the log: ${log.join(' | ')}`);
  assert.match(r.out, /Pending: the control-plane node is over 75%/);
});

test('QA-H3b a Job that never leaves Pending: the Pending line is in the log; whether a node line exists is recorded', () => {
  const w = world();
  w.top('9000Mi', '50%');
  w.put('pend', '100000'); w.put('pendmsg', '0/2 nodes are available: Insufficient memory.');
  const r = w.run({ JOB_RUN_START_WAIT_S: '1' });
  assert.equal(r.code, 1, r.out);
  const log = placement(w.log());
  console.log(`QA-H3b log lines: ${log.map((l) => l.replace('=== JOB-RUN PLACEMENT ', '')).join(' | ')}`);
  assert.ok(log.some((l) => /pending=memory/.test(l)), 'the Pending line is in the log');
  // The FINAL line (a k3s node name and queued=), not the control-plane decision line. Expected to fail on 62c38599: a product gap.
  assert.ok(log.some((l) => /PLACEMENT node=k3s-\S+ .*queued=/.test(l)), 'a final node/queued line is also written when the Job never started');
});
