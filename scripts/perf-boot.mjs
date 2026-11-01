#!/usr/bin/env node
// Boot-to-listen on a large seeded database: how long a restarted portal (a release) is down before it answers /healthz.
//
//   node scripts/perf-boot.mjs [--dir D] [--rows 300000] [--runs 5] [--pending] [--entry dist|tsx] [--budget-ms 10000] [--json]
//
// The first run builds the database in D (default: <os tmp>/perf-boot): one clean boot applies every migration, then it is seeded
// with chat events, audits, usage samples, CI logs and tickets (about 1.5 KB per --rows row; 300000 is about 0.6 GB). Later runs
// reuse it while the row count matches. Each run starts the portal from a clean environment (Kubernetes, Docker and Connect off,
// NODE_ENV=production, no credentials of the caller), times the first 200 from /healthz, prints the timeline of its log lines, and
// stops it. --pending makes every run a release with one light migration still to apply (migration 910 is marked unapplied and its
// table dropped), so the pre-migrate safety copy is measured too. --entry dist (default) runs the esbuild bundle a release runs
// (apps/server/dist, built when missing); tsx runs the sources; a path to a .js bundle runs that one (another commit's build, to
// compare before and after on the same database and machine). After the first 200 it keeps asking /healthz for --settle-ms (default
// 5000) and reports the slowest answer: work moved after listen must not stall the event loop. Exit 1 when the median is over --budget-ms.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'apps/server');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);
const dir = resolve(opt('dir', join(tmpdir(), 'perf-boot')));
const rows = Number(opt('rows', '300000'));
const runs = Number(opt('runs', '5'));
const budget = Number(opt('budget-ms', '10000'));
const entry = opt('entry', 'dist');
const port = Number(opt('port', '3479'));
const json = flag('json');
const pending = flag('pending');
const data = join(dir, 'data');
const log = (...a) => !json && console.log(...a);

mkdirSync(join(dir, 'home'), { recursive: true });
const keyFile = join(dir, 'key');
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
const key = readFileSync(keyFile, 'utf8').trim();

if (entry.split(',').includes('dist') && (flag('build') || !existsSync(join(server, 'dist/index.js')))) {
  log('building apps/server/dist ...');
  const b = spawnSync('npm', ['run', 'build'], { cwd: server, stdio: json ? 'ignore' : 'inherit' });
  if (b.status !== 0) process.exit(2);
}

/** Starts the portal and resolves with the time to the first 200 from /healthz and the time each log line arrived. */
async function boot(which = entry.split(',')[0]) {
  const env = {
    PATH: process.env.PATH,
    HOME: join(dir, 'home'),
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
    NODE_OPTIONS: `--disable-warning=ExperimentalWarning ${opt('node-options', '')}`.trim(),
    PORTAL_PORT: String(port),
    PORTAL_HOST: '127.0.0.1',
    PORTAL_DATA_DIR: data,
    PORTAL_SERVER_CODE: '24681372',
    PORTAL_SECRET_KEY: key,
    PORTAL_K8S_ENABLED: 'false',
    PORTAL_CONNECT_ENABLED: 'false',
    PORTAL_DOCKER_SOCKET: join(dir, 'no-docker.sock'),
    PORTAL_BOOT_TIMING: '1',
  };
  const cmd =
    which === 'dist' ? ['node', ['dist/index.js']] : which === 'tsx' ? ['npx', ['tsx', 'src/index.ts']] : ['node', [resolve(which)]];
  const t0 = performance.now();
  const child = spawn(cmd[0], cmd[1], { cwd: server, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  const onData = (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) lines.push([Math.round(performance.now() - t0), line]);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  let exited = false;
  child.on('exit', () => (exited = true));
  let ms = null;
  while (!exited && performance.now() - t0 < 300_000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        ms = Math.round(performance.now() - t0);
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  // The work moved after listen: the slowest /healthz answer while it runs, and its log lines in the timeline. Then stop.
  let slowest = 0;
  const settleEnd = performance.now() + Number(opt('settle-ms', '5000'));
  while (ms !== null && !exited && performance.now() < settleEnd) {
    const t = performance.now();
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
    } catch {
      // counted as slow below
    }
    slowest = Math.max(slowest, Math.round(performance.now() - t));
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill('SIGTERM');
  await new Promise((r) => (exited ? r() : child.on('exit', r)));
  if (ms === null) {
    console.error(lines.map(([t, l]) => `${t} ${l}`).join('\n'));
    throw new Error('the portal did not answer /healthz');
  }
  return { ms, lines, slowest };
}

// Seed: synthetic rows in the tables that grow, shaped like a portal that has run for months.
const SIZES = (n) => ({
  sessions: Math.max(50, Math.round(n / 150)),
  events: n,
  chatAudit: Math.round(n / 3),
  platformAudit: Math.round(n / 3),
  pmcpAudit: Math.round(n / 4),
  usageSamples: Math.round(n / 2),
  chatUsage: Math.round(n / 4),
  tickets: Math.max(50, Math.round(n / 60)),
  ticketEvents: Math.round(n / 6),
  ciRuns: Math.max(20, Math.round(n / 100)),
  ciLogs: Math.round(n / 25),
});

function seed(n) {
  const db = new DatabaseSync(join(data, 'portal.db'));
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF');
  const s = SIZES(n);
  const pad = (k) => randomBytes(k).toString('base64');
  const iso = (i, total) => new Date(Date.now() - (total - i) * 60_000).toISOString();
  const tx = (label, count, stmt, row) => {
    const t = performance.now();
    const st = db.prepare(stmt);
    for (let i = 0; i < count; i += 5000) {
      db.exec('BEGIN');
      for (let j = i; j < Math.min(count, i + 5000); j++) st.run(...row(j));
      db.exec('COMMIT');
    }
    log(`  seeded ${label}: ${count} rows in ${Math.round(performance.now() - t)} ms`);
  };
  const ws = (i) => `docker/ws${i % 30}`;
  tx(
    'chat_sessions',
    s.sessions,
    `INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, process, created_at, last_activity_at, archived_at, ended_reason)
     VALUES (?, ?, ?, 'ended', ?, 'gone', ?, ?, ?, 'seed')`,
    (i) => [`s${i}`, ws(i), `Session ${i}`, iso(i, s.sessions), iso(i, s.sessions), iso(i, s.sessions), i % 3 ? iso(i, s.sessions) : null],
  );
  tx('chat_events', s.events, `INSERT INTO chat_events (session_id, seq, at, kind, uuid, payload) VALUES (?, ?, ?, ?, ?, ?)`, (i) => [
    `s${i % s.sessions}`,
    Math.floor(i / s.sessions) + 1,
    iso(i, s.events),
    i % 4 ? 'assistant' : 'tool_result',
    `u${i}`,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: pad(600) }] } }),
  ]);
  tx(
    'chat_audit',
    s.chatAudit,
    `INSERT INTO chat_audit (at, severity, kind, session_id, workspace_id, actor, detail) VALUES (?, 'info', 'turn', ?, ?, 'ui', ?)`,
    (i) => [iso(i, s.chatAudit), `s${i % s.sessions}`, ws(i), JSON.stringify({ note: pad(150) })],
  );
  tx(
    'platform_audit',
    s.platformAudit,
    `INSERT INTO platform_audit (at, kind, actor, user_id, subject, detail) VALUES (?, ?, 'ui', 'u_owner', ?, ?)`,
    (i) => [iso(i, s.platformAudit), `kind.${i % 20}`, `subj${i % 500}`, JSON.stringify({ note: pad(150) })],
  );
  tx(
    'pmcp_audit',
    s.pmcpAudit,
    `INSERT INTO pmcp_audit (at, request_id, token_id, method, tool, args, outcome) VALUES (?, ?, ?, 'tools/call', ?, ?, 'ok')`,
    (i) => [iso(i, s.pmcpAudit), `r${i}`, `t${i % 10}`, `tool_${i % 40}`, JSON.stringify({ q: pad(100) })],
  );
  tx(
    'claude_usage_samples',
    s.usageSamples,
    `INSERT INTO claude_usage_samples (at_ms, claude_id, workspace_id, win, used_pct, resets_at_ms, level, source) VALUES (?, ?, ?, 'five_hour', ?, ?, 'ok', 'probe')`,
    (i) => [Date.now() - (s.usageSamples - i) * 30_000, `c${i % 8}`, ws(i), i % 100, Date.now() + 3_600_000],
  );
  tx(
    'chat_usage',
    s.chatUsage,
    `INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cost_usd, requests) VALUES (?, ?, ?, ?, ?, 'claude-opus', 1000, 500, 0.01, 1)`,
    (i) => [iso(i, s.chatUsage), Date.now() - (s.chatUsage - i) * 60_000, `s${i % s.sessions}`, ws(i), `c${i % 8}`],
  );
  tx(
    'tickets',
    s.tickets,
    `INSERT INTO tickets (type, priority, priority_rank, status, summary, description, source, reporter_kind, reporter_label, workspace_id, created_at, updated_at, bucket_key, bucket_number)
     VALUES ('task', 'normal', 2, ?, ?, ?, 'human', 'ui', 'owner', ?, ?, ?, 'PILOT', ?)`,
    (i) => [i % 5 ? 'done' : 'open', `Ticket ${i}`, pad(400), ws(i), iso(i, s.tickets), iso(i, s.tickets), i + 1],
  );
  tx(
    'ticket_events',
    s.ticketEvents,
    `INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, body) VALUES (?, ?, 'comment', 'ui', 'owner', ?)`,
    (i) => [(i % s.tickets) + 1, iso(i, s.ticketEvents), pad(300)],
  );
  tx(
    'ci_runs',
    s.ciRuns,
    `INSERT INTO ci_runs (id, number, workspace_id, repo_id, repo, pipeline, trigger, ref, sha, status, actor, created_at) VALUES (?, ?, ?, 'r1', 'repo', 'gate', 'push', 'main', ?, 'passed', 'ui', ?)`,
    (i) => [`run${i}`, i + 1, ws(i), randomBytes(20).toString('hex'), iso(i, s.ciRuns)],
  );
  tx('ci_logs', s.ciLogs, `INSERT INTO ci_logs (run_id, job, step, bytes, text) VALUES (?, 'gate', ?, 6000, ?)`, (i) => [
    `run${i % s.ciRuns}`,
    Math.floor(i / s.ciRuns),
    pad(4500),
  ]);
  db.prepare("INSERT INTO portal_meta (key, value) VALUES ('perf_seed_rows', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    String(n),
  );
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

/**
 * A release with one light migration to apply: migration 910 (a new table, user_layouts) is taken out of the applied set and its table
 * dropped, so the next start runs it again (migrations run by set, not only by number) after the pre-migrate copy.
 */
function markLatestPending() {
  const db = new DatabaseSync(join(data, 'portal.db'));
  const applied = JSON.parse(db.prepare("SELECT value FROM portal_meta WHERE key = 'migrations_applied'").get().value);
  const created = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_layouts'").get();
  if (!applied.includes(910) || !created)
    throw new Error('--pending re-runs migration 910 (user_layouts), which this database does not have: update markLatestPending');
  db.exec('DROP TABLE user_layouts');
  db.prepare("UPDATE portal_meta SET value = ? WHERE key = 'migrations_applied'").run(JSON.stringify(applied.filter((v) => v !== 910)));
  db.close();
}

const seeded = () => {
  if (!existsSync(join(data, 'portal.db'))) return null;
  const db = new DatabaseSync(join(data, 'portal.db'), { readOnly: true });
  try {
    return Number(db.prepare("SELECT value FROM portal_meta WHERE key = 'perf_seed_rows'").get()?.value ?? 0);
  } catch {
    return null;
  } finally {
    db.close();
  }
};

if (seeded() !== rows) {
  log(`building a seeded database in ${data} (${rows} rows) ...`);
  rmSync(data, { recursive: true, force: true });
  await boot(); // applies every migration on an empty database
  seed(rows);
}
const dbBytes = statSync(join(data, 'portal.db')).size;
log(`database: ${(dbBytes / 1e6).toFixed(0)} MB, entry ${entry}${pending ? ', one migration pending each run' : ''}`);

// Several entries (comma separated) take turns run by run, so a busy machine slows each of them alike.
const entries = entry.split(',');
const results = new Map(entries.map((e) => [e, []]));
for (let i = 0; i < runs; i++)
  for (const e of entries) {
    if (pending) markLatestPending();
    const r = await boot(e);
    results.get(e).push(r);
    log(`run ${i + 1} ${e}: listening after ${r.ms} ms, slowest /healthz after listen ${r.slowest} ms`);
  }
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
let over = false;
const summary = [];
for (const [e, rs] of results) {
  const median = med(rs.map((r) => r.ms));
  over ||= median > budget;
  summary.push({ entry: e, runs: rs.map((r) => r.ms), median, slowestAfterListen: med(rs.map((r) => r.slowest)) });
  if (!json) {
    console.log(`\n${e}: timeline of the median run (ms since spawn):`);
    for (const [t, line] of rs.find((r) => r.ms === median).lines.slice(0, 60))
      console.log(`  ${String(t).padStart(6)}  ${line.slice(0, 140)}`);
  }
}
if (json) console.log(JSON.stringify({ dbBytes, pending, budget, summary }));
else
  for (const s of summary)
    console.log(
      `boot to listen (${s.entry}): median ${s.median} ms (runs ${s.runs.join(', ')}), slowest /healthz after listen (median) ${s.slowestAfterListen} ms, budget ${budget} ms, database ${(dbBytes / 1e6).toFixed(0)} MB`,
    );
process.exit(over ? 1 : 0);
