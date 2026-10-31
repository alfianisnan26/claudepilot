// scripts/actions-door.mjs (T-3192): the read-only Gitea Actions door. A mocked fetch stands in for git.konfersi.com (no network);
// the token is built here at run time and written to a temp file, as the Secrets pool delivers it. Checked: the runs listing and the
// step log tail, the --lines cap, GET as the only method, the pinned host, every refusal of a bad argument, the missing variable,
// 401/403/404, the token absent from every output (errors too), and the redaction of credential-shaped log lines.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDirectory } from '../store/testTmp.js';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/actions-door.mjs', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const door: any = await import(SCRIPT);

// Not a real credential: built at run time, in no known key shape, so only the door's literal scrub can catch it.
const TOKEN = ['door', 'Q'.repeat(12), String(process.pid)].join('');
const SHA = 'c'.repeat(40);

function tokenFile(content = `${TOKEN}\n`): string {
  const file = join(tempDirectory('cp-actions-door-'), 'token');
  writeFileSync(file, content);
  return file;
}

type Call = { url: string; init: RequestInit };
type Route = (url: URL) => { status?: number; json?: unknown; text?: string } | undefined;

function api(route: Route) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = route(new URL(url)) ?? { status: 404, json: { message: 'not found' } };
    const status = r.status ?? 200;
    const body = r.text ?? JSON.stringify(r.json ?? {});
    return new Response(body, { status, headers: { 'content-type': r.text === undefined ? 'application/json' : 'text/plain' } });
  };
  return { calls, fetchImpl };
}

async function run(argv: string[], route: Route, env: Record<string, string | undefined> = { [door.TOKEN_ENV]: tokenFile() }) {
  const { calls, fetchImpl } = api(route);
  const out: string[] = [];
  const err: string[] = [];
  const code = await door.main(argv, { env, fetchImpl, out: (l: string) => out.push(l), err: (l: string) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n'), calls };
}

const RUNS = '/api/v1/repos/platform/konfersi-compute/actions/runs';
const jobs = {
  jobs: [
    {
      id: 71,
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      steps: [
        { name: 'Set up job', number: 1, status: 'completed', conclusion: 'success' },
        { name: 'Run pytest', number: 2, status: 'completed', conclusion: 'failure' },
      ],
    },
    { id: 72, name: 'lint', status: 'completed', conclusion: 'success', steps: [{ name: 'Run ruff', number: 1, conclusion: 'success' }] },
  ],
};

function world(log = ''): Route {
  return (u) => {
    if (u.pathname === RUNS)
      return {
        json: {
          total_count: 2,
          workflow_runs: [
            { id: 9001, head_sha: SHA, head_branch: 'stg', status: 'completed', conclusion: 'failure', event: 'push', display_title: 'wind lab' },
            { id: 9002, head_sha: 'd'.repeat(40), head_branch: 'other', status: 'completed', conclusion: 'success', event: 'push' },
          ],
        },
      };
    if (u.pathname === `${RUNS}/9001/jobs`) return { json: jobs };
    if (u.pathname === '/api/v1/repos/platform/konfersi-compute/actions/jobs/71/logs') return { text: log };
    return undefined;
  };
}

function jobLog(): string {
  const ts = (i: number) => `2026-10-31T00:00:${String(i % 60).padStart(2, '0')}.0000000Z`;
  const lines: string[] = [];
  lines.push(`${ts(0)} ⭐ Run Main Set up job`, `${ts(1)} setting up`);
  lines.push(`${ts(2)} ⭐ Run Main Run pytest`);
  for (let i = 1; i <= 250; i++) lines.push(`${ts(i)} pytest line ${i}`);
  lines.push(`${ts(3)} ⭐ Run Post Run pytest cleanup`, `${ts(4)} after the step`);
  return lines.join('\n') + '\n';
}

test('runs: one block per run of the branch, with the full head sha and each job’s steps and their results', async () => {
  const r = await run(['runs', 'konfersi-compute', 'stg'], world());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^run 9001 {2}failure$/m);
  assert.match(r.out, new RegExp(`^  sha ${SHA}$`, 'm'));
  assert.match(r.out, /^ {2}job test: failure$/m);
  assert.match(r.out, /^ {4}success {3}Set up job$/m);
  assert.match(r.out, /^ {4}failure {3}Run pytest$/m);
  assert.match(r.out, /^ {2}job lint: success$/m);
  assert.doesNotMatch(r.out, /9002/, 'a run of another branch is filtered out even when the server ignores ?branch');
  const first = new URL(r.calls[0]!.url);
  assert.equal(first.searchParams.get('branch'), 'stg');
  assert.equal(first.searchParams.get('limit'), '5');
});

test('runs: an empty list says so; --limit is capped at 20', async () => {
  const r = await run(['runs', 'platform/konfersi-compute', 'main', '--limit', '500'], (u) => (u.pathname === RUNS ? { json: { workflow_runs: [] } } : undefined));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'konfersi-compute main: no Actions runs');
  assert.equal(new URL(r.calls[0]!.url).searchParams.get('limit'), '20');
});

test('log: the last 40 lines of the named step only, timestamps off', async () => {
  const r = await run(['log', 'konfersi-compute', '9001', 'Run pytest'], world(jobLog()));
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'run 9001  job test: failure  step Run pytest: failure');
  assert.equal(lines[1], "(the last 40 of the step's 251 lines)");
  assert.deepEqual(
    lines.slice(2),
    Array.from({ length: 40 }, (_, i) => `pytest line ${211 + i}`),
  );
  assert.doesNotMatch(r.out, /after the step|cleanup/, 'the next step is not part of this one');
});

test('log: --lines picks the count and is capped at 200', async () => {
  const ten = await run(['log', 'konfersi-compute', '9001', 'Run pytest', '--lines', '10'], world(jobLog()));
  assert.equal(ten.code, 0, ten.err);
  assert.equal(ten.out.split('\n').length, 2 + 10);
  const big = await run(['log', 'konfersi-compute', '9001', 'Run pytest', '--lines', '9999'], world(jobLog()));
  assert.equal(big.code, 0, big.err);
  assert.equal(big.out.split('\n').length, 2 + 200);
  assert.match(big.out, /the last 200 of the step's 251 lines/);
});

test('log: a step with no start marker falls back to the whole job’s tail and says so', async () => {
  const r = await run(['log', 'konfersi-compute', '9001', 'Set up job', '--lines', '3'], world('one\ntwo\nthree\nfour\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /no start marker for this step/);
  assert.deepEqual(r.out.split('\n').slice(-3), ['two', 'three', 'four']);
});

test('log: an unknown step is 4 with the run’s step names; a step in two jobs asks for --job', async () => {
  const none = await run(['log', 'konfersi-compute', '9001', 'Run nothing'], world());
  assert.equal(none.code, 4);
  assert.match(none.err, /no step named "Run nothing" in run 9001; its steps: Set up job \| Run pytest \| Run ruff/);
  const twice: Route = (u) =>
    u.pathname === `${RUNS}/9001/jobs`
      ? { json: { jobs: [jobs.jobs[0], { ...jobs.jobs[0], id: 73, name: 'test-2' }] } }
      : u.pathname.endsWith('/actions/jobs/73/logs')
        ? { text: 'x\n' }
        : undefined;
  const amb = await run(['log', 'konfersi-compute', '9001', 'Run pytest'], twice);
  assert.equal(amb.code, 1);
  assert.match(amb.err, /in 2 jobs; name one with --job: test \| test-2/);
  const picked = await run(['log', 'konfersi-compute', '9001', 'Run pytest', '--job', 'test-2'], twice);
  assert.equal(picked.code, 0, picked.err);
  assert.match(picked.out, /job test-2/);
});

test('every request is a GET without a body, to the pinned host and the platform organisation, with no redirect followed', async () => {
  const r1 = await run(['runs', 'konfersi-compute', 'stg'], world());
  const r2 = await run(['log', 'konfersi-compute', '9001', 'Run pytest'], world(jobLog()));
  const calls = [...r1.calls, ...r2.calls];
  assert.ok(calls.length >= 4);
  for (const c of calls) {
    assert.equal(c.init.method, 'GET');
    assert.equal(c.init.body, undefined);
    assert.equal(c.init.redirect, 'error');
    assert.ok(c.url.startsWith('https://git.konfersi.com/api/v1/repos/platform/konfersi-compute/actions/'), c.url);
    assert.ok(c.init.signal, 'a timeout signal');
  }
  assert.equal(door.HOST, 'https://git.konfersi.com');
  assert.equal(door.CAPS.timeoutMs, 20_000);
  // The script has one fetch call site, and its method is a literal GET.
  const source = readFileSync(SCRIPT, 'utf8');
  assert.equal(source.match(/fetchImpl\(/g)?.length, 1);
  assert.doesNotMatch(source, /method:\s*['"](?!GET['"])/);
});

test('refusals: bad repo, bad branch, non-digit run id, bad step, a host or token option; nothing is fetched', async () => {
  const cases: [string[], RegExp][] = [
    [['runs', 'other-repo', 'stg'], /repo must be konfersi-/],
    [['runs', 'evil/konfersi-compute', 'stg'], /repo must be konfersi-/],
    [['runs', 'Konfersi-Compute', 'stg'], /repo must be konfersi-/],
    [['runs', 'konfersi-compute', '../main'], /branch:/],
    [['runs', 'konfersi-compute', 'a..b'], /branch:/],
    [['runs', 'konfersi-compute', 'x'.repeat(201)], /branch:/],
    [['log', 'konfersi-compute', '12a', 'Run pytest'], /run id: digits only/],
    [['log', 'konfersi-compute', '../1', 'Run pytest'], /run id: digits only/],
    [['log', 'konfersi-compute', '1', 'bad\u0007step'], /step name/],
    [['log', 'konfersi-compute', '1', 's'.repeat(201)], /step name/],
    [['log', 'konfersi-compute', '1', 'Run pytest', '--lines', 'many'], /--lines: a whole number/],
    [['runs', 'konfersi-compute', 'stg', '--host', 'https://example.invalid'], /unknown option --host/],
    [['runs', 'konfersi-compute', 'stg', '--base=https://example.invalid'], /unknown option --base/],
    [['runs', 'konfersi-compute', 'stg', '--token=whatever'], /unknown option --token$/],
    [['delete', 'konfersi-compute', 'stg'], /usage:/],
  ];
  for (const [argv, re] of cases) {
    const r = await run(argv, world());
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, re, argv.join(' '));
    assert.equal(r.calls.length, 0, argv.join(' '));
    assert.doesNotMatch(r.err, /whatever/);
  }
});

test('the token: a missing variable or file is exit 2 naming the variable, before any request', async () => {
  const unset = await run(['runs', 'konfersi-compute', 'stg'], world(), {});
  assert.equal(unset.code, 2);
  assert.match(unset.err, /GITEA_ACTIONS_READ_TOKEN_FILE is not set/);
  assert.equal(unset.calls.length, 0);
  const missing = await run(['runs', 'konfersi-compute', 'stg'], world(), { [door.TOKEN_ENV]: join(tempDirectory('cp-actions-door-'), 'absent') });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /the file named by GITEA_ACTIONS_READ_TOKEN_FILE cannot be read/);
  const empty = await run(['runs', 'konfersi-compute', 'stg'], world(), { [door.TOKEN_ENV]: tokenFile('  \n') });
  assert.equal(empty.code, 2);
  assert.match(empty.err, /does not hold one token/);
});

test('the command line itself: exit 2 without the variable, exit 1 for a foreign host option (no network either way)', () => {
  const env = { PATH: process.env.PATH ?? '' };
  const a = spawnSync(process.execPath, [SCRIPT, 'runs', 'konfersi-compute', 'stg'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(a.status, 2, a.stderr);
  assert.match(a.stderr, /GITEA_ACTIONS_READ_TOKEN_FILE is not set/);
  const b = spawnSync(process.execPath, [SCRIPT, 'runs', 'konfersi-compute', 'stg', '--host', 'https://example.invalid'], {
    env: { ...env, [door.TOKEN_ENV]: tokenFile() },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(b.status, 1, b.stderr);
  assert.match(b.stderr, /unknown option --host/);
  assert.ok(!(a.stdout + a.stderr + b.stdout + b.stderr).includes(TOKEN));
});

test('HTTP answers: 401 and 403 say the token lacks actions read (3), 404 is not found (4), 500 and a timeout are 5', async () => {
  for (const status of [401, 403]) {
    const r = await run(['runs', 'konfersi-compute', 'stg'], () => ({ status, json: { message: `bad token ${TOKEN}` } }));
    assert.equal(r.code, 3);
    assert.match(r.err, new RegExp(`HTTP ${status}: the token lacks actions read`));
  }
  const nf = await run(['log', 'konfersi-compute', '9001', 'Run pytest'], () => undefined);
  assert.equal(nf.code, 4);
  assert.match(nf.err, /not found \(HTTP 404\)/);
  const five = await run(['runs', 'konfersi-compute', 'stg'], () => ({ status: 500, text: TOKEN }));
  assert.equal(five.code, 5);
  assert.match(five.err, /HTTP 500/);
  const out: string[] = [];
  const slow = async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
  const code = await door.main(['runs', 'konfersi-compute', 'stg'], {
    env: { [door.TOKEN_ENV]: tokenFile() },
    fetchImpl: slow,
    timeoutMs: 30,
    out: (l: string) => out.push(l),
    err: (l: string) => out.push(l),
  });
  assert.equal(code, 5);
  assert.match(out.join('\n'), /timed out after 0 s|timed out/);
});

test('the token never reaches stdout or stderr: not from the API’s answers, not from the log, not in errors', async () => {
  const echoing: Route = (u) => {
    if (u.pathname === RUNS)
      return { json: { workflow_runs: [{ id: 9001, head_sha: TOKEN, head_branch: 'stg', conclusion: TOKEN, event: 'push', display_title: `t ${TOKEN}` }] } };
    if (u.pathname === `${RUNS}/9001/jobs`)
      return { json: { jobs: [{ id: 71, name: `job ${TOKEN}`, conclusion: 'success', steps: [{ name: 'Run pytest', conclusion: TOKEN }] }] } };
    if (u.pathname.endsWith('/actions/jobs/71/logs')) return { text: `⭐ Run Main Run pytest\nthe header was token ${TOKEN}\nplain ${TOKEN}\n` };
    return undefined;
  };
  const results = [
    await run(['runs', 'konfersi-compute', 'stg'], echoing),
    await run(['log', 'konfersi-compute', '9001', 'Run pytest'], echoing),
    await run(['log', 'konfersi-compute', '9001', 'No step'], echoing),
    await run(['runs', 'konfersi-compute', 'stg'], () => ({ status: 403, text: TOKEN })),
    await run(['runs', 'konfersi-compute', 'stg'], () => {
      throw new Error(`boom ${TOKEN}`);
    }),
  ];
  for (const r of results) {
    assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN), `${r.out}\n${r.err}`);
    for (const c of r.calls) assert.ok(!c.url.includes(TOKEN), 'the token is never in a URL');
  }
  assert.match(results[1]!.out, /plain \[redacted\]/);
  // It travels only in the Authorization header.
  assert.equal((results[0]!.calls[0]!.init.headers as Record<string, string>).Authorization, `token ${TOKEN}`);
});

test('redaction of credential-shaped log lines', () => {
  const hex = 'b'.repeat(40);
  const b64 = ['A1b2', 'C'.repeat(20), 'd3E4', 'f'.repeat(20)].join('');
  const gh = ['gh', 'p_', 'X'.repeat(36)].join('');
  const cases: [string, RegExp, string][] = [
    [`Authorization: token ${hex}`, /^Authorization: \[redacted\]$/, hex],
    [`curl -H "Authorization: Bearer ${b64}"`, /Authorization: \[redacted\]/, b64],
    [`GITEA_TOKEN=${'k9'.repeat(10)}`, /^GITEA_TOKEN=\[redacted\]$/, 'k9'.repeat(10)],
    [`"password": "${'p4ss'.repeat(4)}"`, /"password": "\[redacted\]"/, 'p4ss'.repeat(4)],
    [`pushed with ${gh} ok`, /pushed with \[redacted\] ok/, gh],
    [`a value ${hex} here`, /a value \[redacted\] here/, hex],
    [`blob ${b64} end`, /blob \[redacted\] end/, b64],
    [`colour \u001b[31mred\u001b[0m and a bell\u0007`, /^colour red and a bell$/, '\u001b'],
  ];
  for (const [line, re, gone] of cases) {
    const clean = door.cleanLine(line, '');
    assert.match(clean, re, line);
    assert.ok(!clean.includes(gone), line);
  }
  assert.equal(door.cleanLine('3 passed, 1 failed in 2.31s', ''), '3 passed, 1 failed in 2.31s', 'ordinary text stays');
  assert.equal(door.cleanLine(`x ${TOKEN} y`, TOKEN), 'x [redacted] y');
});
