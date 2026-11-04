// The runner's main process (T-3542): a small HTTP server on :8080 that the job's Durable Object talks to. It holds NO credential, ever:
// the clone's token is added outside the container by the dispatcher's Egress handler, during the fetch phase only.
//   GET  /health                 200 once listening
//   POST /run {job, repoUrl, ref, subs, steps, cmd, artifacts, artifactMax}   once: trust the egress CA, fetch.sh, leave the fetch phase
//                                (POST http://control.jobrun/phase/run, which drops the credential), then run.sh
//   GET  /log?offset=&max=       the combined log from offset (bytes)
//   GET  /status                 {phase, done, exit, location}
// SIGTERM (a host restart): the job is killed, the log says PLATFORM-STOP and EXIT 143 (job-run.sh treats that as an infra failure).
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const LOG = '/var/log/jobrun.log';
const CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const BUNDLE = '/etc/ssl/jobrun-bundle.pem';
writeFileSync(LOG, '');
const st = { phase: 'idle', done: false, exit: null, started: false, child: null };
const say = (t) => appendFileSync(LOG, `=== JOB-RUN ${t}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const location = [process.env.CLOUDFLARE_LOCATION, process.env.CLOUDFLARE_REGION].filter(Boolean).join('/') || undefined;

function run(script, env) {
  return new Promise((resolve) => {
    const fd = openSync(LOG, 'a');
    const c = spawn('bash', [script], { env, stdio: ['ignore', fd, fd], detached: true });
    st.child = c;
    c.on('exit', (code, sig) => {
      closeSync(fd);
      st.child = null;
      resolve(code ?? (sig ? 128 + 15 : 1));
    });
    c.on('error', () => resolve(127));
  });
}

async function trustEgressCa() {
  for (let i = 0; i < 60 && !existsSync(CA); i++) await sleep(500);
  if (!existsSync(CA)) return false;
  const sys = readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8');
  writeFileSync(BUNDLE, `${sys}\n${readFileSync(CA, 'utf8')}\n`);
  return true;
}

async function job(spec) {
  const caOk = await trustEgressCa();
  if (!caOk) say('the egress CA did not appear in 30s: HTTPS through the dispatcher will fail');
  const env = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
    HOME: '/root',
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/ms-playwright',
    SSL_CERT_FILE: BUNDLE,
    GIT_SSL_CAINFO: BUNDLE,
    CURL_CA_BUNDLE: BUNDLE,
    REQUESTS_CA_BUNDLE: BUNDLE,
    NODE_EXTRA_CA_CERTS: CA,
    JR_ROOT: '/work',
    JR_REPO_URL: spec.repoUrl,
    JR_REF: spec.ref,
    JR_SUBS: (spec.subs ?? []).map((s) => `${s.path}=${s.ref}`).join(' '),
    JR_STEPS: spec.steps,
    JR_CMD: spec.cmd,
    JR_ARTIFACTS: spec.artifacts ?? '',
    JR_ARTIFACT_MAX: String(spec.artifactMax ?? 0),
    JR_LOCATION: location ?? '?',
  };
  st.phase = 'fetch';
  const frc = await run('/opt/jobrun/fetch.sh', env);
  if (frc !== 0) return finish(frc, `the fetch failed (rc=${frc})`);
  // The one-way switch: from here on no request of this container gets the git credential. No repository or dependency code ran yet
  // (npm ci --ignore-scripts); it runs only after the dispatcher confirmed the switch.
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) {
    try {
      const r = await fetch('http://control.jobrun/phase/run', { method: 'POST', signal: AbortSignal.timeout(15_000) });
      ok = r.status === 200;
    } catch {
      await sleep(1000);
    }
  }
  if (!ok) return finish(1, 'the dispatcher did not confirm the end of the fetch phase: the command does not run');
  st.phase = 'run';
  const rrc = await run('/opt/jobrun/run.sh', env);
  return finish(rrc);
}

function finish(rc, why) {
  if (why) {
    say(why);
    say(`EXIT ${rc}`);
  }
  st.exit = rc;
  st.done = true;
  st.phase = 'done';
}

process.on('SIGTERM', () => {
  if (!st.done) {
    if (st.child) {
      try {
        process.kill(-st.child.pid, 'SIGKILL');
      } catch {}
    }
    say('PLATFORM-STOP the container got SIGTERM (host restart or stop)');
    finish(143);
    say('EXIT 143');
  }
  setTimeout(() => process.exit(0), 2000);
});

createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://c');
  if (u.pathname === '/health') return res.end('ok\n');
  if (u.pathname === '/status') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ phase: st.phase, done: st.done, exit: st.exit, location }));
  }
  if (u.pathname === '/log') {
    const off = Math.max(0, Number(u.searchParams.get('offset') ?? 0) || 0);
    const max = Math.min(4 << 20, Math.max(1, Number(u.searchParams.get('max') ?? 1 << 20) || 1 << 20));
    const fd = openSync(LOG, 'r');
    const size = fstatSync(fd).size;
    const n = Math.max(0, Math.min(max, size - off));
    const buf = Buffer.alloc(n);
    if (n > 0) readSync(fd, buf, 0, n, off);
    closeSync(fd);
    res.setHeader('x-size', String(size));
    return res.end(buf);
  }
  if (u.pathname === '/run' && req.method === 'POST') {
    if (st.started) {
      res.statusCode = 409;
      return res.end('already started\n');
    }
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      let spec;
      try {
        spec = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        return res.end('json\n');
      }
      st.started = true;
      res.end('started\n');
      job(spec).catch((e) => finish(1, `agent error: ${String(e?.message ?? e).slice(0, 200)}`));
    });
    return;
  }
  res.statusCode = 404;
  res.end('no\n');
}).listen(8080, '0.0.0.0');
