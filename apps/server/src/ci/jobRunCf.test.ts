// T-3542 (PILOT-1127): scripts/job-run.sh --backend cf|auto against a fake dispatcher (jobRunCfTestkit.ts). Nothing here reaches
// Cloudflare or a cluster: no kubectl is on PATH (a k8s call would fail the run), the credentials are made at runtime.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type CfScenario, startFakeCf } from './jobRunCfTestkit.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO, 'scripts/job-run.sh');
const METRICS = join(REPO, 'scripts/job-run-metrics.mjs');
const roots: string[] = [];
const kids: ChildProcess[] = [];
after(() => {
  kids.forEach((k) => k.kill('SIGKILL'));
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});
const hex = (n: number) => randomBytes(n).toString('hex');

function cfLog(rc: number, extra = '') {
  return (
    '=== JOB-RUN PLACEMENT backend=cf instance=standard-3 job=x decision=started\n' +
    `=== JOB-RUN checked out root at abc1234 in 1s\n=== JOB-RUN submodule apps/api at 5d2c777b9\nhello from memor.id\n${extra}` +
    `=== JOB-RUN SUMMARY root@abc1234 checkout=1s steps=2s run=42s rc=${rc} node=cf:SIN\n=== JOB-RUN EXIT ${rc}\n`
  );
}

async function world(scenario: CfScenario = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-jobrun-cf-'));
  roots.push(root);
  const home = join(root, 'home'),
    bin = join(root, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  // No kubectl at all: the cf path must never call it (a call fails loudly).
  writeFileSync(join(bin, 'kubectl'), '#!/bin/sh\necho "kubectl called: $*" >> "$FAKE_K"; exit 97\n', { mode: 0o755 });
  writeFileSync(join(root, 'gitconfig'), '');
  const key = hex(32);
  const fake = await startFakeCf(root, key, { log: cfLog(0), ...scenario });
  kids.push(fake.child);
  const gitlabToken = `gl${hex(20)}`;
  const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = {
      PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: root,
      FAKE_K: join(root, 'kubectl.log'),
      GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      JOB_RUN_POLL_S: '0.05',
      JOB_RUN_WATCH_PID: 'none',
      JOB_RUN_LOG: join(root, 'job.log'),
      JOB_RUN_CACHE_DIR: join(root, 'cache'),
      JOB_RUN_CF_URL: fake.url,
      JOB_RUN_CF_WORKSPACE: 'kohilabs',
      JOB_RUN_CF_KEY: key,
      GITLAB_TOKEN: gitlabToken,
      PILOT_SESSION_ID: 'chat-m',
      PILOT_AGENT: 'lane',
      ...over,
    };
    for (const [k, v] of Object.entries(e)) if (v === '\u0000unset') delete e[k];
    return e;
  };
  const run = (argv: string[], over: Record<string, string> = {}) => {
    const p = spawn('bash', [SCRIPT, ...argv], { env: env(over), cwd: root });
    kids.push(p);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const done = new Promise<{ code: number | null; out: string }>((res) => p.on('close', (code) => res({ code, out })));
    return { p, done, out: () => out };
  };
  const go = (argv: string[], over: Record<string, string> = {}) => run(argv, over).done;
  const kubectlCalls = () => (existsSync(join(root, 'kubectl.log')) ? readFileSync(join(root, 'kubectl.log'), 'utf8') : '');
  const log = () => readFileSync(join(root, 'job.log'), 'utf8');
  return { root, key, fake, gitlabToken, run, go, kubectlCalls, log, env };
}
const MEM = ['--backend', 'cf', '--repo', 'memorid', '--ref', 'stg'];

test('T-3542 a cf run: the spec (GitLab clone, submodule override, the credential in the body only), the log reassembled, the exit code, PLACEMENT and metrics', async () => {
  const w = await world({ log: cfLog(3) });
  const r = await w.go([...MEM, '--sub', 'apps/api@wave/x', '--timeout', '900', '--', 'npm run typecheck']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /cp-cf-s[0-9a-f]{8}: memorid:platforms\/root@stg \(npm-ci\) on Cloudflare \(standard-3\); --sub apps\/api@wave\/x/);
  assert.match(r.out, /hello from memor\.id\n/);
  assert.match(r.out, /rc=3 in \d+s \(queued \d+s\) on cloudflare:standard-3 \(SIN\)/);
  const reqs = w.fake.requests();
  assert.ok(reqs.every((q) => q.ok), 'every request was signed with the key');
  const post = reqs.find((q) => q.method === 'POST' && q.url === '/jobs');
  assert.ok(post);
  const spec = JSON.parse(post.body);
  assert.equal(spec.repoUrl, 'https://gitlab.com/memorid/platforms/root.git');
  assert.equal(spec.ref, 'stg');
  assert.deepEqual(spec.subs, [{ path: 'apps/api', ref: 'wave/x' }]);
  assert.equal(Buffer.from(spec.cmd, 'base64').toString(), 'npm run typecheck');
  assert.equal(spec.timeout, 900);
  assert.equal(spec.program, 'memorid');
  assert.equal(spec.chat, 'chat-m');
  assert.deepEqual(spec.creds, { user: 'oauth2', token: w.gitlabToken });
  assert.ok(reqs.some((q) => q.method === 'POST' && /\/heartbeat$/.test(q.url)), 'a heartbeat');
  assert.ok(!r.out.includes(w.gitlabToken) && !w.log().includes(w.gitlabToken), 'the token is in no output');
  assert.match(w.log(), /^=== JOB-RUN PLACEMENT backend=cf instance=standard-3 decision=admitted queued=\d+s$/m);
  assert.match(w.log(), /^=== JOB-RUN PLACEMENT backend=cf instance=standard-3 location=SIN decision=done/m);
  assert.match(w.log(), /^hello from memor\.id$/m, 'lines split across reads come out whole');
  assert.equal(w.kubectlCalls(), '', 'no kubectl call');
  const m = readFileSync(join(w.root, 'cache/metrics.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(m.length, 1);
  assert.equal(m[0].backend, 'cf');
  assert.equal(m[0].rc, 3);
  assert.equal(m[0].run_s, 42);
  assert.equal(m[0].start_s, 2);
  assert.equal(m[0].est_usd, 0.0123);
  assert.equal(m[0].infra_fail, false);
});

test('T-3542 a token the job prints is masked, and the run warns', async () => {
  const w = await world();
  w.fake.scenario({ log: cfLog(0, `git said ${'{T}'} twice ${'{T}'}\n`).replaceAll('{T}', w.gitlabToken) });
  const r = await w.go([...MEM, '--', 'true']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes(w.gitlabToken) && !w.log().includes(w.gitlabToken));
  assert.match(r.out, /git said \[redacted\] twice \[redacted\]/);
  assert.match(r.out, /WARNING: a credential was in the job's log/);
});

test('T-3542 cf refusals happen before any request (rc 2): k8s-only options, pool credentials, the deny role, the 60-minute cap, other repositories', async () => {
  const w = await world();
  const cases: [string[], RegExp, Record<string, string>?][] = [
    [['--image', 'registry.int.isnan.me/claudepilot/x:1'], /--image/],
    [['--node', 'k3s-node3'], /--node/],
    [['--cpu', '2'], /--cpu/],
    [['--against', 'abc'], /--against/],
    [['--also', 'memorid/x'], /--also/],
    [['--reuse'], /--reuse/],
    [['--timeout', '3601'], /over the cf cap of 3600s/],
    [['--role', 'konfersi-stg-deploy'], /stays on k8s/],
  ];
  for (const [extra, re, over] of cases) {
    const r = await w.go([...MEM, ...extra, '--', 'true'], over);
    assert.equal(r.code, 2, `${extra.join(' ')}: ${r.out}`);
    assert.match(r.out, re);
  }
  const other = await w.go(['--backend', 'cf', '--repo', 'claudepilot', '--ref', 'main', '--', 'true']);
  assert.equal(other.code, 2);
  assert.match(other.out, /memor\.id \(gitlab\.com\/memorid\) repositories only/);
  const unconf = await w.go([...MEM, '--', 'true'], { JOB_RUN_CF_URL: '\u0000unset' });
  assert.equal(unconf.code, 2);
  assert.match(unconf.out, /not configured here/);
  const nocred = await w.go([...MEM, '--', 'true'], { GITLAB_TOKEN: '\u0000unset' });
  assert.equal(nocred.code, 2);
  assert.match(nocred.out, /no credential for gitlab\.com/);
  const badsub = await w.go([...MEM, '--sub', '../x@stg', '--', 'true']);
  assert.equal(badsub.code, 2);
  assert.equal(w.fake.requests().length, 0, 'nothing reached the dispatcher');
  assert.equal(w.kubectlCalls(), '');
});

test('T-3542 --pool-env is refused on cf (no Secrets pool value goes to a Cloudflare container) before anything is sent', async () => {
  const w = await world();
  // The name check runs first (shared with k8s); an undelivered name dies there. Either way: rc 2 and no request.
  const r = await w.go([...MEM, '--pool-env', 'E2E_CF_ACCESS_CLIENT_ID', '--', 'true'], { E2E_CF_ACCESS_CLIENT_ID: `v${hex(10)}` });
  assert.equal(r.code, 2, r.out);
  assert.equal(w.fake.requests().length, 0);
});

test('T-3542 auto: cf only for a program in JOB_RUN_CF_PROGRAMS; otherwise the k8s path, as without --backend', async () => {
  const w = await world();
  // Not allowed: back to k8s, which cannot clone memor.id (the k8s refusal, as before), and no request to the dispatcher.
  const r1 = await w.go(['--backend', 'auto', '--repo', 'memorid', '--ref', 'stg', '--', 'true']);
  assert.equal(r1.code, 2, r1.out);
  assert.match(r1.out, /--repo: claudepilot, event or konfersi/);
  assert.equal(w.fake.requests().length, 0);
  const r2 = await w.go(['--repo', 'memorid', '--ref', 'stg', '--', 'true'], { JOB_RUN_BACKEND: 'auto', JOB_RUN_CF_PROGRAMS: 'claudepilot,memorid' });
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /on Cloudflare/);
  // An option k8s alone has: auto stays on k8s.
  const r3 = await w.go(['--repo', 'memorid', '--ref', 'stg', '--node', 'k3s-node3', '--', 'true'], { JOB_RUN_BACKEND: 'auto', JOB_RUN_CF_PROGRAMS: 'memorid' });
  assert.equal(r3.code, 2);
  assert.doesNotMatch(r3.out, /on Cloudflare/);
});

test('T-3542 queue and budget: 429 says "queued behind" once and retries; 402 ends with exit 1 and nothing runs', async () => {
  const w = await world({ queue429: 3, log: cfLog(0) });
  const r = await w.go([...MEM, '--', 'true']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.match(/queued behind 2 on Cloudflare \(at most 6 at once\)/g)?.length, 1);
  const b = await world({ budget: true });
  const rb = await b.go([...MEM, '--', 'true']);
  assert.equal(rb.code, 1, rb.out);
  assert.match(rb.out, /daily CF budget reached \(total: \$5\.01 of \$5\): not started/);
  assert.match(b.log(), /decision=budget-refused scope=total/);
  assert.ok(!b.fake.requests().some((q) => q.url.includes('/log')), 'no log was read');
});

test('T-3542 the dispatcher refusing: a bad key is exit 1, a bad spec rc 2, with fixed messages', async () => {
  const w = await world({ submitStatus: 401 });
  const r = await w.go([...MEM, '--', 'true'], { JOB_RUN_CF_KEY: hex(32) });
  assert.equal(r.code, 1);
  assert.match(r.out, /refused this workspace's key \(401\)/);
  w.fake.scenario({ submitStatus: 400 });
  const r2 = await w.go([...MEM, '--', 'true']);
  assert.equal(r2.code, 2);
  assert.match(r2.out, /the dispatcher refused the job: refused by the fake/);
});

test('T-3542 the key derived from CF_RUNNER_API_TOKEN (no JOB_RUN_CF_KEY) signs as the dispatcher expects', async () => {
  const token = `cf${hex(24)}`;
  const derived = createHmac('sha256', token).update('cp-jobrun-key-v1\nkohilabs').digest('hex');
  const root = mkdtempSync(join(tmpdir(), 'cp-jobrun-cfk-'));
  roots.push(root);
  const fake = await startFakeCf(root, derived, { log: cfLog(0) });
  kids.push(fake.child);
  const w = await world();
  const r = await w.go([...MEM, '--', 'true'], { JOB_RUN_CF_URL: fake.url, JOB_RUN_CF_KEY: '\u0000unset', CF_RUNNER_API_TOKEN: token });
  assert.equal(r.code, 0, r.out);
  assert.ok(fake.requests().length > 0 && fake.requests().every((q) => q.ok));
  assert.ok(!fake.requests().some((q) => q.body.includes(token)), 'the token itself is never sent');
});

test('T-3542 no exit line: deadline is 124, stopped is 1, a platform failure is 1 and says infra', async () => {
  const head = '=== JOB-RUN PLACEMENT backend=cf decision=started\nworking\n';
  for (const [state, code, re] of [
    ['deadline', 124, /past the deadline/],
    ['cancelled', 1, /was stopped before it finished/],
    ['infra', 1, /the Cloudflare container failed \(container stopped\): infra failure/],
  ] as const) {
    const w = await world({ log: head, state });
    const r = await w.go([...MEM, '--', 'sleep 1']);
    assert.equal(r.code, code, `${state}: ${r.out}`);
    assert.match(r.out, re);
    const m = JSON.parse(readFileSync(join(w.root, 'cache/metrics.jsonl'), 'utf8').trim());
    assert.equal(m.infra_fail, state === 'infra');
  }
  const p = await world({ log: `${head}=== JOB-RUN PLATFORM-STOP the container got SIGTERM\n=== JOB-RUN EXIT 143\n` });
  const rp = await p.go([...MEM, '--', 'true']);
  assert.equal(rp.code, 143);
  assert.match(rp.out, /stopped by the platform \(infra failure\)/);
});

test('T-3542 artifacts come back from R2 through the dispatcher and unpack into --out', async () => {
  const src = mkdtempSync(join(tmpdir(), 'cp-jobrun-art-'));
  roots.push(src);
  mkdirSync(join(src, 'reports'));
  writeFileSync(join(src, 'reports/junit.xml'), '<testsuites tests="9"/>');
  const tgz = spawnSync('tar', ['-czf', '-', '-C', src, 'reports']).stdout.toString('base64');
  const w = await world({ artifactsB64: tgz });
  const out = join(w.root, 'out');
  const r = await w.go([...MEM, '--artifacts', 'reports', '--out', out, '--', 'true']);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(out, 'reports/junit.xml'), 'utf8'), '<testsuites tests="9"/>');
  assert.equal(JSON.parse(w.fake.requests().find((q) => q.url === '/jobs')!.body).artifacts, 'reports');
});

test('T-3542 interrupted while the job runs: the trap cancels it on the dispatcher (DELETE), exit 130', async () => {
  const w = await world({ log: '=== JOB-RUN PLACEMENT backend=cf decision=started\nrunning...\n', hang: true });
  const h = w.run([...MEM, '--', 'sleep 600']);
  const t = Date.now();
  while (!w.fake.requests().some((q) => q.url.includes('/log?offset='))) {
    if (Date.now() - t > 15_000) throw new Error(`no log read: ${h.out()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  h.p.kill('SIGTERM');
  const r = await h.done;
  assert.equal(r.code, 130, r.out);
  assert.ok(w.fake.requests().some((q) => q.method === 'DELETE' && /^\/jobs\/cp-cf-s[0-9a-f]{8}\?reason=job-run\.sh$/.test(q.url)), 'cancelled');
});

test('T-3542 --stop <cp-cf id> and --list reach the dispatcher; without JOB_RUN_CF_URL --list prints only the k8s list', async () => {
  const w = await world();
  const r0 = await w.go([...MEM, '--', 'true']);
  assert.equal(r0.code, 0, r0.out);
  const id = /cp-cf-s[0-9a-f]{8}/.exec(r0.out)![0];
  const l = await w.go(['--list']);
  assert.match(l.out, new RegExp(`${id}\\tchat-m\\tlane\\tfinished`));
  const s = await w.go(['--stop', id]);
  assert.match(s.out, new RegExp(`stopped ${id}`));
  assert.ok(w.fake.requests().some((q) => q.method === 'DELETE' && q.url.startsWith(`/jobs/${id}`)));
  const n = w.fake.requests().length;
  const l2 = await w.go(['--list'], { JOB_RUN_CF_URL: '\u0000unset' });
  assert.doesNotMatch(l2.out, /cp-cf-/);
  assert.equal(w.fake.requests().length, n);
});

test('T-3542 CFR-8 job-run-metrics.mjs: one row per backend (p50/p90, infra %, cost), bad lines skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-jobrun-met-'));
  roots.push(dir);
  const f = join(dir, 'm.jsonl');
  const L = (o: object) => JSON.stringify({ t: '2026-11-03T01:00:00Z', program: 'memorid', ...o });
  writeFileSync(
    f,
    [
      L({ backend: 'cf', queue_s: 1, start_s: 30, run_s: 60, wall_s: 95, rc: 0, est_usd: 0.004, infra_fail: false }),
      L({ backend: 'cf', queue_s: 3, start_s: 40, run_s: 500, wall_s: 545, rc: 1, est_usd: 0.021, infra_fail: true }),
      L({ backend: 'k8s', queue_s: 190, start_s: null, run_s: 61, wall_s: 70, rc: 0, est_usd: 0, infra_fail: false }),
      'not json',
      L({ t: '2026-10-01T00:00:00Z', backend: 'k8s', queue_s: 999, run_s: 1, wall_s: 1, rc: 0, infra_fail: false }),
    ].join('\n'),
  );
  const r = spawnSync(process.execPath, [METRICS, f, '--since', '2026-11-01', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.skipped, 1);
  const cf = j.groups.find((g: { group: string }) => g.group === 'cf');
  const k8s = j.groups.find((g: { group: string }) => g.group === 'k8s');
  assert.deepEqual([cf.runs, cf.queue_p50, cf.queue_p90, cf.run_p90, cf.rc_nonzero, cf.infra_fail_pct, cf.est_usd], [2, 1, 3, 500, 1, 50, 0.025]);
  assert.deepEqual([k8s.runs, k8s.queue_p90, k8s.start_p50], [1, 190, null]);
  const t = spawnSync(process.execPath, [METRICS, f], { encoding: 'utf8' });
  assert.match(t.stdout, /^group\s+runs\s+queue_p50/);
  assert.match(t.stdout, /\(1 line\(s\) skipped: not JSON\)/);
});
