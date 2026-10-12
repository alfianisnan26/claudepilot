// Synthetic load for the data placement audit (docs/prd/data-placement.md §5). Builds a FRESH scratch data dir with the
// real migrations (Store.open) and fills it with a documented load model, so table sizes, WAL, backup time and query
// plans can be measured without the owner's database. It refuses a data dir that already holds a database.
//
//   cd apps/server && npx tsx ../../tools/qa/seed-placement.mts <scratchDataDir> [--days 30] [--sessions-per-day 15]
//        [--long 25000] [--generic 5000] [--light]
//   ... --append-long --long N   adds ONE session of N events to a data dir this script seeded (measure before and after)
//
// Load model (the defaults; every number is an input, not a measurement):
// - 3 workspaces, 6 Claudes; `--sessions-per-day` sessions a day over `--days` days.
// - Events per session: 60 % 80, 30 % 400, 9 % 2,000, 1 % 8,000 (mean about 430); plus, when `--long` > 0, ONE extra
//   session of that many events (the QA-017 case), written last so its effect can be measured on its own.
// - A turn = user (200-600 chars), assistant (400-2,000), thinking on 20 % of turns (1,500), 1-4 tool calls (tool_use
//   150 chars; tool_result 65 % 300 chars, 25 % 3,000, 10 % at the 16,000-char cap of chat/store.ts EVENT_TEXT_MAX),
//   result (tokens and cost). `--light` uses tools/qa/seed-perf.mjs's smaller texts instead (tool results of ~40 chars,
//   a 23 kB one every 50th turn) for a lower bound.
// - Per turn: 1 chat_inputs row, 1.2 chat_usage rows; per 4 turns one chat_requests row (30 % with a 1,500-char `full`);
//   per 10 turns one chat_tasks row; per 10 turns one chat_files row; 1-2 chat_segments per session.
// - claude_usage_samples at the retention steady state (6 Claudes x 3 windows, every 10 minutes for 2 days
//   (claudeusage/service.ts intervalS 600; 120 s only while a Usage page is open), hourly to 30 days).
// - Every other table: `--generic` rows of filler sized by column name (ids 36 chars, times ISO, JSON details 200 B,
//   texts 80-500 chars), to get bytes per row. Rates per table come from the code (inventory), not from this filler.
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../../apps/server/src/store/store.js';

const argv = process.argv.slice(2);
const dir = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1]!.startsWith('--') || argv[i - 1] === '--light'));
const num = (name: string, d: number) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
if (!dir) throw new Error('usage: seed-placement.mts <scratchDataDir> [--days N] [--sessions-per-day N] [--long N] [--generic N] [--light]');
const APPEND = argv.includes('--append-long');
if (!APPEND) {
  if (existsSync(join(dir, 'portal.db'))) throw new Error(`${dir} already holds a database: give a fresh scratch dir`);
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length) throw new Error(`${dir} is not empty`);
} else if (!existsSync(join(dir, 'ps-seeded'))) throw new Error(`--append-long only appends to a data dir this script seeded`);

const DAYS = num('--days', 30);
const PER_DAY = num('--sessions-per-day', 15);
const LONG = num('--long', 25000);
const GENERIC = num('--generic', 5000);
const LIGHT = argv.includes('--light');

const t0 = Date.now();
if (!APPEND) {
  const store = await Store.open({ dataDir: dir, secretKey: randomBytes(32) });
  if (store.trust.state !== 'ok') throw new Error(`scratch store not ok: ${JSON.stringify(store.trust)}`);
  store.close();
  writeFileSync(join(dir, 'ps-seeded'), 'seeded by tools/qa/seed-placement.mts\n');
}
const db = new DatabaseSync(join(dir, 'portal.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA synchronous = NORMAL');

// Deterministic pseudo-random numbers, so two runs build the same database.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
// Text comes from this repo's own server sources and PRDs (code and prose, like real tool results and replies), so
// JSON escaping and compression ratios are realistic; a slice at a pseudo-random offset.
const corpus = (() => {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory() && e.name !== 'node_modules') walk(p);
      else if (/\.(ts|md)$/.test(e.name) && !e.name.includes('.generated.')) parts.push(readFileSync(p, 'utf8'));
    }
  };
  const root = fileURLToPath(new URL('../../', import.meta.url));
  walk(join(root, 'apps/server/src'));
  walk(join(root, 'docs/prd'));
  return parts.join('\n');
})();
const text = (n: number) => {
  const at = Math.floor(rnd() * (corpus.length - n - 1));
  return corpus.slice(at, at + n);
};
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const WORKSPACES = ['docker/ps-a', 'docker/ps-b', 'docker/ps-c'];
const CLAUDES = Array.from({ length: 6 }, (_, i) => `cl-${i}`);

const insSession = db.prepare(`INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, process, segment, last_seq, model, mode, cost_est_usd, turns, launch, created_at, last_activity_at, claude_id)
  VALUES (?, ?, '/home/node/project', ?, 'ui', 'ended', ?, 'gone', 1, ?, 'claude-opus-5-5', 'default', ?, ?, '{}', ?, ?, ?)`);
const insEvent = db.prepare('INSERT INTO chat_events (session_id, seq, at, kind, uuid, parent_tool_use_id, request_id, payload) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)');
const insInput = db.prepare(`INSERT INTO chat_inputs (session_id, uuid, actor, kind, priority, state, created_at) VALUES (?, ?, 'u_owner', 'message', NULL, 'completed', ?)`);
const insUsage = db.prepare(`INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`);
const insReq = db.prepare(`INSERT INTO chat_requests (session_id, request_id, tool_use_id, kind, tool_name, title, detail, created_at, answered_at, outcome, actor, full, full_cut)
  VALUES (?, ?, ?, 'tool', 'Bash', ?, ?, ?, ?, 'allow', 'u_owner', ?, 0)`);
const insTask = db.prepare(`INSERT INTO chat_tasks (session_id, task_id, tool_use_id, type, label, status, tokens, tool_uses, started_at, ended_at) VALUES (?, ?, ?, 'agent', ?, 'completed', 12000, 9, ?, ?)`);
const insFile = db.prepare(`INSERT INTO chat_files (session_id, kind, blob_sha256, name, workspace_path, size, media_type, at) VALUES (?, 'image', ?, 'screenshot.png', NULL, 180000, 'image/png', ?)`);
const insSeg = db.prepare(`INSERT INTO chat_segments (session_id, n, claude_id, claude_session_id, cwd, started_at, ended_at) VALUES (?, ?, ?, ?, '/home/node/project', ?, ?)`);

/** One session of `events` events starting at `start`; returns the number written. */
function session(events: number, start: number) {
  const id = `ps-${randomUUID()}`;
  const ws = pick(WORKSPACES);
  const claude = pick(CLAUDES);
  let seq = 0;
  let t = start;
  let turns = 0;
  let cost = 0;
  const add = (kind: string, payload: object) => insEvent.run(id, ++seq, iso((t += 1500)), kind, kind === 'user' || kind === 'assistant' ? randomUUID() : null, JSON.stringify(payload));
  while (seq < events) {
    turns++;
    add('user', { text: text(LIGHT ? 100 + (turns % 4) * 45 : 200 + Math.floor(rnd() * 400)), actor: 'u_owner' });
    insInput.run(id, randomUUID(), iso(t));
    add('assistant', { text: text(LIGHT ? 520 : 400 + Math.floor(rnd() * 1600)) });
    if (rnd() < 0.2) add('thinking', { text: text(LIGHT ? 400 : 1500), durationMs: 1200 });
    const tools = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < tools; i++) {
      const tu = `toolu_${randomBytes(12).toString('hex')}`;
      add('tool_use', { text: text(150), toolName: 'Bash', toolUseId: tu });
      const r = rnd();
      const size = LIGHT ? (turns % 50 === 0 ? 23000 : 40) : r < 0.65 ? 300 : r < 0.9 ? 3000 : 16000;
      add('tool_result', { text: text(Math.min(size, 16000)), toolName: 'Bash', toolUseId: tu });
    }
    const turnCost = 0.002 + (turns % 7) * 0.001;
    cost += turnCost;
    add('result', { text: 'done', costUsd: cost, turnCostUsd: turnCost, durationMs: 4000, tokens: { input: 1000, output: 300, cacheRead: 5000, cacheWrite: 100 } });
    insUsage.run(iso(t), t, id, ws, claude, 'claude-opus-5-5', 1000, 300, 5000, 100, turnCost, 4000);
    if (rnd() < 0.2) insUsage.run(iso(t), t, id, ws, claude, 'claude-haiku-4-5', 400, 80, 900, 0, 0.0004, 0);
    if (turns % 4 === 0) insReq.run(id, randomUUID(), `toolu_${turns}`, `Run: ${text(60)}`, text(200), iso(t), iso(t + 4000), rnd() < 0.3 ? text(1500) : null);
    if (turns % 10 === 0) insTask.run(id, `task-${turns}`, `toolu_t${turns}`, text(40), iso(t), iso(t + 60000));
    if (turns % 10 === 5) insFile.run(id, randomBytes(32).toString('hex'), iso(t));
  }
  insSession.run(id, ws, text(40), iso(t), seq, cost, turns, iso(start), iso(t), claude);
  insSeg.run(id, 1, claude, randomUUID(), iso(start), iso(t));
  return seq;
}

// 1. Transcripts.
if (!APPEND) {
db.exec('BEGIN');
let total = 0;
const nSessions = DAYS * PER_DAY;
for (let i = 0; i < nSessions; i++) {
  const r = rnd();
  const n = r < 0.6 ? 80 : r < 0.9 ? 400 : r < 0.99 ? 2000 : 8000;
  total += session(n, now - DAYS * 86_400_000 + i * ((DAYS * 86_400_000) / nSessions));
  if (i % 50 === 49) {
    db.exec('COMMIT');
    db.exec('BEGIN');
  }
}
db.exec('COMMIT');
console.log(`transcripts: ${nSessions} sessions, ${total} events (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

// 2. Plan-limit samples at the retention steady state.
const insSample = db.prepare(`INSERT INTO claude_usage_samples (at_ms, claude_id, workspace_id, win, used_pct, resets_at_ms, level, source) VALUES (?, ?, ?, ?, ?, ?, 'ok', 'probe')`);
db.exec('BEGIN');
let samples = 0;
for (const c of CLAUDES)
  for (const win of ['five_hour', 'seven_day', 'seven_day_opus']) {
    for (let ms = now - 2 * 86_400_000; ms < now; ms += 600_000, samples++) insSample.run(ms, c, 'docker/ps-a', win, rnd() * 100, ms + 3_600_000);
    for (let ms = now - 30 * 86_400_000; ms < now - 2 * 86_400_000; ms += 3_600_000, samples++) insSample.run(ms, c, 'docker/ps-a', win, rnd() * 100, ms + 3_600_000);
  }
db.exec('COMMIT');
console.log(`claude_usage_samples: ${samples}`);

// 3. Every other table: filler rows to learn bytes per row.
const SEEDED = new Set(['chat_sessions', 'chat_events', 'chat_inputs', 'chat_usage', 'chat_requests', 'chat_tasks', 'chat_files', 'chat_segments', 'claude_usage_samples', 'portal_meta']);
const tables = (db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[]).filter((t) => !SEEDED.has(t.name));
const filler = (col: string, type: string, i: number, sql: string): unknown => {
  const allowed = new RegExp(`\\b${col}\\b[^,]*CHECK\\s*\\(\\s*${col}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(sql);
  if (allowed) return pick(allowed[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')));
  if (/INT/i.test(type)) return /_ms$|^at_ms$/.test(col) ? now - i * 60_000 : i % 1000;
  if (/REAL/i.test(type)) return rnd() * 10;
  if (col === 'id' || /_id$|^uuid$|_uuid$/.test(col)) return `${col === 'id' ? '' : 'x'}${randomUUID()}-${i}`;
  if (/(^|_)at$|_since$|^created$|_until$/.test(col)) return iso(now - i * 60_000);
  if (/sha|hash|digest|fingerprint/.test(col)) return randomBytes(32).toString('hex');
  if (/detail|payload|facts|meta|config|data|json|options|launch|scan|windows|summary|params|spec|result|body|evidence|context/.test(col)) return JSON.stringify({ k: text(80), n: i, list: [text(30), text(30)] });
  if (/content|text|note|message|markdown|log|output|description/.test(col)) return text(500);
  if (/reason|error|problem|title|label|name|path|url|ref|branch|actor|kind|state|status|source/.test(col)) return text(40);
  return text(16);
};
let generic = 0;
for (const t of tables) {
  const cols = (db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string; type: string; pk: number }[]).filter(
    (c) => !(c.pk === 1 && /INTEGER/i.test(c.type) && /AUTOINCREMENT|INTEGER PRIMARY KEY/i.test(t.sql)),
  );
  const ins = db.prepare(`INSERT OR IGNORE INTO "${t.name}" (${cols.map((c) => `"${c.name}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  db.exec('BEGIN');
  let ok = 0;
  for (let i = 0; i < GENERIC; i++) {
    try {
      ins.run(...(cols.map((c) => filler(c.name, c.type, i, t.sql)) as never[]));
      ok++;
    } catch {
      // a CHECK or trigger the filler doesn't satisfy: this table gets fewer rows (reported by db-measure)
    }
  }
  db.exec('COMMIT');
  generic += ok;
}
console.log(`generic: ${tables.length} tables, ${generic} rows`);
}

// 4. The long session last, so its cost can be told apart (db-measure before and after).
if (LONG > 0) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('BEGIN');
  const n = session(LONG, now - 3 * 86_400_000);
  db.exec('COMMIT');
  console.log(`long session: ${n} events`);
}
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
