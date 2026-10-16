// T-739 B: the measurement behind migration 383 (the partial index on tool results). Runs only with CLAUDEPILOT_PERF=1 (a cluster Job; never
// the pod, never a real portal database). A synthetic SQLite database in a temp directory: no budget is asserted, the numbers are printed
// on lines starting `PERF ` and the plan checks are the ones in scorecardIndex.test.ts.
//
// Shape (assumptions, not a measurement of any real database): 100 sessions, CLAUDEPILOT_PERF_ROWS events in all (default 1,000,000), spread
// evenly over 14 days; 35 % of the events are tool results (a tool call is a tool_use plus a tool_result, and a turn also carries text,
// thinking and system lines, so about one line in three is a result); 5 % of the results are errors with 450 characters of text.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../store/migrations.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { loadToolResults } from './scorecardData.js';

const ROWS = Number(process.env.CLAUDEPILOT_PERF_ROWS ?? 1_000_000);
const SESSIONS = 100;
const PER_SESSION = Math.floor(ROWS / SESSIONS);
const BATCH = 10_000;
const BASE = Date.UTC(2026, 9, 1);
const SPAN = 14 * 86_400_000;
const END = BASE + SPAN;

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const ms = (x: number) => Math.round(x * 10) / 10;
const print = (label: string, v: unknown) => console.log(`PERF ${label} ${JSON.stringify(v)}`);

const OK = '{"toolName":"Bash","isError":0,"text":"' + 'x'.repeat(250) + '"}';
const DENIED = '{"toolName":"Bash","isError":1,"text":"permission denied: ' + 'd'.repeat(430) + '"}';
const PORTAL = '{"toolName":"mcp__pilot__ticket_get","isError":1,"text":"' + 'p'.repeat(450) + '"}';
const FAILED = '{"toolName":"Bash","isError":1,"text":"' + 'f'.repeat(450) + '"}';
const OTHER = '{"text":"' + 'y'.repeat(200) + '"}';

/** Event `k` of session `s`: its kind, time and payload (deterministic). */
function event(s: number, k: number): [string, string, string] {
  const at = new Date(BASE + Math.floor((k / PER_SESSION) * SPAN)).toISOString();
  const slot = (k + s) % 20;
  if (slot >= 7) return [at, 'assistant', OTHER];
  return [at, 'tool_result', slot === 0 ? [DENIED, PORTAL, FAILED][(k / 20 + s) % 3 | 0]! : OK];
}

async function open(withIndex: boolean) {
  const dir = tempDirectory('cp-perf-');
  const store = await Store.open({ dataDir: dir, secretKey: null, migrations: withIndex ? MIGRATIONS : MIGRATIONS.filter((m) => m.version !== 383) });
  const db = store.db!;
  const now = new Date(BASE).toISOString();
  const s = db.prepare("INSERT INTO chat_sessions (id, workspace_id, state_since, created_at, last_activity_at) VALUES (?, 'docker/api', ?, ?, ?)");
  for (let i = 0; i < SESSIONS; i++) s.run(`s${i}`, now, now, now);
  return { dir, store, db };
}

/** Insert every event in batches of 10k (one transaction each); the milliseconds of each batch. */
function fill(db: DatabaseSync): number[] {
  const ins = db.prepare('INSERT INTO chat_events (session_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)');
  const times: number[] = [];
  let n = 0;
  let t0 = performance.now();
  db.exec('BEGIN');
  for (let k = 0; k < PER_SESSION; k++) {
    for (let s = 0; s < SESSIONS; s++) {
      const [at, kind, payload] = event(s, k);
      ins.run(`s${s}`, k, at, kind, payload);
      if (++n % BATCH === 0) {
        db.exec('COMMIT');
        times.push(performance.now() - t0);
        db.exec('BEGIN');
        t0 = performance.now();
      }
    }
  }
  db.exec('COMMIT');
  return times;
}

const bytes = (db: DatabaseSync) => {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const g = (p: string) => Object.values(db.prepare(`PRAGMA ${p}`).get() as Record<string, number>)[0]!;
  return g('page_count') * g('page_size');
};

/** loadToolResults: the milliseconds of 5 runs after one warm-up, for a window and a set of sessions. */
function timeQuery(db: DatabaseSync, windowMs: number, ids: Set<string>): { median: number; runs: number[]; total: number } {
  let total = 0;
  const once = () => {
    const t = performance.now();
    total = loadToolResults(db, END - windowMs, END, ids).reduce((n, r) => n + r.total, 0);
    return performance.now() - t;
  };
  once();
  const runs = Array.from({ length: 5 }, once).map(ms);
  return { median: med(runs), runs, total };
}

const ids = (n: number) => new Set(Array.from({ length: n }, (_, i) => `s${i}`));
const SHAPES = [
  ['program20_24h', 86_400_000, 20],
  ['program20_7d', 7 * 86_400_000, 20],
  ['all100_24h', 86_400_000, 100],
  ['all100_7d', 7 * 86_400_000, 100],
] as const;

test('T-739 B: measure migration 383 on a synthetic database', { skip: process.env.CLAUDEPILOT_PERF !== '1' }, async () => {
  print('shape', { rows: PER_SESSION * SESSIONS, sessions: SESSIONS, toolResultShare: 0.35, errorShareOfResults: 0.05, days: 14 });

  // A: no index. Insert cost, the query before, the migration's own SQL, the query after.
  const a = await open(false);
  const insertNo = fill(a.db);
  const counts = a.db.prepare("SELECT COUNT(*) AS n, SUM(kind = 'tool_result') AS r FROM chat_events").get() as { n: number; r: number };
  print('rows', counts);
  const before = Object.fromEntries(SHAPES.map(([name, w, n]) => [name, timeQuery(a.db, w, ids(n))]));
  const sizeBefore = bytes(a.db);
  const m = MIGRATIONS.find((x) => x.version === 383)!;
  const t0 = performance.now();
  a.db.exec('BEGIN');
  m.up(a.db);
  a.db.exec('COMMIT');
  const buildS = (performance.now() - t0) / 1000;
  const sizeAfter = bytes(a.db);
  const after = Object.fromEntries(SHAPES.map(([name, w, n]) => [name, timeQuery(a.db, w, ids(n))]));
  print('index_build', { seconds: Math.round(buildS * 100) / 100, rows: counts.n, toolResultRows: counts.r, secondsPerMillionRows: Math.round((buildS / counts.n) * 1e8) / 100, dbBytesBefore: sizeBefore, dbBytesAfter: sizeAfter, indexBytes: sizeAfter - sizeBefore, indexShareOfDb: Math.round(((sizeAfter - sizeBefore) / sizeBefore) * 1000) / 10 });
  for (const [name] of SHAPES) {
    print(`query_${name}`, { beforeMedianMs: before[name]!.median, afterMedianMs: after[name]!.median, ratio: Math.round((after[name]!.median / before[name]!.median) * 100) / 100, beforeRuns: before[name]!.runs, afterRuns: after[name]!.runs, toolResultsSeen: after[name]!.total });
    assert.equal(after[name]!.total, before[name]!.total, 'the index changes no answer');
  }
  a.store.close();
  rmSync(a.dir, { recursive: true, force: true });

  // B: the index exists from the start. The same inserts.
  const b = await open(true);
  const insertYes = fill(b.db);
  b.store.close();
  rmSync(b.dir, { recursive: true, force: true });
  const per = (xs: number[]) => ({ batches: xs.length, medianMsPer10k: ms(med(xs)), firstTenMedian: ms(med(xs.slice(0, 10))), lastTenMedian: ms(med(xs.slice(-10))), totalS: Math.round(xs.reduce((s, x) => s + x, 0) / 10) / 100 });
  const no = per(insertNo);
  const yes = per(insertYes);
  print('insert', { withoutIndex: no, withIndex: yes, medianRatio: Math.round((yes.medianMsPer10k / no.medianMsPer10k) * 100) / 100, totalRatio: Math.round((yes.totalS / no.totalS) * 100) / 100 });
  print('rss_mib', Math.round(process.memoryUsage().rss / 1048576));
});
