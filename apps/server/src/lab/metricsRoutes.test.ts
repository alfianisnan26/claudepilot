// Pilot metrics (T-2360, §28.15): the loader on a seeded sqlite, migration 856, the snapshot store (write, retention, trend read, the
// previous score), and the /api/lab/metrics routes behind the seam (the owner reads; another user and an agent get the same 404; bad
// parameters are a 422). The lab's clock is injected: nothing reads the real one. No token-shaped literal: the commit sha is built here.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import { METRICS_API, type Actor, type MetricsFlow, type MetricsInsights, type MetricsOverview, type MetricsProgram, type MetricsTickets, type MetricsTrend } from '@portal/contracts';
import { clearResolvers, declaredPolicies } from '../authz/seam.js';
import { selfTestAt } from '../flow/engine.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { LAB_POLICIES } from './authz.js';
import { ticketFlow } from './flowMetrics.js';
import { leadOf, loadFlowTickets, loadOpenTickets, loadProgramTags, selfTestLineOf, verdictOf } from './flowMetricsData.js';
import { Lab } from './index.js';
import { KEEP_SNAPSHOTS_MS, pruneMetricSnapshots, readTrend, snapshotNear, SNAPSHOT_EVERY_MS, writeSnapshots } from './metricsSnapshots.js';
import { createLabRoutes } from './routes.js';
import { FLOW_UNAVAILABLE, MAX_SNAPSHOT_PROGRAMS, Metrics } from './metricsService.js';
import { METRICS_SETTING } from './metricsSettings.js';
import { Tickets } from '../tickets/service.js';
import { FakeSessions, UI } from '../tickets/testkit.js';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 12);
const iso = (ms: number) => new Date(ms).toISOString();
const at = (hoursAgo: number) => NOW - hoursAgo * H;
const SHA = 'ab12'.repeat(10);

afterEach(() => clearResolvers());

async function seeded(opts: { settings?: Record<string, unknown> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'metrics-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const db = store.db!;
  let now = NOW;
  const settings = { get: (k: string) => opts.settings?.[k] };
  const lab = new Lab({ store, now: () => now, settings });
  const ticket = (n: number, status: string, o: { createdAgo: number; closedAgo?: number; type?: string; priority?: string; tags?: string[]; updatedAgo?: number }) => {
    db.prepare(
      `INSERT INTO tickets (number, type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, 2, ?, 'Seed', 'human', 'ui', 'Admin', ?, ?, ?)`,
    ).run(n, o.type ?? 'feature', o.priority ?? 'normal', status, iso(at(o.createdAgo)), iso(at(o.updatedAgo ?? o.closedAgo ?? 0)), o.closedAgo === undefined ? null : iso(at(o.closedAgo)));
    for (const t of o.tags ?? []) db.prepare('INSERT INTO ticket_tags (ticket_number, tag) VALUES (?, ?)').run(n, t);
  };
  const status = (n: number, hoursAgo: number, from: string, to: string, actor = 'session:W1') =>
    db.prepare(`INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, data) VALUES (?, ?, 'status', ?, 'x', ?)`).run(n, iso(at(hoursAgo)), actor, JSON.stringify({ from, to }));
  const comment = (n: number, hoursAgo: number, body: string, o: { actor?: string; data?: unknown } = {}) =>
    db
      .prepare(`INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, body, data) VALUES (?, ?, 'comment', ?, 'x', ?, ?)`)
      .run(n, iso(at(hoursAgo)), o.actor ?? 'session:W1', body, o.data === undefined ? null : JSON.stringify(o.data));
  const merged = (n: number, hoursAgo: number) =>
    db
      .prepare(`INSERT INTO ticket_merge_status (ticket_number, repo, pr, pr_head, state, actor, actor_label, at) VALUES (?, 'claudepilot', 7, ?, 'merged', 'system', 'gate', ?)`)
      .run(n, SHA, iso(at(hoursAgo)));

  // T-1: the full journey (golden): created 10 h ago; started 9; agent comment 8.5; self-test FAIL 6; QA pass 4; merged 3; done 1.
  ticket(1, 'done', { createdAgo: 10, closedAgo: 1, tags: ['claudepilot', 'area-lab'], priority: 'high' });
  status(1, 9, 'open', 'in_progress');
  comment(1, 8.5, 'Plan: the loader first.');
  comment(1, 6, `Done so far.\nSelf-test: claudepilot-job-1 on ${SHA} fail 3`);
  comment(1, 4, 'QA: pass', { actor: 'session:Q1', data: { verdict: 'pass', role: 'qa' } });
  // A self-test line quoted inside a line, and as a quote block, is not a verdict (D-102: the line starts with "Self-test:").
  comment(1, 5, `Quoting the old run: "Self-test: claudepilot-job-9 on ${SHA} pass 4"\n> Self-test: claudepilot-job-9 on ${SHA} pass 4`);
  // Nor is one inside a code fence, though the line inside starts with "Self-test:" (the SQL brings the body; the parser skips the fence).
  comment(1, 4.5, `The log said:\n\`\`\`\nSelf-test: claudepilot-job-9 on ${SHA} pass 4\n\`\`\``);  merged(1, 3);
  // T-2: won't-do, Konfersi.
  ticket(2, 'wont_do', { createdAgo: 6, closedAgo: 2, tags: ['konfersi'] });
  // T-3: done with nothing recorded but its open and close: only resolve (15 h) counts; every other stage leaves it out.
  ticket(3, 'done', { createdAgo: 20, closedAgo: 5, tags: ['konfersi'], type: 'bug' });
  // T-4: done in the previous 24 h window.
  ticket(4, 'done', { createdAgo: 40, closedAgo: 30, tags: ['claudepilot'] });
  // T-5 in review for 5 h; T-6 blocked; T-9 in progress, untouched for 8 h (stalled at the default 3 h).
  ticket(5, 'in_review', { createdAgo: 12, updatedAgo: 5, tags: ['claudepilot'] });
  status(5, 5, 'in_progress', 'in_review');
  ticket(6, 'blocked', { createdAgo: 12, updatedAgo: 2, tags: ['konfersi'] });
  ticket(9, 'in_progress', { createdAgo: 12, updatedAgo: 8, tags: ['claudepilot'] });
  // T-7: closed 60 h ago, outside every window read; T-8: a program-* tag no setting entry covers.
  ticket(7, 'done', { createdAgo: 70, closedAgo: 60, tags: ['claudepilot'] });
  ticket(8, 'done', { createdAgo: 4, closedAgo: 3, tags: ['program-kohi'] });
  return {
    store,
    db,
    lab,
    setNow: (v: number) => (now = v),
    ticket,
    done: () => (lab.close(), store.close(), rmSync(dataDir, { recursive: true, force: true })),
  };
}

function app(lab: Lab, actor?: Actor) {
  const a = new Hono<{ Variables: { token: string; actor: Actor } }>();
  a.use(async (c, next) => {
    if (actor) c.set('actor', actor);
    else c.set('token', 'signed-in');
    await next();
  });
  a.onError((e, c) => (isAppError(e) ? c.json({ error: { code: e.code } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500)));
  a.route('/api/lab', createLabRoutes(lab));
  return a;
}

const bob: Actor = { kind: 'user', userId: 'u_bob', loginSessionId: 'x', via: 'ui' };
const agent: Actor = { kind: 'agent', userId: 'u_owner', tokenId: 't', sessionId: 'W1', workspaceId: 'docker/api' } as Actor;

test('migration 856: the snapshot table and its indexes, and the closed-at index on tickets', async () => {
  const h = await seeded();
  try {
    const names = (h.db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'lab_metric_snapshots%' OR name = 'tickets_closed_at' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(names, ['lab_metric_snapshots', 'lab_metric_snapshots_at', 'lab_metric_snapshots_program_at', 'tickets_closed_at']);
    const plan = h.db.prepare(`EXPLAIN QUERY PLAN SELECT number FROM tickets WHERE closed_at >= ? AND closed_at < ?`).all('a', 'b') as { detail: string }[];
    assert.ok(plan.some((p) => /tickets_closed_at/.test(p.detail)), 'the window read uses the index');
    assert.throws(() => h.db.prepare(`INSERT INTO lab_metric_snapshots (at_ms, program, metrics) VALUES (1, 'x', 'not json')`).run());
  } finally {
    h.done();
  }
});

test('loader: the golden ticket’s stages from events, verdicts, self-test lines and merges; nothing outside the span', async () => {
  const h = await seeded();
  try {
    const facts = loadFlowTickets(h.db, at(48), NOW + 1, null);
    assert.deepEqual(facts.map((f) => f.id).sort(), ['T-1', 'T-2', 'T-3', 'T-4', 'T-8']);
    const t1 = facts.find((f) => f.id === 'T-1')!;
    assert.deepEqual(t1.verdicts, [
      { atMs: at(6), pass: false },
      { atMs: at(4), pass: true },
    ], 'the self-test lines quoted at 5 h (inside a line, as "> ") and fenced at 4.5 h are not verdicts');
    assert.equal(t1.firstAgentCommentMs, at(8.5));
    assert.equal(t1.lead, 'area-lab');
    const r = ticketFlow(t1);
    assert.deepEqual(r.stages, { start: H, report: 1.5 * H, implement: 3 * H, test: 2 * H, deliver: 2 * H, resolve: 9 * H, work: 8 * H });
    assert.deepEqual([r.rounds, r.fails], [2, 1]);
    const t3 = ticketFlow(facts.find((f) => f.id === 'T-3')!);
    assert.deepEqual(t3.stages, { start: null, report: null, implement: null, test: null, deliver: null, resolve: 15 * H, work: null });
    assert.equal(facts.find((f) => f.id === 'T-3')!.lead, 'unrecorded');
    assert.deepEqual(loadProgramTags(h.db, at(30 * 24)), ['program-kohi']);
    const open = loadOpenTickets(h.db);
    assert.deepEqual(open.map((t) => [t.id, t.status]).sort(), [['T-5', 'in_review'], ['T-6', 'blocked'], ['T-9', 'in_progress']]);
    assert.equal(open.find((t) => t.id === 'T-5')!.statusSinceMs, at(5));
  } finally {
    h.done();
  }
});

test('loader: the watchdog’s bold self-test form is a verdict (the SQL brings a body naming "Self-test" in any marks)', async () => {
  const h = await seeded();
  try {
    h.ticket(10, 'done', { createdAgo: 9, closedAgo: 2, tags: ['claudepilot'] });
    const add = (hoursAgo: number, body: string) =>
      h.db.prepare(`INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, body) VALUES (10, ?, 'comment', 'session:W1', 'x', ?)`).run(iso(at(hoursAgo)), body);
    add(4, `Bundle done.\n**Self-test**: \`npm test\` on ${SHA} fail 2`);
    add(3, `Fixed.\n**Self-test:** \`claudepilot-job-2\` on ${SHA} pass 40`);
    add(2.5, `> **Self-test:** claudepilot-job-9 on ${SHA} pass 4`);
    const t10 = loadFlowTickets(h.db, at(48), NOW + 1, null).find((f) => f.id === 'T-10')!;
    assert.deepEqual(t10.verdicts, [
      { atMs: at(4), pass: false },
      { atMs: at(3), pass: true },
    ], 'both bold lines count; the bold one in a quote does not');
  } finally {
    h.done();
  }
});

test('selfTestLineOf: only a line that starts with "Self-test:" outside a code fence', () => {
  const line = `Self-test: claudepilot-job-1 on ${SHA} pass 12`;
  assert.equal(selfTestLineOf(line), line);
  assert.equal(selfTestLineOf(`Notes first.\r\n${line}\nmore`), line, 'any line, CRLF too');
  // Read as the flow watchdog reads it (flow/engine.ts selfTestText): bold and code marks dropped, so these count for both.
  for (const [name, body] of [
    ['bold label', `**Self-test:** \`claudepilot-job-1\` on ${SHA} pass 12`],
    ['bold word', `**Self-test**: claudepilot-job-1 on \`${SHA}\` pass 12`],
    ['whole line bold', `**${line}**`],
    ['inline code', `\`${line}\``],
    ['trailing spaces', `${line}   `],
  ] as const) {
    assert.equal(selfTestLineOf(body), line, name);
    assert.ok(selfTestAt([{ at: new Date(NOW).toISOString(), body }], SHA) !== null, `${name}: the watchdog counts it too`);
    assert.equal(verdictOf(null, selfTestLineOf(body)), true, name);
  }
  for (const [name, body] of [
    ['mid-line', `The last one read "${line}".`],
    ['mid-line bold', `The last one read **${line}**.`],
    ['blockquote', `> ${line}`],
    ['blockquote bold', `> **Self-test:** claudepilot-job-1 on ${SHA} pass 12`],
    ['nested quote', `>> ${line}`],
    ['list item', `- ${line}`],
    ['indented code', `    ${line}`],
    ['bold fence', `\`\`\`\n**Self-test:** claudepilot-job-1 on ${SHA} pass 12\n\`\`\``],
    ['backtick fence', `Old run:\n\`\`\`\n${line}\n\`\`\``],
    ['tilde fence with info', `~~~text\n${line}\n~~~`],
    ['unclosed fence', `\`\`\`\n${line}`],
    ['longer fence, short close inside', `\`\`\`\`\n\`\`\`\n${line}\n\`\`\`\``],
    ['empty', ''],
  ] as const)
    assert.equal(selfTestLineOf(body), null, name);
  assert.equal(selfTestLineOf(null), null);
  // After the fence closes, a real line counts; the first real one wins.
  const fail = `Self-test: npm test on ${SHA} fail 2`;
  assert.equal(selfTestLineOf(`\`\`\`\n${line}\n\`\`\`\n${fail}\n${line}`), fail);
  assert.equal(selfTestLineOf(`~~~\n\`\`\`\n${line}\n~~~\n${fail}`), fail, 'a backtick line does not close a tilde fence');
  assert.equal(selfTestLineOf(`${'Self-test: '}${'x'.repeat(400)}`)!.length, 300);
});

test('verdictOf and leadOf', () => {
  assert.equal(verdictOf(JSON.stringify({ verdict: 'fail' }), null), false);
  assert.equal(verdictOf(JSON.stringify({ verdict: 'PASS' }), null), true);
  assert.equal(verdictOf(null, `Self-test: npm test on ${SHA} pass 12`), true);
  assert.equal(verdictOf(null, `Self-test: npm test on ${SHA.slice(0, 8)} pass 12`), null, 'a short sha is not a self-test line');
  assert.equal(verdictOf('not json', 'Self-test: soon'), null);
  assert.equal(verdictOf(null, null), null);
  assert.equal(leadOf(['konfersi', 'area-web', 'area-api'], 'W1', null), 'area-api');
  assert.equal(leadOf(['konfersi'], null, null), 'unrecorded');
});

test('snapshots: write keeps only known keys, the trend reads one metric in its window, retention drops what is over 30 days', async () => {
  const h = await seeded();
  try {
    writeSnapshots(h.db, at(2), [{ program: 'all', values: { effectiveness: 60, done24h: 3, bogus: 9 } as never }]);
    writeSnapshots(h.db, at(1), [{ program: 'all', values: { effectiveness: 70, efficiency: Number.NaN } }]);
    writeSnapshots(h.db, NOW - KEEP_SNAPSHOTS_MS - H, [{ program: 'all', values: { effectiveness: 10 } }]);
    assert.deepEqual(readTrend(h.db, 'all', 'effectiveness', at(3), NOW), [
      { atMs: at(2), value: 60 },
      { atMs: at(1), value: 70 },
    ]);
    assert.deepEqual(readTrend(h.db, 'all', 'efficiency', at(3), NOW), [
      { atMs: at(2), value: null },
      { atMs: at(1), value: null },
    ]);
    const raw = h.db.prepare(`SELECT metrics FROM lab_metric_snapshots WHERE at_ms = ?`).get(at(2)) as { metrics: string };
    assert.deepEqual(JSON.parse(raw.metrics), { effectiveness: 60, done24h: 3 });
    assert.equal(snapshotNear(h.db, 'all', at(1.5), H)?.values.effectiveness, 60);
    assert.equal(snapshotNear(h.db, 'all', at(4), H), null, 'nothing within the tolerance');
    assert.equal(pruneMetricSnapshots(h.db, NOW), 1);
    assert.equal(pruneMetricSnapshots(h.db, NOW), 0);
  } finally {
    h.done();
  }
});

test('Metrics.snapshot: one row per ticket program, read back by the trend and as the previous score', async () => {
  const h = await seeded();
  try {
    h.setNow(at(24));
    // A day earlier ([48 h ago, 24 h ago)) ClaudePilot's done is T-4 (closed 30 h ago); T-1 closes later. Now it is T-1. The first
    // snapshot is what `previous` reads a day later.
    const n1 = await h.lab.snapshotMetrics();
    h.setNow(NOW);
    const n2 = await h.lab.snapshotMetrics();
    const programs = h.lab.metrics.programs().filter((p) => p.kind !== 'commits').map((p) => p.id);
    assert.equal(n1, programs.length);
    assert.equal(n2, programs.length);
    assert.deepEqual(programs, ['all', 'claudepilot', 'konfersi', 'kohi']);
    const trend = h.lab.metrics.trend('claudepilot', 'done24h', '7d')!;
    assert.deepEqual(trend.points.map((p) => [p.atMs, p.value]), [
      [at(24), 1],
      [NOW, 1],
    ]);
    assert.equal(trend.everyMs, SNAPSHOT_EVERY_MS);
    const first = h.db.prepare(`SELECT metrics FROM lab_metric_snapshots WHERE program = 'all' AND at_ms = ?`).get(at(24)) as { metrics: string };
    const ov = (await h.lab.metrics.overview('all', '24h'))!;
    assert.equal(ov.effectiveness.previous, JSON.parse(first.metrics).effectiveness);
  } finally {
    h.done();
  }
});

test('Metrics.overview and flow: the program’s tickets only, won’t-do apart, excluded counted, no crew is unavailable not 0', async () => {
  const h = await seeded();
  try {
    const ov = (await h.lab.metrics.overview('konfersi', '24h'))!;
    assert.equal(ov.program.id, 'konfersi');
    assert.deepEqual([ov.flow!.current.done, ov.flow!.current.wontDo], [1, 1]);
    const start = ov.flow!.current.stages.find((s) => s.stage === 'start')!;
    assert.deepEqual([start.n, start.excluded, start.medianMs], [0, 1, null]);
    assert.deepEqual(ov.open, { open: 0, inProgress: 0, blocked: 1, inReview: 0, oldestReviewMs: null, stalled: 0 });
    // No live session at all: every efficiency part is unavailable with a reason; the score is null, never 0.
    assert.equal(ov.efficiency.value, null);
    assert.ok(ov.efficiency.components.every((c) => c.basis === 'unavailable' && c.reason));
    assert.match(ov.effectiveness.basis, /pilot-health skill was not available/);
    const all = h.lab.metrics.flow('all', '24h', 'program')!;
    assert.equal(all.total!.current.done, 3); // T-1, T-3, T-8
    assert.equal(all.total!.previous.done, 1); // T-4
    assert.deepEqual(all.groups.map((g) => [g.key, g.current.done]), [['claudepilot', 1], ['kohi', 1], ['konfersi', 1]]);
    const memor = (await h.lab.metrics.overview('memor-id', '24h'))!;
    assert.equal(memor.program.unavailable?.reason, 'no_source');
    assert.equal(memor.effectiveness.value, null);
    const ins = (await h.lab.metrics.insights('memor-id', '24h'))!;
    assert.deepEqual(ins.items.map((i) => i.kind), ['no_data']);
  } finally {
    h.done();
  }
});

test('Metrics.tickets: drill-down by stage and by group; the setting changes the programs and their targets', async () => {
  const h = await seeded({ settings: { 'lab.metricsPrograms': 'all=Everything|*|1/10/1;cp=CP|claudepilot|1/2/3' } });
  try {
    const progs = h.lab.metrics.programs();
    assert.deepEqual(progs.map((p) => [p.id, p.label]), [['all', 'Everything'], ['cp', 'CP'], ['kohi', 'kohi'], ['konfersi', 'konfersi']]);
    assert.deepEqual(progs.find((p) => p.id === 'cp')!.targets, { closuresPerHour: 1, resolveHours: 2, reviewHours: 3 });
    assert.equal(progs.find((p) => p.id === 'konfersi')!.source, 'flow', 'the flow default program covers konfersi-migration');
    const tested = h.lab.metrics.tickets('all', '24h', { stage: 'test' })!;
    assert.deepEqual(tested.rows.map((r) => r.ticket), ['T-1']);
    const byLead = h.lab.metrics.tickets('all', '24h', { groupBy: 'lead', group: 'unrecorded' })!;
    assert.deepEqual(byLead.rows.map((r) => r.ticket), ['T-2', 'T-8', 'T-3'], 'no area-* tag and no holder; newest close first');
    assert.equal(byLead.total, 3);
    assert.equal(h.lab.metrics.tickets('nope', '24h', {}), null);
  } finally {
    h.done();
  }
});

test('routes: every metrics route is declared; the owner reads; bob and an agent get the 404; bad parameters are a 422', async () => {
  const h = await seeded();
  try {
    for (const path of Object.values(METRICS_API)) assert.equal(declaredPolicies().get(`GET ${path}`)?.kind, 'platform', path);
    assert.deepEqual(Object.keys(LAB_POLICIES).filter((k) => k.startsWith('GET /api/lab/metrics/')).sort(), Object.values(METRICS_API).map((p) => `GET ${p}`).sort());
    const owner = app(h.lab);
    const get = async (a: ReturnType<typeof app>, url: string) => {
      const res = await a.request(url);
      return { status: res.status, body: (await res.json()) as { data?: unknown; error?: { code: string } } };
    };
    const progs = await get(owner, '/api/lab/metrics/programs');
    assert.equal(progs.status, 200);
    assert.equal((progs.body.data as MetricsProgram[])[0]!.id, 'all');
    const ov = await get(owner, '/api/lab/metrics/overview?program=claudepilot');
    assert.equal(ov.status, 200);
    assert.equal((ov.body.data as MetricsOverview).window, '24h');
    const fl = await get(owner, '/api/lab/metrics/flow?window=7d&groupBy=type');
    assert.equal(fl.status, 200);
    assert.deepEqual((fl.body.data as MetricsFlow).groups.map((g) => g.key).sort(), ['bug', 'feature']);
    const tr = await get(owner, '/api/lab/metrics/trend?metric=resolveP50&window=30d');
    assert.equal(tr.status, 200);
    assert.deepEqual((tr.body.data as MetricsTrend).points, []);
    const tk = await get(owner, '/api/lab/metrics/tickets?stage=resolve&groupBy=priority&group=high');
    assert.equal(tk.status, 200);
    assert.deepEqual((tk.body.data as MetricsTickets).rows.map((r) => r.ticket), ['T-1']);
    // T-2360 review LOW: `offset` pages the drill-down; `total` stays over all rows.
    const all = (await get(owner, '/api/lab/metrics/tickets?window=7d')).body.data as MetricsTickets;
    const rest = (await get(owner, '/api/lab/metrics/tickets?window=7d&offset=1')).body.data as MetricsTickets;
    assert.ok(all.rows.length >= 2);
    assert.deepEqual([rest.total, rest.rows.map((r) => r.ticket)], [all.total, all.rows.slice(1).map((r) => r.ticket)]);
    assert.deepEqual(((await get(owner, `/api/lab/metrics/tickets?window=7d&offset=${all.total}`)).body.data as MetricsTickets).rows, []);
    const ins = await get(owner, '/api/lab/metrics/insights?program=konfersi');
    assert.equal(ins.status, 200);
    assert.ok(Array.isArray((ins.body.data as MetricsInsights).items));

    for (const url of ['/api/lab/metrics/overview?window=1h', '/api/lab/metrics/flow?groupBy=colour', '/api/lab/metrics/trend?metric=x', '/api/lab/metrics/tickets?group=high', '/api/lab/metrics/tickets?stage=nap', '/api/lab/metrics/tickets?offset=-1', '/api/lab/metrics/tickets?offset=1.5', '/api/lab/metrics/overview?program=a%20b']) {
      const r = await get(owner, url);
      assert.equal(r.status, 422, url);
      assert.equal(r.body.error?.code, 'VALIDATION_FAILED', url);
    }
    const missing = await get(owner, '/api/lab/metrics/overview?program=nope');
    assert.deepEqual([missing.status, missing.body.error?.code], [404, 'NOT_FOUND']);

    for (const who of [bob, agent]) {
      const a = app(h.lab, who);
      for (const path of Object.values(METRICS_API)) {
        const r = await get(a, path);
        assert.deepEqual([r.status, r.body.error?.code], [404, 'NOT_FOUND'], `${who.kind} ${path}`);
      }
    }
  } finally {
    h.done();
  }
});

test('a failed closed-ticket read is unavailable (no_source) in flow, tickets, overview, insights and the snapshot, never 0; the log names the error only', async () => {
  const h = await seeded();
  try {
    const logs: string[] = [];
    // The window read throws (as a locked or broken store would); every other read works.
    const db = new Proxy(h.db, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            if (sql.includes('closed_at >= ?')) throw Object.assign(new Error('detail that must not be logged'), { name: 'SqliteError' });
            return target.prepare(sql);
          };
        const v = Reflect.get(target, key) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const m = new Metrics({ store: { db, writable: true } as unknown as Store, now: () => NOW, settings: null, paces: null, log: (s) => logs.push(s) });
    const flow = m.flow('all', '24h', 'lead')!;
    assert.deepEqual(flow.unavailable, FLOW_UNAVAILABLE);
    assert.equal(flow.unavailable?.reason, 'no_source');
    assert.deepEqual([flow.total, flow.groups], [null, []], 'null, never a window of zeros');
    const tickets = m.tickets('all', '24h', {})!;
    assert.deepEqual([tickets.unavailable?.reason, tickets.total, tickets.rows], ['no_source', null, []]);
    const ov = (await m.overview('claudepilot', '24h'))!;
    assert.deepEqual([ov.flowUnavailable?.reason, ov.flow], ['no_source', null]);
    assert.ok(ov.open, 'the open-work read still works');
    // The score parts that read the closed tickets are unavailable (no_source), the open-work parts are measured.
    const parts = new Map(ov.effectiveness.components.map((c) => [c.id, c]));
    for (const id of ['closures', 'doneVsWontDo', 'flowTime']) assert.deepEqual([parts.get(id)?.value, parts.get(id)?.reason], [null, 'no_source'], id);
    assert.equal(typeof parts.get('notBlocked')?.value, 'number');

    // The REST responses carry the same nulls and reason (the routes read lab.metrics only).
    const rest = app({ metrics: m } as unknown as Lab);
    const json = async (url: string) => {
      const res = await rest.request(url);
      assert.equal(res.status, 200, url);
      return ((await res.json()) as { data: unknown }).data;
    };
    const fl = (await json('/api/lab/metrics/flow?groupBy=type')) as MetricsFlow;
    assert.deepEqual([fl.total, fl.groups, fl.unavailable?.reason], [null, [], 'no_source']);
    const ovr = (await json('/api/lab/metrics/overview?program=claudepilot')) as MetricsOverview;
    assert.deepEqual([ovr.flow, ovr.flowUnavailable?.reason], [null, 'no_source']);
    const tk = (await json('/api/lab/metrics/tickets')) as MetricsTickets;
    assert.deepEqual([tk.total, tk.rows, tk.unavailable?.reason], [null, [], 'no_source']);
    const ins = (await m.insights('claudepilot', '24h'))!;
    assert.deepEqual(ins.items.map((i) => [i.kind, i.text]), [['no_data', FLOW_UNAVAILABLE.text]]);
    assert.ok(logs.includes('metrics: closed tickets read failed (SqliteError)'), logs.join('\n'));
    assert.ok(logs.every((l) => !l.includes('must not be logged')));
    assert.ok((await m.snapshot()) > 0);
    const snap = JSON.parse((h.db.prepare(`SELECT metrics FROM lab_metric_snapshots WHERE program = 'all'`).get() as { metrics: string }).metrics) as Record<string, unknown>;
    assert.equal(snap.done24h, null, 'a gap in the trend, not a 0');
    assert.equal(snap.resolveP50, null);
    assert.equal(typeof snap.openWork, 'number');
    // A read that works carries no flag.
    assert.equal(h.lab.metrics.flow('all', '24h', null)!.unavailable, undefined);
    assert.equal((await h.lab.metrics.overview('all', '24h'))!.flowUnavailable, undefined);
  } finally {
    h.done();
  }
});

test('program tags: ranked by tickets touched in 30 days, then by all their tickets; at most 12 become programs', async () => {
  const h = await seeded();
  try {
    const old = 40 * 24;
    h.ticket(20, 'open', { createdAgo: 50, updatedAgo: 1, tags: ['program-a'] });
    h.ticket(21, 'open', { createdAgo: 50, updatedAgo: 2, tags: ['program-a'] });
    h.ticket(22, 'open', { createdAgo: old + 5, updatedAgo: 3, tags: ['program-b'] });
    h.ticket(23, 'done', { createdAgo: old + 5, closedAgo: old, tags: ['program-b'] });
    for (const n of [24, 25, 26]) h.ticket(n, 'done', { createdAgo: old + 5, closedAgo: old, tags: ['program-c'] });
    // program-kohi: T-8, one recent ticket; program-b also has one recent but two in all; program-c has three tickets, none touched in
    // 30 days: dormant, so no program (and no snapshot rows).
    assert.deepEqual(loadProgramTags(h.db, at(30 * 24)), ['program-a', 'program-b', 'program-kohi']);
    assert.deepEqual(loadProgramTags(h.db, at(50 * 24)), ['program-c', 'program-a', 'program-b', 'program-kohi'], 'in a longer span c counts, most recent tickets first');
    for (let i = 0; i < 14; i++) h.ticket(30 + i, 'open', { createdAgo: 5, updatedAgo: 1, tags: [`program-z${String(i).padStart(2, '0')}`] });
    const progs = h.lab.metrics.programs();
    const tagged = progs.filter((p) => p.source === 'program-tag').map((p) => p.id);
    // Ranked: a (2 recent), b (1 recent, 2 in all), then kohi and z00..z13 (1 recent, 1 in all) by name; the first 12, shown by id.
    // c (dormant) and z09..z13 (past the cap) are left out.
    assert.deepEqual(tagged, ['a', 'b', 'kohi', ...Array.from({ length: 9 }, (_, i) => `z0${i}`)]);
    assert.deepEqual(progs.filter((p) => p.source !== 'program-tag').map((p) => p.id), ['all', 'claudepilot', 'konfersi', 'memor-id'], 'the setting’s programs always stay');
    assert.equal(await h.lab.snapshotMetrics(), 1 + 2 + 12, 'all, the two ticket programs of the setting, 12 tag programs');
  } finally {
    h.done();
  }
});

test('snapshot: at most MAX_SNAPSHOT_PROGRAMS rows per run, all and the setting’s order first, whatever the setting holds', async () => {
  const setting = ['all=All|*', ...Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, '0')}=P|t${i}`)].join(';');
  const h = await seeded({ settings: { [METRICS_SETTING.programs]: setting } });
  try {
    const logs: string[] = [];
    const m = new Metrics({ store: h.store, now: () => NOW, settings: { get: (k: string) => (k === METRICS_SETTING.programs ? setting : undefined) }, paces: null, log: (s) => logs.push(s) });
    const listed = m.programs().length;
    assert.ok(listed > MAX_SNAPSHOT_PROGRAMS, `the list itself is not cut (${listed})`);
    assert.equal(MAX_SNAPSHOT_PROGRAMS, 32);
    assert.equal(await m.snapshot(), MAX_SNAPSHOT_PROGRAMS);
    const written = (h.db.prepare(`SELECT program FROM lab_metric_snapshots WHERE at_ms = ? ORDER BY id`).all(NOW) as { program: string }[]).map((r) => r.program);
    assert.deepEqual(written, ['all', ...Array.from({ length: 31 }, (_, i) => `p${String(i).padStart(2, '0')}`)]);
    assert.deepEqual(logs, [`metrics: snapshot keeps the first ${MAX_SNAPSHOT_PROGRAMS} of ${listed} programs`]);
  } finally {
    h.done();
  }
});

test('closed_at: both writers (close() and update to done or won’t-do) store toISOString(), the text form the window read compares against', async () => {
  const h = await seeded();
  try {
    let clock = at(2.5); // no seeded ticket closes at these instants
    const tickets = new Tickets(h.store, new FakeSessions(), { now: () => new Date(clock) });
    const viaClose = tickets.create(UI, { summary: 'Closed by close()' });
    const viaUpdate = tickets.create(UI, { summary: 'Closed by update' });
    const reopened = tickets.create(UI, { summary: 'Closed, then reopened' });
    const closeAt = clock;
    tickets.close(UI, viaClose.id, { summary: 'done' });
    clock = closeAt + 1;
    tickets.update(UI, viaUpdate.id, { status: 'wont_do' });
    clock = closeAt + 2;
    tickets.update(UI, reopened.id, { status: 'done' });
    clock = closeAt + 3;
    tickets.update(UI, reopened.id, { status: 'open' });
    const stored = (n: string) => (h.db.prepare(`SELECT closed_at FROM tickets WHERE number = ?`).get(Number(n.slice(2))) as { closed_at: string | null }).closed_at;
    assert.deepEqual([stored(viaClose.id), stored(viaUpdate.id), stored(reopened.id)], [iso(closeAt), iso(closeAt + 1), null], 'exactly toISOString() of the close; a reopen clears it');
    for (const id of [viaClose.id, viaUpdate.id]) assert.match(stored(id)!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The window [from, to) compares those strings: each bound at the same millisecond includes from and excludes to.
    const ids = (from: number, to: number) => loadFlowTickets(h.db, from, to, null).map((f) => f.id).sort();
    assert.deepEqual(ids(closeAt, closeAt + 2), [viaClose.id, viaUpdate.id].sort());
    assert.deepEqual(ids(closeAt, closeAt + 1), [viaClose.id]);
    assert.deepEqual(ids(closeAt + 1, closeAt + 4), [viaUpdate.id], 'the reopened ticket is out');
  } finally {
    h.done();
  }
});
