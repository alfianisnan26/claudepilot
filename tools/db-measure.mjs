#!/usr/bin/env node
// Read-only size report for a portal database (data placement PRD, docs/prd/data-placement.md §5).
//
//   node tools/db-measure.mjs <dataDir | portal.db> [--json] [--save snap.json] [--diff old.json] [--plans] [--no-columns]
//
// What it prints: table and index names, row counts, bytes per table from SQLite's dbstat (pages, payload, unused),
// the WAL and file sizes, the time span and rows per day of tables that carry a time column, rows per session for
// session tables, the column that holds most of each table's bytes, the sizes of the data dir's own folders
// (backups by kind, chat-blobs), and with --plans the query plans of the hot reads. It NEVER prints row content:
// only names the portal chose (tables, columns, folders), counts, sizes and aggregate times.
//
// Safety: the database is opened read-only (no writes, no checkpoint, no VACUUM); the only file written is the
// --save snapshot. Safe while the portal runs (a WAL reader does not block the writer). Counting a very large
// table takes a few seconds; --no-columns skips the per-column byte scan, which reads every row.
// --save writes a snapshot; a later run with --diff <snapshot> prints growth per table between the two (per day when
// they are at least half a day apart).
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a, i) => !a.startsWith('--') && !['--save', '--diff'].includes(args[i - 1]));
if (!target) {
  console.error('usage: node tools/db-measure.mjs <dataDir | portal.db> [--json] [--save snap.json] [--diff old.json] [--plans] [--no-columns]');
  process.exit(2);
}
const dbPath = existsSync(target) && statSync(target).isDirectory() ? join(target, 'portal.db') : target;
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`);
  process.exit(2);
}
const dataDir = dirname(dbPath);
const size = (f) => (existsSync(f) ? statSync(f).size : 0);

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (e) {
  console.error(`could not open ${dbPath} read-only: ${e.message}. Run it as the user that owns the data dir, or on a copy.`);
  process.exit(1);
}
const one = (sql) => Object.values(db.prepare(sql).get() ?? {})[0];
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Schema: tables and the table each index belongs to.
const schema = db.prepare("SELECT type, name, tbl_name FROM sqlite_schema WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").all();
const tables = schema.filter((s) => s.type === 'table').map((s) => s.name);
const indexOf = new Map(schema.filter((s) => s.type === 'index').map((s) => [s.name, s.tbl_name]));

// Bytes per b-tree from dbstat (aggregate per name).
const stat = new Map();
for (const r of db.prepare('SELECT name, SUM(pgsize) AS pg, SUM(payload) AS payload, SUM(unused) AS unused, COUNT(*) AS pages FROM dbstat GROUP BY name').all())
  stat.set(r.name, r);

const TIME_COLS = ['at_ms', 'at', 'created_at', 'ts', 'started_at', 'checked_at_ms', 'trusted_at', 'issued_at', 'updated_at'];
const toMs = (v) => (typeof v === 'number' ? (v > 1e11 ? v : v * 1000) : Date.parse(String(v)));
const DAY = 86_400_000;

const rows = [];
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${q(t)})`).all();
  const names = cols.map((c) => c.name);
  const count = Number(one(`SELECT COUNT(*) FROM ${q(t)}`));
  const own = stat.get(t) ?? { pg: 0, payload: 0, unused: 0, pages: 0 };
  let idxBytes = 0;
  for (const [idx, tbl] of indexOf) if (tbl === t) idxBytes += stat.get(idx)?.pg ?? 0;
  // sqlite_autoindex_* are not in sqlite_schema with a name we filter in; add them by prefix.
  for (const [name, s] of stat) if (name.startsWith(`sqlite_autoindex_${t}_`)) idxBytes += s.pg;
  const row = { table: t, rows: count, tableBytes: Number(own.pg), payloadBytes: Number(own.payload), indexBytes: idxBytes };
  row.totalBytes = row.tableBytes + row.indexBytes;
  row.avgRowBytes = count ? Math.round(row.payloadBytes / count) : 0;
  const tc = TIME_COLS.find((c) => names.includes(c));
  if (tc && count) {
    const r = db.prepare(`SELECT MIN(${q(tc)}) AS lo, MAX(${q(tc)}) AS hi FROM ${q(t)}`).get();
    const lo = toMs(r.lo);
    const hi = toMs(r.hi);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      row.timeColumn = tc;
      row.spanDays = +((hi - lo) / DAY).toFixed(2);
      row.rowsPerDay = row.spanDays >= 1 ? Math.round(count / row.spanDays) : null;
      row.bytesPerDay = row.spanDays >= 1 ? Math.round(row.totalBytes / row.spanDays) : null;
    }
  }
  if (names.includes('session_id') && count) {
    const r = db.prepare(`SELECT COUNT(*) AS sessions, MAX(n) AS maxPer, AVG(n) AS avgPer FROM (SELECT COUNT(*) AS n FROM ${q(t)} GROUP BY session_id)`).get();
    row.sessions = Number(r.sessions);
    row.maxRowsPerSession = Number(r.maxPer);
    row.avgRowsPerSession = Math.round(Number(r.avgPer));
  }
  if (!flag('--no-columns') && count) {
    let best = null;
    for (const c of cols) {
      if (!/TEXT|BLOB|^$/i.test(c.type)) continue;
      const b = Number(one(`SELECT COALESCE(SUM(LENGTH(${q(c.name)})), 0) FROM ${q(t)}`));
      if (!best || b > best.bytes) best = { column: c.name, bytes: b };
    }
    if (best && best.bytes) row.biggestColumn = best;
  }
  rows.push(row);
}
rows.sort((a, b) => b.totalBytes - a.totalBytes);

// Data dir folders (names the portal chose; blob file names are never listed).
const dirBytes = (dir) => {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files++;
        bytes += statSync(p).size;
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return { files, bytes };
};
const folders = {};
for (const e of readdirSync(dataDir, { withFileTypes: true })) if (e.isDirectory()) folders[e.name] = dirBytes(join(dataDir, e.name));
const backups = {};
const bdir = join(dataDir, 'backups');
if (existsSync(bdir))
  for (const f of readdirSync(bdir)) {
    const kind = /-(pre-migrate|daily|manual|replaced)\.db$/.exec(f)?.[1] ?? 'other';
    backups[kind] ??= { files: 0, bytes: 0 };
    backups[kind].files++;
    backups[kind].bytes += size(join(bdir, f));
  }

// Hot reads (data-placement PRD §5.3): only the plan is printed, never a row. Placeholders are bound to ''.
const HOT = [
  ['session transcript (chat/store.ts history: no LIMIT)', 'SELECT seq, at, kind, uuid, parent_tool_use_id, request_id, payload FROM chat_events WHERE session_id = ? AND seq > ? ORDER BY seq'],
  ['newest result of a session', "SELECT payload FROM chat_events WHERE session_id = ? AND kind = 'result' AND seq > ? ORDER BY seq DESC LIMIT 1"],
  ['tool name by tool use id', "SELECT json_extract(payload, '$.toolName') FROM chat_events WHERE session_id = ? AND kind = 'tool_use' AND json_extract(payload, '$.toolUseId') = ? ORDER BY seq DESC LIMIT 1"],
  ['session list (unpaged)', 'SELECT * FROM chat_sessions ORDER BY last_activity_at DESC, created_at DESC'],
  ['usage range', 'SELECT * FROM chat_usage WHERE at_ms >= ? ORDER BY at_ms'],
  ['usage of one session (usagespend)', 'SELECT COALESCE(SUM(requests), 0), COALESCE(SUM(cost_usd), 0) FROM chat_usage WHERE session_id = ? AND at_ms > ? AND at_ms <= ?'],
  ['plan-limit samples of a Claude', 'SELECT * FROM claude_usage_samples WHERE claude_id = ? AND win = ? AND at_ms >= ? ORDER BY at_ms'],
  ['ticket events', 'SELECT * FROM ticket_events WHERE ticket_number = ? ORDER BY id DESC LIMIT 100'],
  ['Portal MCP audit page', 'SELECT * FROM pmcp_audit ORDER BY id DESC LIMIT 50 OFFSET 0'],
  ['notify history of a user', 'SELECT * FROM notify_history WHERE owner_id = ? ORDER BY at DESC LIMIT 50'],
];
const plans = [];
if (flag('--plans'))
  for (const [label, sql] of HOT) {
    try {
      const n = (sql.match(/\?/g) ?? []).length;
      const detail = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill('')).map((r) => r.detail);
      plans.push({ label, sql, plan: detail });
    } catch (e) {
      plans.push({ label, sql, plan: [`n/a: ${e.message}`] });
    }
  }

const report = {
  measuredAt: new Date().toISOString(),
  database: basename(dbPath),
  schemaVersion: Number(one('PRAGMA user_version')),
  journalMode: String(one('PRAGMA journal_mode')),
  pageSize: Number(one('PRAGMA page_size')),
  pageCount: Number(one('PRAGMA page_count')),
  freelistPages: Number(one('PRAGMA freelist_count')),
  fileBytes: size(dbPath),
  walBytes: size(`${dbPath}-wal`),
  shmBytes: size(`${dbPath}-shm`),
  tables: rows,
  folders,
  backups,
  plans,
};
db.close();

let diff = null;
const old = opt('--diff');
if (old) {
  const prev = JSON.parse(readFileSync(old, 'utf8'));
  const days = (Date.parse(report.measuredAt) - Date.parse(prev.measuredAt)) / DAY;
  const before = new Map(prev.tables.map((t) => [t.table, t]));
  diff = {
    days: +days.toFixed(3),
    fileBytesPerDay: days >= 0.5 ? Math.round((report.fileBytes - prev.fileBytes) / days) : null,
    tables: report.tables
      .map((t) => {
        const p = before.get(t.table) ?? { rows: 0, totalBytes: 0 };
        return { table: t.table, rowsAdded: t.rows - p.rows, bytesAdded: t.totalBytes - p.totalBytes, rowsPerDay: days >= 0.5 ? Math.round((t.rows - p.rows) / days) : null, bytesPerDay: days >= 0.5 ? Math.round((t.totalBytes - p.totalBytes) / days) : null };
      })
      .filter((t) => t.rowsAdded || t.bytesAdded)
      .sort((a, b) => b.bytesAdded - a.bytesAdded),
  };
}
const save = opt('--save');
if (save) writeFileSync(save, JSON.stringify(report, null, 1));

if (flag('--json')) {
  console.log(JSON.stringify(diff ? { ...report, diff } : report, null, 1));
  process.exit(0);
}
const mb = (b) => (b == null ? '-' : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} kB` : `${b} B`);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log(`${report.database}  schema ${report.schemaVersion}  ${report.journalMode}  page ${report.pageSize} B x ${report.pageCount} (${report.freelistPages} free)`);
console.log(`file ${mb(report.fileBytes)}  wal ${mb(report.walBytes)}  shm ${mb(report.shmBytes)}  measured ${report.measuredAt}\n`);
console.log(`${pad('table', 30)}${lpad('rows', 10)}${lpad('table', 11)}${lpad('index', 11)}${lpad('avg row', 9)}${lpad('span d', 8)}${lpad('rows/d', 9)}${lpad('max/sess', 10)}  biggest column`);
for (const t of report.tables)
  console.log(
    `${pad(t.table, 30)}${lpad(t.rows, 10)}${lpad(mb(t.tableBytes), 11)}${lpad(mb(t.indexBytes), 11)}${lpad(t.avgRowBytes, 9)}${lpad(t.spanDays ?? '-', 8)}${lpad(t.rowsPerDay ?? '-', 9)}${lpad(t.maxRowsPerSession ?? '-', 10)}  ${t.biggestColumn ? `${t.biggestColumn.column} ${mb(t.biggestColumn.bytes)}` : ''}`,
  );
console.log('\nfolders in the data dir:');
for (const [name, v] of Object.entries(report.folders)) console.log(`  ${pad(name, 28)}${v ? `${lpad(v.files, 8)} files ${lpad(mb(v.bytes), 10)}` : 'unreadable'}`);
console.log('backups:');
for (const [kind, v] of Object.entries(report.backups)) console.log(`  ${pad(kind, 28)}${lpad(v.files, 8)} files ${lpad(mb(v.bytes), 10)}`);
for (const p of report.plans) console.log(`\nplan: ${p.label}\n  ${p.sql}\n  ${p.plan.join('\n  ')}`);
if (diff) {
  console.log(`\ngrowth over ${diff.days} days (file ${mb(diff.fileBytesPerDay)}/day):`);
  for (const t of diff.tables) console.log(`  ${pad(t.table, 30)}${lpad(t.rowsAdded, 9)} rows ${lpad(mb(t.bytesAdded), 10)}  ${t.rowsPerDay ?? '-'} rows/d ${mb(t.bytesPerDay)}/d`);
}
