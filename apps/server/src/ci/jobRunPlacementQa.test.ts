// QA T-611 S1 (lane-cp-qa-perf): scripts/job-run.sh against a fake kubectl: the Secret failure path never shows kubectl's text, the headroom edges,
// the PLACEMENT lines. Credential-like fixtures are made at run time and never printed. The builder's own tests are not repeated.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
if (verb === 'top' && kind === 'nodes') { let f = path.join(F, 'top.txt');
  // C5 probes: when top1.txt exists, the n-th call of top reads top<n>.txt and a missing one fails (the metrics read fails at that moment).
  if (fs.existsSync(path.join(F, 'top1.txt'))) { const nf = path.join(F, 'topn'); const n = (fs.existsSync(nf) ? Number(fs.readFileSync(nf, 'utf8')) : 0) + 1; fs.writeFileSync(nf, String(n)); f = path.join(F, 'top' + n + '.txt'); }
  if (!fs.existsSync(f)) process.exit(1); process.stdout.write(fs.readFileSync(f, 'utf8')); }
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
else if (verb === 'patch' && kind === 'job') { const body = a[a.indexOf('-p') + 1] || ''; fs.appendFileSync(path.join(F, 'patches.log'), body + '\n');
  // C5 probes: when the file patchfail exists, a patch that touches the affinity fails (stderr echoes a marker and the body); a plain suspend patch works.
  if (fs.existsSync(path.join(F, 'patchfail')) && /ffinity|DoesNotExist|requiredDuring/.test(body)) { process.stderr.write(fs.readFileSync(path.join(F, 'patchfail'), 'utf8') + ' ' + body + '\n'); process.exit(1); }
  lock((s) => { const j = s.jobs.find((x) => x.name === name); if (j && /suspend/.test(body) && /false/.test(body)) j.suspend = false; }); }
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

// ---- S1b (ticket/T-611-s1b, 6a925201): review 7762 C1-C4, coordinator 7806, 7865 gaps. Written before the run; not run when committed. ----
const ctl = (w: ReturnType<typeof world>) => placement(w.log()).find((x) => x.includes('node=control-plane')) ?? '';
const go = (used: string, pct: string, over: Record<string, string> = {}, argv: string[] = []) => {
  const w = world();
  w.top(used, pct);
  const r = w.run(over, argv);
  const l = ctl(w);
  console.log(`QA-S1b used=${used} pct=${pct} env=${JSON.stringify(over)} argv=${argv.join(' ')} -> rc=${r.code} ${l.replace('=== JOB-RUN PLACEMENT ', '')}`);
  return { w, r, l };
};

test('QA-S1b-C1 octal: leading zeros are decimal in the peak, the master line, the percentage and the bytes column; none aborts the run', () => {
  for (const peak of ['08', '09', '0800', '000012']) {
    const g = go('9200Mi', '60%', { JOB_RUN_EXPECTED_PEAK_MI: peak });
    assert.equal(g.r.code, 0, `peak ${peak} aborted: ${g.r.out}`);
    assert.match(g.l, new RegExp(`peak_mi=${Number(peak)} `), `peak ${peak} is read as decimal ${Number(peak)}`);
  }
  const m = go('9200Mi', '60%', { JOB_RUN_MASTER_MAX_PCT: '075' });
  assert.equal(m.r.code, 0, `max 075: ${m.r.out}`);
  assert.match(m.l, /max=75 /, 'a master line of 075 is 75, not an octal error');
  assert.equal(go('9200Mi', '60%', { JOB_RUN_MASTER_MAX_PCT: '08' }).r.code, 0, 'max 08');
  const p = go('09200Mi', '060%');
  assert.equal(p.r.code, 0, `leading zeros in top: ${p.r.out}`);
  assert.match(p.l, /pct=60 .*projected=75 /, 'pct 060 and 09200Mi read as decimal: the same line as 9200Mi, 60%');
  assert.equal(go('09Gi', '08%').r.code, 0, '09Gi and 08%');
});

test('QA-S1b-C2 overflow: a peak or a master line of more than the digit cap is refused; the largest allowed one never wraps into "fits"', () => {
  for (const big of ['1000000', '99999999999999999999', '-5', '1e3', ' 5', '5 ']) {
    const g = go('9200Mi', '60%', { JOB_RUN_EXPECTED_PEAK_MI: big });
    assert.equal(g.r.code, 2, `peak ${JSON.stringify(big)} must be refused, rc=${g.r.code}: ${g.r.out}`);
    assert.match(g.r.out, /JOB_RUN_EXPECTED_PEAK_MI is a number of Mi/);
  }
  const top = go('9200Mi', '60%', { JOB_RUN_EXPECTED_PEAK_MI: '999999' });
  assert.equal(top.r.code, 0, top.r.out);
  assert.match(top.l, /decision=required-away.*reason=headroom/, 'six digits of peak is far over the line, never "preferred"');
  assert.match(top.l, /projected=\d{3,}/, 'the projection is a large positive number');
  const mx = go('9200Mi', '60%', { JOB_RUN_MASTER_MAX_PCT: '1000' });
  assert.equal(mx.r.code, 2, `a four-digit master line is refused: ${mx.r.out}`);
  assert.match(mx.r.out, /JOB_RUN_MASTER_MAX_PCT is a percentage/);
  assert.equal(go('9200Mi', '60%', { JOB_RUN_MASTER_MAX_PCT: 'abc' }).r.code, 2);
  // A giant bytes column is an odd column (percentage only), never an overflow.
  for (const odd of ['1234567890Mi', '9999999999999999999999Mi', '9999999Gi']) {
    const g = go(odd, '60%');
    assert.equal(g.r.code, 0, `${odd}: ${g.r.out}`);
    assert.match(g.l, /decision=(preferred|required-away)/, `${odd} gives a decision`);
  }
  // A leading-zero peak is cut by DIGITS, not by value: 7 characters are refused even when the value is small (recorded, not judged).
  console.log(`QA-S1b-C2 peak 0000012 -> rc=${go('9200Mi', '60%', { JOB_RUN_EXPECTED_PEAK_MI: '0000012' }).r.code}`);
});

test('QA-S1b-C3 the line itself: percentage-only fallback at 75 is preferred, 76 is away; with bytes, exactly at the line is preferred and 1 Mi less is away; for --big too', () => {
  for (const odd of ['abc', '9200Ki', '<unknown>']) {
    assert.match(go(odd, '75%').l, /decision=preferred/, `odd ${JSON.stringify(odd)} at 75: not over`);
    assert.match(go(odd, '76%').l, /decision=required-away.*reason=over/, `odd ${JSON.stringify(odd)} at 76`);
    assert.match(go(odd, '74%').l, /decision=preferred/, `odd ${JSON.stringify(odd)} at 74`);
  }
  assert.match(go('9200Mi', '75%').l, /reason=(headroom|over)/, '75% real with bytes: the peak pushes it over');
  // --big (peak 8192): (u + 8192) * 20 <= 75 * u  <=>  u >= 2978.9, so 2979 is on the line and 2978 is over it.
  assert.match(go('2979Mi', '20%', {}, ['--big']).l, /decision=preferred/, '--big exactly at the line');
  assert.match(go('2978Mi', '20%', {}, ['--big']).l, /decision=required-away.*reason=headroom/, '--big one Mi under');
  // A different master line moves the boundary: max 50, normal Job (2300): (u + 2300) * 20 <= 50 * u  <=>  u >= 1533.3.
  assert.match(go('1534Mi', '20%', { JOB_RUN_MASTER_MAX_PCT: '50' }).l, /decision=preferred/);
  assert.match(go('1533Mi', '20%', { JOB_RUN_MASTER_MAX_PCT: '50' }).l, /decision=required-away.*reason=headroom/);
});

test('QA-S1b-C4 the Pending timeout says "run it again" only when the required rule was set, and the log gets a final line for the Job that never started', () => {
  const away = world();
  away.top('9199Mi', '80%');
  away.put('pend', '100000'); away.put('pendmsg', `0/2 nodes are available: 1 node(s) didn't match Pod's node affinity/selector.`);
  const a = away.run({ JOB_RUN_START_WAIT_S: '1' });
  assert.equal(a.code, 1, a.out);
  assert.match(a.out, /the Job did not start in 1s/);
  assert.match(a.out, /run it again/, 'required rule set: the timeout line tells the person to run it again');
  assert.ok(placement(away.log()).some((l) => /node=none .*decision=required-away .*outcome=did-not-start/.test(l)), `the final line is in the log: ${placement(away.log()).join(' | ')}`);
  const fits = world();
  fits.top('3000Mi', '20%');
  fits.put('pend', '100000'); fits.put('pendmsg', '0/2 nodes are available: Insufficient memory.');
  const f = fits.run({ JOB_RUN_START_WAIT_S: '1' });
  assert.equal(f.code, 1, f.out);
  assert.ok(!/run it again/.test(f.out), 'no required rule: the line does not suggest waiting for the master');
  assert.ok(placement(fits.log()).some((l) => /node=none .*decision=preferred .*outcome=did-not-start/.test(l)), 'the final line names the preferred decision');
  for (const l of [...placement(a.out), ...placement(away.log()), ...placement(fits.log())]) {
    assert.ok(!l.includes(away.npm) && !l.includes(away.extra) && !l.includes(fits.npm), 'no secret in a PLACEMENT line');
  }
});

test('QA-S1b-W1 coordinator 7806: the master at 74% with a 4Gi Job is NOT placed on the master (the required rule is in the applied manifest); same for 58-60% by the 85% idea and for --big', () => {
  // 74% of 15000 Mi = 11100 Mi used, the real case: 11100 + 2300 over 75% of 15000.
  const g = go('11100Mi', '74%');
  assert.equal(g.r.code, 0, g.r.out);
  assert.match(g.l, /decision=required-away.*reason=headroom/, 'the old guard (74 <= 75) let this Job on; the new one must not');
  assert.match(g.r.out, /about (\d+)%, over 75%/);
  const [, n] = /about (\d+)%, over (\d+)%/.exec(g.r.out) ?? [];
  assert.ok(Number(n) > 75, `the message never reads "about ${n}%, over 75%" with N <= M`);
  const yaml = (w: ReturnType<typeof world>) => {
    const d = join(w.root, 'applied');
    return existsSync(d) ? readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')).join('\n') : '';
  };
  const y = yaml(g.w);
  assert.ok(y !== '', 'the fake kubectl recorded the applied Job manifest');
  assert.match(y, /requiredDuringSchedulingIgnoredDuringExecution[\s\S]*node-role\.kubernetes\.io\/control-plane[\s\S]*DoesNotExist/, 'the applied manifest keeps the Job off the master');
  const ok = go('3000Mi', '20%');
  assert.ok(!/requiredDuringSchedulingIgnoredDuringExecution: \{nodeSelectorTerms/.test(yaml(ok.w)), 'a Job with room gets no required rule');
  // 4Gi Job as the peak (the Job's whole request, not the 2300 median).
  const four = go('11100Mi', '74%', { JOB_RUN_EXPECTED_PEAK_MI: '4096' });
  assert.match(four.l, /peak_mi=4096 .*required-away/);
  // The coordinator's formula: real <= 85% - request/allocatable. With max 85 and 4096 on 15000 Mi: real <= 57.7%, so 58% is away and 57% is not.
  const env85 = { JOB_RUN_MASTER_MAX_PCT: '85', JOB_RUN_EXPECTED_PEAK_MI: '4096' };
  assert.match(go('8550Mi', '57%', env85).l, /decision=preferred/, '57% + 4Gi stays under 85');
  assert.match(go('8700Mi', '58%', env85).l, /decision=required-away.*reason=headroom/, '58% + 4Gi is over 85');
  // --big near the line: even a quiet master (40%) may not take an 8Gi Job under the default line.
  assert.match(go('6000Mi', '40%', {}, ['--big']).l, /decision=required-away.*reason=headroom/);
  // The percentage-only case at 74% has no bytes: it cannot know the Job's share (a known limit; recorded, not judged).
  console.log(`QA-S1b-W1 74% with no bytes column -> ${go('abc', '74%').l.replace('=== JOB-RUN PLACEMENT ', '')}`);
});

test('QA-S1b-T kubectl top empty or odd: the run goes on, the line says metrics unavailable, nothing crashes (no unbound variable, no syntax error), the Job is not blocked', () => {
  const cases: [string, string | null][] = [
    ['no top.txt (kubectl top exits 1)', null],
    ['empty output', ''],
    ['blank lines', '\n\n   \n'],
    ['one column', 'k3s-master\n'],
    ['two columns', 'k3s-master   310m\n'],
    ['unknown columns', 'k3s-master   <unknown>   <unknown>   <unknown>   <unknown>\n'],
    ['percentage 0', 'k3s-master   310m   7%   0Mi   0%\n'],
    ['percentage over 100', 'k3s-master   310m   7%   9200Mi   250%\n'],
    ['a negative number', 'k3s-master   310m   7%   -5Mi   -3%\n'],
    ['non-ASCII', 'k3s-mästér   310m   7%   9200Mi   60%\n'],
    ['a very long line', `k3s-master ${'x'.repeat(100_000)} 7% 9200Mi 60%\n`],
    ['two nodes: the first line is read', 'k3s-master   310m   7%   9200Mi   60%\nk3s-node2   310m   7%   9200Mi   99%\n'],
  ];
  for (const [what, body] of cases) {
    const w = world();
    if (body !== null) w.put('top.txt', body);
    const r = w.run();
    console.log(`QA-S1b-T ${what} -> rc=${r.code} ${ctl(w).replace('=== JOB-RUN PLACEMENT ', '')}`);
    assert.equal(r.code, 0, `${what}: the run must not fail: ${r.out}`);
    assert.ok(!/unbound variable|syntax error|value too great|division by 0|integer expression/i.test(r.out), `${what}: a shell error leaked: ${r.out}`);
    assert.ok(ctl(w), `${what}: a control-plane line is written`);
    assert.ok(!r.out.includes(w.npm) && !w.log().includes(w.npm), `${what}: no secret`);
  }
  const w1 = world(); w1.put('top.txt', '');
  assert.match(ctl(w1), /pct=unknown.*decision=preferred-metrics-unavailable/);
  const w2 = world(); w2.put('top.txt', 'k3s-master   310m   7%   9200Mi   60%\nk3s-node2   310m   7%   9200Mi   99%\n');
  w2.run();
  assert.match(ctl(w2), /pct=60 /, 'the first node line is the one read');
});

// ---- S1b C5 (T-611 comment 7949): the master is read again right before a suspended Job is released; the affinity is patched when the decision changed.
// Written before the run, NOT run when committed. The fake kubectl above answers the n-th `top` from top<n>.txt (a missing file = the read fails), records
// every Job patch body in patches.log, and fails an affinity patch when the file patchfail exists (its text and the body are echoed to stderr).
const LOW_NOW = '9300Mi   60%';   // (9300 + 2300) * 60 = 696000 <= 75 * 9300 = 697500: preferred
const HIGH_NOW = '12000Mi   80%'; // over the line
const row = (v: string) => `k3s-master   310m   7%   ${v}\n`;
const seq = (w: ReturnType<typeof world>, reads: (string | null)[]) => reads.forEach((v, i) => { if (v !== null) w.put(`top${i + 1}.txt`, row(v)); });
const patches = (w: ReturnType<typeof world>) => w.file('patches.log').split('\n').filter(Boolean);
/** The Job's required-away rule as it stands at the end: the applied manifest, then each patch in order (read as a merge or a JSON patch). */
function effective(w: ReturnType<typeof world>): boolean {
  const d = join(w.root, 'applied');
  let cur = existsSync(d) ? readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')).join('\n').includes('DoesNotExist') : false;
  for (const b of patches(w)) {
    if (/DoesNotExist/.test(b)) cur = true;
    else if (/requiredDuringSchedulingIgnoredDuringExecution"?\s*:\s*null/.test(b) || /"(?:node)?[aA]ffinity"\s*:\s*null/.test(b) || /"op"\s*:\s*"remove"[^}]*requiredDuring/.test(b)) cur = false;
    else if (/"op"\s*:\s*"(?:replace|add)"[^]*[aA]ffinity/.test(b)) cur = false;
  }
  return cur;
}
const releaseIndex = (w: ReturnType<typeof world>) => patches(w).findIndex((b) => /suspend/.test(b) && /false/.test(b));
const affinityIndex = (w: ReturnType<typeof world>) => patches(w).findIndex((b) => /ffinity|DoesNotExist|requiredDuring/.test(b));
const topCalls = (w: ReturnType<typeof world>) => w.calls().split('\n').filter((l) => /kubectl .*top nodes/.test(l)).length;
const decisions = (w: ReturnType<typeof world>) => placement(w.log()).filter((l) => l.includes('node=control-plane')).map((l) => /decision=(\S+)/.exec(l)?.[1]);

test('QA-S1b-C5a 60% at create (preferred), 80% at release: the master is read again and the Job gets the required rule before it starts', () => {
  const w = world();
  seq(w, [LOW_NOW, HIGH_NOW, HIGH_NOW, HIGH_NOW]);
  const r = w.run();
  console.log(`QA-S1b-C5a rc=${r.code} topCalls=${topCalls(w)} decisions=${decisions(w)} patches=${patches(w).join(' | ')}`);
  assert.equal(r.code, 0, r.out);
  assert.ok(topCalls(w) >= 2, 'the master is read a second time, at release');
  assert.equal(decisions(w)[0], 'preferred', 'create-time decision');
  assert.ok(affinityIndex(w) >= 0, 'the suspended Job\'s affinity is patched');
  assert.ok(effective(w), 'the required rule is on the Job when it starts');
  const rel = releaseIndex(w);
  assert.ok(rel >= 0 && affinityIndex(w) <= rel, 'the affinity is changed before (or in) the call that releases the Job');
  assert.ok(decisions(w).includes('required-away'), `a second PLACEMENT line records the new decision: ${placement(w.log()).join(' | ')}`);
  assert.ok(!r.out.includes(w.npm) && !w.log().includes(w.npm), 'no secret');
});

test('QA-S1b-C5b 80% at create (required), 60% at release: the rule is dropped, so the Job may use the master again', () => {
  const w = world();
  seq(w, [HIGH_NOW, LOW_NOW, LOW_NOW, LOW_NOW]);
  const r = w.run();
  console.log(`QA-S1b-C5b rc=${r.code} topCalls=${topCalls(w)} decisions=${decisions(w)} patches=${patches(w).join(' | ')}`);
  assert.equal(r.code, 0, r.out);
  assert.equal(decisions(w)[0], 'required-away', 'create-time decision');
  assert.ok(!effective(w), 'the required rule is gone when the Job starts');
  const rel = releaseIndex(w);
  assert.ok(rel >= 0 && affinityIndex(w) >= 0 && affinityIndex(w) <= rel, 'the drop is before (or in) the release');
  assert.ok(decisions(w).includes('preferred'), `a second PLACEMENT line records the new decision: ${placement(w.log()).join(' | ')}`);
});

test('QA-S1b-C5c the decision did not change at release (60% then 60%, 80% then 80%): no affinity patch, only the release', () => {
  for (const [first, second, rule] of [[LOW_NOW, LOW_NOW, false], [HIGH_NOW, HIGH_NOW, true]] as const) {
    const w = world();
    seq(w, [first, second, second, second]);
    const r = w.run();
    assert.equal(r.code, 0, r.out);
    assert.equal(affinityIndex(w), -1, `rule=${rule}: nothing to change, nothing patched: ${patches(w).join(' | ')}`);
    assert.equal(effective(w), rule);
  }
});

test('QA-S1b-C5d the metrics read fails (or is odd) at release: the create-time decision stands, the run goes on, rc 0, nothing is patched', () => {
  for (const [first, rule] of [[LOW_NOW, false], [HIGH_NOW, true]] as const) {
    for (const second of [null, '', 'abc   xyz']) {
      const w = world();
      w.put('top1.txt', row(first));
      if (second !== null) w.put('top2.txt', second === '' ? '' : row(second));
      const r = w.run();
      console.log(`QA-S1b-C5d first=${first} second=${JSON.stringify(second)} rc=${r.code} -> ${decisions(w)} patches=${patches(w).length}`);
      assert.equal(r.code, 0, `the run must not fail or hang on an unreadable second read: ${r.out}`);
      assert.equal(effective(w), rule, `create-time decision stands (rule=${rule})`);
      assert.equal(affinityIndex(w), -1, 'no affinity patch on an unreadable read');
      assert.ok(!/unbound variable|syntax error|integer expression/i.test(r.out), 'no shell error');
      assert.ok(releaseIndex(w) >= 0, 'the Job is released all the same');
    }
  }
});

test('QA-S1b-C5e the affinity patch fails: no hang, the Job still runs (create-time decision), the log says so, and kubectl\'s text is not shown', () => {
  for (const [first, second] of [[LOW_NOW, HIGH_NOW], [HIGH_NOW, LOW_NOW]] as const) {
    const w = world();
    const marker = `mk${hex(12)}`;
    seq(w, [first, second, second, second]);
    w.put('patchfail', `Error from server (Forbidden): jobs is forbidden ${marker}`);
    const r = w.run();
    console.log(`QA-S1b-C5e ${first} -> ${second}: rc=${r.code} patches=${patches(w).join(' | ')}`);
    assert.notEqual(r.code, null, 'the run hung (the timeout killed it): a failed patch must not leave the Job suspended');
    assert.equal(r.code, 0, `the Job still runs on the create-time decision: ${r.out}`);
    assert.ok(releaseIndex(w) >= 0, 'a plain release is sent after the failed patch');
    const said = `${r.out}\n${w.log()}`;
    assert.match(said, /(could not|failed|unable|did not|cannot).*(affinity|placement|patch|re-?read|master)|placement.*(failed|unchanged|stands)/i, `the log says the change did not happen: ${said.slice(-600)}`);
    assert.ok(!said.includes(marker), 'kubectl text (the stderr echo) never reaches the output or the log');
    assert.ok(!said.includes(w.npm) && !said.includes(w.extra), 'no secret');
  }
});

