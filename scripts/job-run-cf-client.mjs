#!/usr/bin/env node
// The HTTP side of `scripts/job-run.sh --backend cf` (T-3542): every request to the dispatcher (deploy/cf-runner) is signed here, so no
// key or token is ever on a command line (they come from the environment) or in a shell variable that xtrace could print.
//   job-run-cf-client.mjs submit                 the job spec (JSON) on stdin; prints "<http status> <response JSON>"
//   job-run-cf-client.mjs follow <id> <info>     the job's log on stdout, complete lines only, until the job ends; posts a heartbeat
//                                                every 15 s; then the job's final state as JSON into the file <info>
//   job-run-cf-client.mjs get|cancel <id>        prints "<status> <JSON>"
//   job-run-cf-client.mjs artifacts <id> <file>  the artifacts tar.gz into <file>; exit 0 saved, 3 none, 1 error
//   job-run-cf-client.mjs list [<chat>]          prints "<status> <JSON>"
//   job-run-cf-client.mjs budget                 prints "<status> <JSON>": today's ledger, the running jobs, the limits
// Environment: JOB_RUN_CF_URL (https://...), JOB_RUN_CF_WORKSPACE (the key's id, e.g. kohilabs), and the key: JOB_RUN_CF_KEY (64 hex), or
// else derived from CF_RUNNER_API_TOKEN as HMAC-SHA256(token, "cp-jobrun-key-v1\n" + workspace) (deploy/cf-runner/deploy.sh sets the
// same value on the Worker; the token itself never goes to the Worker). JOB_RUN_POLL_S (default 5) is the log poll.
import { createHash, createHmac } from 'node:crypto';
import { createWriteStream, writeFileSync } from 'node:fs';

const die = (m, rc = 2) => {
  process.stderr.write(`job-run: ${m}\n`);
  process.exit(rc);
};
const base = process.env.JOB_RUN_CF_URL ?? '';
if (!/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(base)) die('JOB_RUN_CF_URL: the dispatcher base URL (https://<host>, no path)');
const ws = process.env.JOB_RUN_CF_WORKSPACE ?? '';
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(ws)) die('JOB_RUN_CF_WORKSPACE: the workspace id of the dispatcher key (a-z, 0-9, -)');
let key = process.env.JOB_RUN_CF_KEY ?? '';
if (!key) {
  const t = process.env.CF_RUNNER_API_TOKEN ?? '';
  if (t.length < 20) die('no dispatcher key: JOB_RUN_CF_KEY or CF_RUNNER_API_TOKEN (from the Secrets pool) must be set');
  key = createHmac('sha256', t).update(`cp-jobrun-key-v1\n${ws}`).digest('hex');
}
if (!/^[0-9a-f]{64}$/.test(key)) die('JOB_RUN_CF_KEY: 64 hex characters');
const poll = Math.max(0.05, Number(process.env.JOB_RUN_POLL_S ?? 5) || 5) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const raw = body === undefined ? '' : body;
  const ts = String(Math.floor(Date.now() / 1000));
  const h = createHash('sha256').update(raw).digest('hex');
  const sig = createHmac('sha256', key).update(`${method}\n${path}\n${ts}\n${h}`).digest('hex');
  return fetch(base + path, {
    method,
    body: body === undefined ? undefined : raw,
    headers: { 'x-jobrun-key': ws, 'x-jobrun-ts': ts, 'x-jobrun-sig': sig, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
}
const out = async (r) => process.stdout.write(`${r.status} ${(await r.text()).replace(/\s+$/, '')}\n`);
const readStdin = async () => {
  const parts = [];
  for await (const c of process.stdin) parts.push(c);
  return Buffer.concat(parts).toString('utf8');
};
const ID = /^cp-cf-[sb][0-9a-f]{8}$/;
const [cmd, a1, a2] = process.argv.slice(2);

try {
  if (cmd === 'submit') await out(await call('POST', '/jobs', await readStdin()));
  else if (cmd === 'get' || cmd === 'cancel') {
    if (!ID.test(a1 ?? '')) die('a cp-cf job id');
    await out(await call(cmd === 'get' ? 'GET' : 'DELETE', `/jobs/${a1}${cmd === 'cancel' ? '?reason=job-run.sh' : ''}`));
  } else if (cmd === 'list') {
    await out(await call('GET', a1 ? `/jobs?chat=${encodeURIComponent(a1)}` : '/jobs'));
  } else if (cmd === 'budget') {
    await out(await call('GET', '/budget'));
  } else if (cmd === 'artifacts') {
    if (!ID.test(a1 ?? '') || !a2) die('artifacts <id> <file>');
    const r = await call('GET', `/jobs/${a1}/artifacts`);
    if (r.status === 404) process.exit(3);
    if (!r.ok) die(`artifacts: HTTP ${r.status}`, 1);
    const f = createWriteStream(a2, { mode: 0o600 });
    for await (const c of r.body) f.write(c);
    await new Promise((res) => f.end(res));
  } else if (cmd === 'follow') {
    if (!ID.test(a1 ?? '') || !a2) die('follow <id> <info file>');
    let off = 0;
    let pending = Buffer.alloc(0);
    let info = null;
    let errors = 0;
    let lastBeat = 0;
    for (;;) {
      if (Date.now() - lastBeat >= 15_000) {
        lastBeat = Date.now();
        await call('POST', `/jobs/${a1}/heartbeat`).catch(() => {});
      }
      let r;
      try {
        r = await call('GET', `/jobs/${a1}/log?offset=${off}`);
      } catch {
        r = null;
      }
      if (!r || r.status >= 500) {
        // A network blip or a dispatcher restart: the offset makes the retry exact. Ten minutes of nothing ends the follow.
        if (++errors * poll > 600_000) {
          info = { state: 'unreachable', exit: null };
          break;
        }
        await sleep(poll);
        continue;
      }
      if (r.status !== 200) {
        info = { state: r.status === 404 ? 'gone' : `http-${r.status}`, exit: null };
        break;
      }
      errors = 0;
      const chunk = Buffer.from(await r.arrayBuffer());
      off = Number(r.headers.get('x-next-offset') ?? off + chunk.length);
      const state = r.headers.get('x-state') ?? '';
      pending = Buffer.concat([pending, chunk]);
      const nl = pending.lastIndexOf(10);
      if (nl >= 0) {
        process.stdout.write(pending.subarray(0, nl + 1));
        pending = pending.subarray(nl + 1);
      }
      const terminal = ['finished', 'cancelled', 'deadline', 'infra'].includes(state);
      if (terminal && chunk.length === 0) {
        if (pending.length) process.stdout.write(Buffer.concat([pending, Buffer.from('\n')]));
        const g = await call('GET', `/jobs/${a1}`);
        info = g.ok ? await g.json() : { state, exit: r.headers.get('x-exit') ? Number(r.headers.get('x-exit')) : null };
        break;
      }
      if (chunk.length === 0) await sleep(poll);
    }
    writeFileSync(a2, JSON.stringify(info));
  } else die('usage: job-run-cf-client.mjs submit|follow|get|cancel|artifacts|list|budget ...');
} catch (e) {
  die(`the dispatcher did not answer (${String(e?.name ?? 'error')})`, 1);
}
