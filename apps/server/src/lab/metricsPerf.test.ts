// T-2360 (§28.15): the measurement behind the metrics reads, in the style of scorecardPerf.test.ts. Runs only with CLAUDEPILOT_PERF=1 (a
// cluster Job; never the pod, never a real portal database). A synthetic SQLite database in a temp directory: no budget is asserted, the
// numbers are printed on lines starting `PERF `. The plan checks (the window read uses `tickets_closed_at`, the events by ticket number) run
// always, on a small database.
//
// Shape (assumptions, not a measurement of any real database): CLAUDEPILOT_PERF_TICKETS tickets (default 50,000) closed evenly over 90
// days, each with 8 events (status moves, comments with one self-test line and one verdict) and 2 tags, one merge record each, plus 500
// open tickets. The live portal had about 2,400 tickets on 2026-10-25 (T-2360 is ticket 2,360), so the default is about 20 times that.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { CLOSED_IN_WINDOW_SQL, loadFlowTickets, loadOpenTickets } from './flowMetricsData.js';
import { Metrics } from './metricsService.js';
import { CREW_TICKETS_SQL } from './scorecardData.js';

const H = 3_600_000;
const DAY = 24 * H;
const END = Date.UTC(2026, 9, 14, 12);
const SPAN = 90 * DAY;
const SHA = 'cd34'.repeat(10);

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const ms = (x: number) => Math.round(x * 10) / 10;
const print = (label: string, v: unknown) => console.log(`PERF ${label} ${JSON.stringify(v)}`);
const iso = (v: number) => new Date(v).toISOString();

function fill(db: DatabaseSync, tickets: number) {
  const t = db.prepare(
    `INSERT INTO tickets (number, type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, closed_at)
     VALUES (?, ?, 'normal', 2, ?, 'Seed', 'human', 'ui', 'Admin', ?, ?, ?)`,
  );
  const ev = db.prepare(
    `INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, body, data) VALUES (?, ?, ?, ?, 'x', ?, ?)`,
  );
  const tag = db.prepare('INSERT INTO ticket_tags (ticket_number, tag) VALUES (?, ?)');
  const merge = db.prepare(
    `INSERT INTO ticket_merge_status (ticket_number, repo, pr, pr_head, state, actor, actor_label, at) VALUES (?, 'claudepilot', 1, ?, 'merged', 'system', 'gate', ?)`,
  );
  db.exec('BEGIN');
  for (let n = 1; n <= tickets; n++) {
    const closed = END - SPAN + Math.floor((n / tickets) * SPAN);
    const created = closed - (2 + (n % 30)) * H;
    const s = (h: number) => iso(created + h * H);
    t.run(n, n % 3 ? 'feature' : 'bug', n % 10 ? 'done' : 'wont_do', iso(created), iso(closed), iso(closed));
    ev.run(n, s(0.5), 'status', 'session:w', null, JSON.stringify({ from: 'open', to: 'in_progress' }));
    ev.run(n, s(0.6), 'comment', 'session:w', 'Plan: ' + 'p'.repeat(200), null);
    ev.run(n, s(1), 'comment', 'session:w', `Self-test: npm test on ${SHA} fail 2`, null);
    ev.run(n, s(1.2), 'comment', 'session:w', `Self-test: npm test on ${SHA} pass 9`, null);
    ev.run(n, s(1.4), 'comment', 'session:q', 'QA', JSON.stringify({ verdict: 'pass', role: 'qa' }));
    ev.run(n, s(1.5), 'status', 'session:w', null, JSON.stringify({ from: 'in_progress', to: 'in_review' }));
    ev.run(n, s(1.6), 'comment', 'ui', 'ok ' + 'o'.repeat(300), null);
    ev.run(n, iso(closed), 'closed', 'ui', null, JSON.stringify({ from: 'in_review', to: 'done' }));
    tag.run(n, n % 2 ? 'claudepilot' : 'konfersi');
    tag.run(n, `area-${n % 7}`);
    merge.run(n, SHA, s(1.8));
  }
  for (let n = tickets + 1; n <= tickets + 500; n++) {
    t.run(n, 'task', ['open', 'in_progress', 'blocked', 'in_review'][n % 4]!, iso(END - 5 * DAY), iso(END - (n % 48) * H), null);
    tag.run(n, n % 2 ? 'claudepilot' : 'konfersi');
  }
  db.exec('COMMIT');
}

async function open(tickets: number) {
  const dir = tempDirectory('cp-metrics-perf-');
  const store = await Store.open({ dataDir: dir, secretKey: null });
  fill(store.db!, tickets);
  return { dir, store, db: store.db!, done: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}

const time = <T>(fn: () => T): { median: number; runs: number[]; out: T } => {
  let out = fn();
  const runs = Array.from({ length: 5 }, () => {
    const t = performance.now();
    out = fn();
    return ms(performance.now() - t);
  });
  return { median: med(runs), runs, out };
};

test('metrics reads: the window read uses tickets_closed_at; events and tags are read by ticket number', async () => {
  const h = await open(50);
  try {
    const plan = (sql: string, ...args: (string | number)[]) =>
      (h.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(' | ');
    assert.match(plan(CLOSED_IN_WINDOW_SQL, 'a', 'b'), /tickets_closed_at/);
    assert.match(
      plan(
        `SELECT ticket_number FROM ticket_events WHERE ticket_number IN (?, ?) AND kind IN ('status', 'comment') ORDER BY ticket_number, id`,
        1,
        2,
      ),
      /ticket_events_ticket/,
    );
    assert.doesNotMatch(plan(`SELECT ticket_number, tag FROM ticket_tags WHERE ticket_number IN (?, ?)`, 1, 2), /^SCAN ticket_tags$/);
    // The loader agrees with the seed: 50 closed over 90 days, each with one start, three verdicts and one merge.
    const all = loadFlowTickets(h.db, END - SPAN - DAY, END + 1, null);
    assert.equal(all.length, 50);
    assert.ok(all.every((f) => f.verdicts.length === 3 && f.merges.length === 1 && f.starts.length === 1));
    assert.equal(loadOpenTickets(h.db).length, 500);
  } finally {
    h.done();
  }
});

test('crew facts ticket read: a union of index reads (tickets_queue, tickets_updated_at, tickets_closed_at), never a scan of every ticket', async () => {
  const h = await open(50);
  try {
    const plan = (h.db.prepare(`EXPLAIN QUERY PLAN ${CREW_TICKETS_SQL}`).all('a', 'b') as { detail: string }[])
      .map((r) => r.detail)
      .join(' | ');
    assert.doesNotMatch(plan, /SCAN tickets\b/, plan);
    assert.match(plan, /tickets_updated_at/, plan);
    assert.match(plan, /tickets_closed_at/, plan);
  } finally {
    h.done();
  }
});

test('T-2360 re-review B: a database that ran 856 before the index existed gets tickets_updated_at from its own migration', async () => {
  const dir = tempDirectory('cp-metrics-mig-');
  try {
    const first = await Store.open({ dataDir: dir, secretKey: null });
    const db = first.db!;
    // As the earlier branch build left it: 856 applied without the index, 882 unknown.
    db.exec('DROP INDEX tickets_updated_at');
    const applied = JSON.parse((db.prepare(`SELECT value FROM portal_meta WHERE key = 'migrations_applied'`).get() as { value: string }).value) as number[];
    db.prepare(`UPDATE portal_meta SET value = ? WHERE key = 'migrations_applied'`).run(JSON.stringify(applied.filter((v) => v !== 882)));
    first.close();
    const again = await Store.open({ dataDir: dir, secretKey: null });
    const idx = again.db!.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tickets_updated_at'`).get();
    again.close();
    assert.ok(idx, 'the index is created by 882 on a database that already ran 856');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Chat data for the crew facts: 8 leads with 4 workers each (worker `w` of the seed is one), 300 events and 60 usage rows per session. */
function fillChat(db: DatabaseSync) {
  const s = db.prepare(
    `INSERT INTO chat_sessions (id, workspace_id, state, state_since, created_at, last_activity_at, parent_id) VALUES (?, 'docker/api', 'idle', ?, ?, ?, ?)`,
  );
  const ev = db.prepare('INSERT INTO chat_events (session_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)');
  const use = db.prepare(
    `INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, cost_usd, requests) VALUES (?, ?, ?, 'docker/api', 'c1', 'm', 0.5, 1)`,
  );
  const ids: string[] = [];
  db.exec('BEGIN');
  for (let l = 0; l < 8; l++) {
    const lead = `L${l}`;
    s.run(lead, iso(END - 20 * DAY), iso(END - 20 * DAY), iso(END - H), null);
    ids.push(lead);
    for (let w = 0; w < 4; w++) {
      const id = l === 0 && w === 0 ? 'w' : `W${l}-${w}`;
      s.run(id, iso(END - 10 * DAY), iso(END - 10 * DAY), iso(END - H), lead);
      ids.push(id);
    }
  }
  for (const id of ids) {
    for (let k = 0; k < 300; k++) {
      const at = END - Math.floor((k / 300) * 14 * DAY);
      ev.run(
        id,
        k,
        iso(at),
        k % 5 ? 'assistant' : 'tool_result',
        k % 5 ? '{"text":"x"}' : JSON.stringify({ toolName: 'Bash', isError: k % 50 === 0, text: 'out' }),
      );
    }
    for (let k = 0; k < 60; k++) {
      const at = END - Math.floor((k / 60) * 14 * DAY);
      use.run(iso(at), at, id);
    }
  }
  db.exec('COMMIT');
}

test('T-2360 review: the reads within a time budget with chat data seeded; a second call within the memo reads nothing again', async () => {
  const h = await open(5_000);
  try {
    fillChat(h.db);
    let nowMs = END;
    const metrics = new Metrics({ store: h.store, now: () => nowMs, settings: null, paces: null, memoMs: 60_000 });
    const t0 = performance.now();
    const ov = await metrics.overview('all', '7d');
    metrics.flow('all', '7d', 'lead');
    metrics.tickets('all', '7d', {});
    await metrics.insights('all', '7d');
    const cold = performance.now() - t0;
    print('budget_cold_ms', ms(cold));
    // Budget (a cluster Job, about 4 CPUs): 5,000 tickets with 8 events each, 40 sessions with 12,000 events and 2,400 usage rows.
    assert.ok(cold < 4_000, `the four reads took ${ms(cold)} ms (budget 4,000)`);
    assert.ok(ov && ov.flow && ov.flow.current.done > 0);
    // Within the memo: a ticket closed now is not read yet, and the call is quick.
    h.db
      .prepare(
        `INSERT INTO tickets (number, type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, closed_at) VALUES (99999, 'bug', 'normal', 2, 'done', 'S', 'human', 'ui', 'Admin', ?, ?, ?)`,
      )
      .run(iso(END - H), iso(END - 1000), iso(END - 1000));
    nowMs = END + 30_000;
    const t1 = performance.now();
    const again = await metrics.overview('all', '7d');
    const warm = performance.now() - t1;
    print('budget_warm_ms', ms(warm));
    assert.equal(again!.flow!.current.done, ov.flow.current.done, 'the memo served the same read');
    assert.ok(warm < cold / 2, `a memoized call (${ms(warm)} ms) costs well under the cold one (${ms(cold)} ms)`);
    // Past the memo: read again, the new ticket counts.
    nowMs = END + 61_000;
    assert.equal((await metrics.overview('all', '7d'))!.flow!.current.done, ov.flow.current.done + 1);
  } finally {
    h.done();
  }
});

test('T-2360: measure the metrics reads on a synthetic database', { skip: process.env.CLAUDEPILOT_PERF !== '1' }, async () => {
  const tickets = Number(process.env.CLAUDEPILOT_PERF_TICKETS ?? 50_000);
  const t0 = performance.now();
  const h = await open(tickets);
  print('shape', { tickets, open: 500, eventsPerTicket: 8, days: 90, fillSeconds: Math.round((performance.now() - t0) / 10) / 100 });
  try {
    const metrics = new Metrics({ store: h.store, now: () => END, settings: null, paces: null });
    for (const [name, back] of [
      ['load_48h', 2 * DAY],
      ['load_14d', 14 * DAY],
    ] as const) {
      const r = time(() => loadFlowTickets(h.db, END - back, END + 1, null));
      print(name, { medianMs: r.median, runs: r.runs, rows: r.out.length });
    }
    const o = time(() => loadOpenTickets(h.db));
    print('open', { medianMs: o.median, runs: o.runs, rows: o.out.length });
    const flow24 = time(() => metrics.flow('all', '24h', 'lead'));
    print('flow_all_24h_lead', { medianMs: flow24.median, runs: flow24.runs, done: flow24.out!.total!.current.done });
    const flow7 = time(() => metrics.flow('claudepilot', '7d', 'type'));
    print('flow_claudepilot_7d_type', { medianMs: flow7.median, runs: flow7.runs, done: flow7.out!.total!.current.done });
    const runs: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t = performance.now();
      await metrics.overview('all', '7d');
      if (i) runs.push(ms(performance.now() - t));
    }
    print('overview_all_7d', { medianMs: med(runs), runs });
    const st = performance.now();
    const written = await metrics.snapshot();
    print('snapshot', { ms: ms(performance.now() - st), rows: written });
    print('rss_mib', Math.round(process.memoryUsage().rss / 1048576));
  } finally {
    h.done();
  }
});
