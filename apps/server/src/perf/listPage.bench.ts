// A bench for the paged lists (D-58, T-382 S4): `listPage` of the sessions (5,000 rows) and the tickets (20,000 rows), in process.
// Not part of the suite (no *.test.ts name). Run from apps/server:
//   node --import tsx src/perf/listPage.bench.ts            (the full run)
//   BENCH_SMOKE=1 node --import tsx src/perf/listPage.bench.ts   (a few rows and rounds: a check that it runs)
// For each list it prints p50 and p95 in ms and the body size (raw and gzip) of the page, for page 1 and a deep page (about the middle),
// limits 50 and 100, with `keep` hiding 0%, 90% and 100% of the rows (the scan bound ends a request that hides everything).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ChatStore } from '../chat/store.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { Tickets } from '../tickets/service.js';
import { FakeSessions, UI } from '../tickets/testkit.js';

const SMOKE = process.env.BENCH_SMOKE === '1';
const SESSIONS = SMOKE ? 120 : 5_000;
const TICKETS = SMOKE ? 300 : 20_000;
const ROUNDS = SMOKE ? 3 : 30;
const LIMITS = [50, 100];
const HIDE = [0, 90, 100];

/** Keeps `100 - pct` percent of the rows, by a stable hash of the id (so the same rows are hidden in every round). */
const keeper = (pct: number) => (id: string) => {
  if (pct >= 100) return false;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 100 >= pct;
};

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

interface Page {
  items: unknown[];
  next: string | null;
}

function bench(label: string, run: (cursor: string | undefined, limit: number, hide: number) => Page, deepCursor: string | undefined) {
  for (const where of ['page 1', 'deep page'] as const) {
    const cursor = where === 'page 1' ? undefined : deepCursor;
    if (where === 'deep page' && !cursor) continue;
    for (const limit of LIMITS) {
      for (const hide of HIDE) {
        const times: number[] = [];
        let last: Page = { items: [], next: null };
        run(cursor, limit, hide); // warm up
        for (let i = 0; i < ROUNDS; i++) {
          const t0 = process.hrtime.bigint();
          last = run(cursor, limit, hide);
          times.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        times.sort((a, b) => a - b);
        const body = Buffer.from(JSON.stringify(last));
        console.log(
          `${label.padEnd(8)} ${where.padEnd(9)} limit=${String(limit).padEnd(3)} hide=${String(hide).padStart(3)}%  p50=${quantile(times, 0.5).toFixed(2)}ms p95=${quantile(times, 0.95).toFixed(2)}ms  rows=${String(last.items.length).padStart(3)}  raw=${body.length}B gzip=${gzipSync(body).length}B  next=${last.next ? 'yes' : 'no'}`,
        );
      }
    }
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'cp-bench-'));
const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
try {
  // Sessions: raw rows (the controller's create needs a live workspace), activity stamps spread over time, runs of equal stamps.
  const db = store.db!;
  const day = Date.UTC(2026, 0, 1);
  const insert = db.prepare('INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < SESSIONS; i++) {
    const at = new Date(day + Math.floor(i / 3) * 60_000).toISOString();
    insert.run(`bench-s-${String(i).padStart(6, '0')}`, `docker/ws${i % 7}`, `Bench session ${i}`, 'idle', at, at, at);
  }
  db.exec('COMMIT');
  const chat = new ChatStore(store);
  const sessionRun = (cursor: string | undefined, limit: number, hide: number) => {
    const keep = keeper(hide);
    return chat.listPage({}, { cursor, limit, keep: (s) => keep(s.id) });
  };
  let deepS: string | undefined;
  {
    let c: string | undefined;
    for (let i = 0; i < Math.floor(SESSIONS / 100 / 2); i++) c = chat.listPage({}, { cursor: c, limit: 100 }).next ?? c;
    deepS = c;
  }
  console.log(`-- sessions: ${SESSIONS} rows`);
  bench('sessions', sessionRun, deepS);

  // Tickets: created through the service, with a long description (the page cuts it).
  const tickets = new Tickets(store, new FakeSessions(), {});
  const text = 'A description line for the bench. '.repeat(40);
  tickets.start();
  for (let i = 0; i < TICKETS; i++) tickets.create(UI, { summary: `Bench ticket ${i}`, description: text });
  const ticketRun = (cursor: string | undefined, limit: number, hide: number) => {
    const keep = keeper(hide);
    return tickets.listPage(UI, {}, { cursor, limit, keep: (t) => keep(t.id) });
  };
  let deepT: string | undefined;
  {
    let c: string | undefined;
    for (let i = 0; i < Math.floor(TICKETS / 100 / 2); i++) c = tickets.listPage(UI, {}, { cursor: c, limit: 100 }).next ?? c;
    deepT = c;
  }
  console.log(`-- tickets: ${TICKETS} rows`);
  bench('tickets', ticketRun, deepT);
  tickets.stop();
} finally {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}
