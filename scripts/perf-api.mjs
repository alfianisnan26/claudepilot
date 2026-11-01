#!/usr/bin/env node
// Latency of the hot API routes (what Home, Needs you and the lists ask for) on the large seeded database of scripts/perf-boot.mjs.
//
//   node scripts/perf-boot.mjs --dir D --runs 1          # once: builds and seeds the database in D
//   node scripts/perf-api.mjs --dir D [--n 40] [--entry dist|<bundle.js>[,<bundle.js>]] [--json]
//
// Starts the portal on D (clean environment, as perf-boot does), signs in with the server code, asks every route --n times after two
// warm-up calls, and prints p50 and p95 per route; with several entries they take turns route by route, so a busy machine slows each
// alike. Owner request 2026-11-01 (performance): the org scoping must filter in SQL, not one can() per row.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'apps/server');
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : dflt);
const dir = resolve(opt('dir', join(tmpdir(), 'perf-boot')));
const n = Number(opt('n', '40'));
const port = Number(opt('port', '3478'));
const json = args.includes('--json');
const base = `http://127.0.0.1:${port}`;

const ROUTES = (
  opt('routes', '') ||
  [
    '/api/session',
    '/api/me',
    '/api/orgs',
    '/api/attention?limit=200&org=personal',
    '/api/chat/sessions?limit=50&org=personal',
    '/api/glance?org=personal',
    '/api/workspaces?org=personal',
    '/api/tickets?sort=newest&limit=3&org=personal',
    '/api/tickets?limit=100&org=personal',
    '/api/tickets/buckets?org=personal',
    '/api/ci/runs?limit=5&org=personal',
    '/api/ci/runs?limit=100&org=personal',
    '/api/claude-usage?org=personal',
    '/api/usage-spend?org=personal',
    '/api/notify/history?limit=10',
    '/api/keepgoing?org=personal',
    '/api/lab/metrics/overview?program=all&window=24h',
    '/api/lab/scorecard?window=day&compare=1',
    '/api/autotransfer/events?kind=moved&limit=20',
  ].join(',')
).split(',');

async function start(entry) {
  const env = {
    PATH: process.env.PATH,
    HOME: join(dir, 'home'),
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
    NODE_OPTIONS: `--disable-warning=ExperimentalWarning ${opt('node-options', '')}`.trim(),
    PORTAL_PORT: String(port),
    PORTAL_HOST: '127.0.0.1',
    PORTAL_DATA_DIR: join(dir, 'data'),
    PORTAL_SERVER_CODE: '24681372',
    PORTAL_SECRET_KEY: readFileSync(join(dir, 'key'), 'utf8').trim(),
    PORTAL_K8S_ENABLED: 'false',
    PORTAL_CONNECT_ENABLED: 'false',
    PORTAL_DOCKER_SOCKET: join(dir, 'no-docker.sock'),
  };
  const child = spawn('node', [entry === 'dist' ? 'dist/index.js' : resolve(entry)], { cwd: server, env, stdio: 'ignore' });
  for (let i = 0; i < 600; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ code: '24681372' }),
  });
  const cookie = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
  if (!cookie) throw new Error(`sign-in failed: ${r.status}`);
  // Let the start-up passes (the integrity check, first scans) finish before timing.
  await new Promise((r2) => setTimeout(r2, 3000));
  return { child, cookie };
}

const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];
async function time(cookie, path) {
  const t = performance.now();
  const r = await fetch(`${base}${path}`, { headers: { Cookie: `portal_session=${cookie}`, Origin: base } });
  const body = await r.arrayBuffer();
  return { ms: performance.now() - t, status: r.status, bytes: body.byteLength };
}

const entries = opt('entry', 'dist').split(',');
const results = {};
for (const entry of entries) {
  const { child, cookie } = await start(entry);
  try {
    for (const path of ROUTES) {
      await time(cookie, path);
      await time(cookie, path);
      const ms = [];
      let last;
      for (let i = 0; i < n; i++) {
        last = await time(cookie, path);
        ms.push(last.ms);
      }
      (results[path] ??= {})[entry] = {
        p50: Math.round(pct(ms, 50) * 10) / 10,
        p95: Math.round(pct(ms, 95) * 10) / 10,
        status: last.status,
        kb: Math.round(last.bytes / 102.4) / 10,
      };
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
}
if (json) console.log(JSON.stringify(results));
else
  for (const [path, byEntry] of Object.entries(results))
    console.log(
      `${path.padEnd(52)} ${Object.entries(byEntry)
        .map(([e, r]) => `${e.split('/').slice(-2).join('/')}: p50 ${r.p50} p95 ${r.p95} ms (${r.status}, ${r.kb} KB)`)
        .join('  |  ')}`,
    );
