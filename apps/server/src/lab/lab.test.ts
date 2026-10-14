import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LabSliceMetrics } from '@portal/contracts';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { bashClass } from './classify.js';
import { assignSlice, blockOrder, createExperiment } from './experiments.js';
import { Lab } from './index.js';
import { inputPricePerToken } from './prices.js';
import { buildTape, T0, TAPE_SESSION } from './testkit.js';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/dev-sessions/overhaul/evidence/slice_metrics.py');
/** Built at runtime; its length is part of the recorded numbers below (it sits in result text). */
const MARKER = ['MARKER', 'X'].join('_');

/**
 * What docs/dev-sessions/overhaul/evidence/slice_metrics.py printed for this tape (buildTape(MARKER)), run 2026-10-14 with Python 3.11.2:
 * `env -i PATH=/usr/bin:/bin HOME=<tmp>/home python3 -I slice_metrics.py` over `<tmp>/home/.claudepilot/sessions/<TAPE_SESSION>/out.0.jsonl`.
 * The live comparison below runs the script again when python3 is there.
 */
const RECORDED = [
  { session: 'a1b2c3d4', ticket: 'T-287', model: 'claude-opus-5-5', requests: 6, ctx_p50: 33750, ctx_p90: 34800, read: 13580.0, write: 80250.0, out: 4150.0, result_chars: 4132, results: 8, rewrite_tokens: 28500, bash_calls: 6, rtk_calls: 2, inspect_calls: 1, t0: '2026-10-14T05:00:02+00:00', minutes: 33.1 },
  { session: 'a1b2c3d4', ticket: null, model: 'claude-sonnet-5-5', requests: 3, ctx_p50: 12900, ctx_p90: 13000, read: 2490.0, write: 26000.0, out: 2950.0, result_chars: 323, results: 2, rewrite_tokens: 0, bash_calls: 2, rtk_calls: 0, inspect_calls: 1, t0: '2026-10-14T05:00:04+00:00', minutes: 0.2 },
];
type ScriptRow = (typeof RECORDED)[number];

async function harness(now = () => T0 + 3_600_000) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lab-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const lab = new Lab({ store, now });
  return { store, lab, db: store.db!, done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

/** The lab's slice in the script's shape (the script keys the session by its first 8 characters and gives t0 in Python's isoformat). */
function asScript(m: LabSliceMetrics): ScriptRow {
  return {
    session: m.sessionId.slice(0, 8),
    ticket: m.ticket as string,
    model: m.model!,
    requests: m.requests,
    ctx_p50: m.ctxP50,
    ctx_p90: m.ctxP90,
    read: m.units.read,
    write: m.units.write,
    out: m.units.out,
    result_chars: m.resultChars,
    results: m.results,
    rewrite_tokens: m.rewriteTokens,
    bash_calls: m.bashCalls,
    rtk_calls: m.rtkCalls,
    inspect_calls: m.inspectCalls,
    t0: new Date(m.startMs!).toISOString().replace(/\.000Z$/, '+00:00'),
    minutes: m.minutes,
  };
}

const byT0 = (a: { t0: string }, b: { t0: string }) => a.t0.localeCompare(b.t0);

test('migrations 850 to 855: the lab tables, in the block T-287 was given (850 to 855; 854 and 855 are T-292 slice 3’s draws)', async () => {
  const lab = MIGRATIONS.filter((m) => m.name.startsWith('efficiency lab'));
  assert.deepEqual(lab.map((m) => m.version), [850, 851, 852, 853, 854, 855]);
  const h = await harness();
  try {
    const tables = (h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lab_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(tables, ['lab_assignments', 'lab_draws', 'lab_experiments', 'lab_requests', 'lab_slices', 'lab_tools']);
  } finally {
    h.done();
  }
});

test('the ingest gives the reference script’s numbers on the same tape (recorded run)', async () => {
  const h = await harness();
  try {
    for (const l of buildTape(MARKER)) h.lab.line(TAPE_SESSION, l);
    const got = h.lab.slices({ kind: 'agent' }).map(asScript).sort(byT0);
    assert.deepEqual(got, [...RECORDED].sort(byT0));
  } finally {
    h.done();
  }
});

test('the ingest gives the reference script’s numbers on the same tape (live run of slice_metrics.py)', async (t) => {
  const py = spawnSync('python3', ['--version']);
  if (py.status !== 0 || !existsSync(SCRIPT)) return t.skip('python3 or the script is not here; the recorded run above still holds');
  const tmp = mkdtempSync(join(tmpdir(), 'lab-tape-'));
  const h = await harness();
  try {
    const lines = buildTape(MARKER);
    const dir = join(tmp, '.claudepilot', 'sessions', TAPE_SESSION);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'out.0.jsonl'), lines.join('\n') + '\n');
    const run = spawnSync('python3', ['-I', SCRIPT], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const script = run.stdout.trim().split('\n').map((l) => JSON.parse(l) as ScriptRow).sort(byT0);
    for (const l of lines) h.lab.line(TAPE_SESSION, l);
    assert.deepEqual(h.lab.slices({ kind: 'agent' }).map(asScript).sort(byT0), script);
  } finally {
    h.done();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a replayed tape changes nothing; the main thread is measured per turn', async () => {
  const h = await harness();
  try {
    const lines = buildTape(MARKER);
    for (const l of lines) h.lab.line(TAPE_SESSION, l);
    const once = h.lab.slices();
    for (const l of lines) h.lab.line(TAPE_SESSION, l.replace(/"type":"result"/, '"type":"resultx"')); // a reconnect re-reads, the turn already ended
    assert.deepEqual(h.lab.slices(), once);
    const turn = once.find((m) => m.kind === 'turn')!;
    assert.equal(turn.sliceId, 'turn:1');
    assert.equal(turn.requests, 2);
    assert.deepEqual(turn.toolCalls, { agent: 2, git_read: 1 });
    const a = once.find((m) => m.ticket === 'T-287')!;
    assert.equal(a.role, 'implementer');
    assert.deepEqual(a.toolCalls, { inspect: 2, git_read: 2, test: 2, wait: 1 });
    assert.equal(a.cacheWrite1h, 1500);
    assert.equal(a.output, 830);
    // Cost: units x the model's input price (opus 5.5: 4 dollars per million input tokens), the cache read at Opus 5.5's own weight 0.05
    // (slice 2; units.read stays at the script's 0.1).
    assert.equal(a.costUsd, (a.units.input + 0.05 * a.cacheRead + a.units.write + a.units.out) * 4e-6);
    const b = once.find((m) => m.role === 'qa')!;
    assert.deepEqual(b.toolCalls, { inspect: 1, api: 1 });
    // The next main-thread request after the turn's result is the next turn.
    h.lab.line(TAPE_SESSION, JSON.stringify({ type: 'assistant', message: { id: 'msg_main_3', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1 } }, parent_tool_use_id: null }));
    assert.deepEqual(h.lab.slices({ kind: 'turn' }).map((m) => m.sliceId), ['turn:1', 'turn:2']);
  } finally {
    h.done();
  }
});

test('no text of the stream is stored: only counts, classes and ids', async () => {
  const h = await harness();
  try {
    for (const l of buildTape(MARKER)) h.lab.line(TAPE_SESSION, l);
    // A line whose ids are not ids is not kept at all.
    h.lab.line(TAPE_SESSION, JSON.stringify({ type: 'assistant', message: { id: `msg ${MARKER} with spaces`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `${MARKER} x`, name: 'Bash', input: { command: 'ls' } }], usage: {} }, parent_tool_use_id: null }));
    for (const table of ['lab_slices', 'lab_requests', 'lab_tools']) {
      const rows = h.db.prepare(`SELECT * FROM ${table}`).all();
      assert.ok(rows.length > 0, table);
      assert.ok(!JSON.stringify(rows).includes(MARKER), `${table} holds no text`);
    }
  } finally {
    h.done();
  }
});

test('Bash classes: inspection is exactly the script’s rule; the rest by the command’s first word', () => {
  assert.equal(bashClass('grep -n x f'), 'inspect');
  assert.equal(bashClass('cat > f <<EOF'), 'inspect'); // the script's regex, kept for the baseline
  assert.equal(bashClass('cd /w && git diff --stat'), 'git_read');
  assert.equal(bashClass('git -c commit.gpgsign=false commit -m x'), 'git_write');
  assert.equal(bashClass('scripts/quiet.sh -n 25 -- npm test'), 'test');
  assert.equal(bashClass('until curl -s x; do sleep 20; done'), 'wait');
  assert.equal(bashClass('kubectl get pods'), 'api');
  assert.equal(bashClass("sed -i 's/a/b/' f"), 'edit');
  assert.equal(bashClass('FOO=1 rtk git log'), 'git_read');
  assert.equal(bashClass('make-believe'), 'other');
});

test('prices: by model id, the longest prefix; an unknown model has no price', () => {
  assert.equal(inputPricePerToken('claude-opus-5-5'), 4e-6);
  assert.equal(inputPricePerToken('claude-opus-5-5[1m]'), 4e-6);
  assert.equal(inputPricePerToken('claude-opus-5'), 5e-6);
  assert.equal(inputPricePerToken('claude-sonnet-5-5'), 2e-6);
  assert.equal(inputPricePerToken('some-other-model'), null);
});

test('a randomized experiment: arms balanced within one slice per stratum, the same slice keeps its arm, the draw is reproducible', async () => {
  const h = await harness();
  try {
    const e = createExperiment(h.db, { name: 'rtk', design: 'randomized', arms: ['on', 'off'], primaryMetric: 'cost per accepted slice', startMs: T0, minN: 20 }, T0);
    const counts = new Map<string, number>();
    for (const [stratum, n] of [['implementer|inherit', 7], ['qa|sonnet', 4], ['coordinator|opus', 1]] as const) {
      for (let i = 0; i < n; i++) {
        const arm = assignSlice(h.db, { sessionId: 's1', sliceId: `${stratum}-${i}`, stratum, atMs: T0 + i }).get(e.id)!;
        counts.set(`${stratum}/${arm}`, (counts.get(`${stratum}/${arm}`) ?? 0) + 1);
      }
      const on = counts.get(`${stratum}/on`) ?? 0;
      const off = counts.get(`${stratum}/off`) ?? 0;
      assert.equal(on + off, n);
      assert.ok(Math.abs(on - off) <= 1, `${stratum}: ${on} on, ${off} off`);
    }
    const again = assignSlice(h.db, { sessionId: 's1', sliceId: 'implementer|inherit-3', stratum: 'implementer|inherit', atMs: T0 + 99 }).get(e.id);
    const stored = (h.db.prepare("SELECT arm FROM lab_assignments WHERE slice_id = 'implementer|inherit-3'").get() as { arm: string }).arm;
    assert.equal(again, stored);
    assert.deepEqual(blockOrder(e.id, 'x', 3, ['a', 'b', 'c']), blockOrder(e.id, 'x', 3, ['a', 'b', 'c']));
    // Before its start nothing is assigned; once stopped, nothing more.
    assert.equal(assignSlice(h.db, { sessionId: 's1', sliceId: 'early', stratum: 'x', atMs: T0 - 1 }).size, 0);
    h.lab.stop(e.id);
    assert.equal(assignSlice(h.db, { sessionId: 's1', sliceId: 'late', stratum: 'x', atMs: T0 + 5 }).size, 0);
  } finally {
    h.done();
  }
});

test('the ingest assigns arms when a sub-agent starts, and the report is a query over those slices', async () => {
  const h = await harness();
  try {
    const e = h.lab.createExperiment({ name: 'rtk', design: 'randomized', arms: ['on', 'off'], primaryMetric: 'cost per accepted slice', startMs: T0 - 1 });
    for (const l of buildTape(MARKER)) h.lab.line(TAPE_SESSION, l);
    const strata = (h.db.prepare('SELECT stratum FROM lab_assignments ORDER BY stratum').all() as { stratum: string }[]).map((r) => r.stratum);
    assert.deepEqual(strata, ['implementer|inherit', 'qa|sonnet']);
    const r = h.lab.report(e.id)!;
    assert.equal(r.arms.reduce((s, a) => s + a.n, 0), 2);
    assert.equal(r.excluded, 0);
  } finally {
    h.done();
  }
});

test('before and after: slices split at the change; an excluded (outage) slice is in no arm', async () => {
  const h = await harness();
  try {
    for (const l of buildTape(MARKER)) h.lab.line(TAPE_SESSION, l);
    const e = h.lab.createExperiment({ name: '1h cache', design: 'before_after', primaryMetric: 'rewrite share', startMs: T0, switchMs: T0 + 3000 });
    let r = h.lab.report(e.id)!;
    assert.deepEqual(r.arms.map((a) => [a.arm, a.n]), [['before', 1], ['after', 1]]);
    assert.equal(r.arms[0]!.rewriteShare, 28500 / (2000 + 29000 + 800 + 30000 + 1500));
    assert.equal(r.arms[1]!.rtkShare, 0);
    assert.equal(r.arms[0]!.rtkShare, 2 / 6);
    const qa = h.lab.slices({ kind: 'agent' }).find((m) => m.role === 'qa')!;
    h.lab.exclude(e.id, qa.sessionId, qa.sliceId, 'outage');
    r = h.lab.report(e.id)!;
    assert.deepEqual(r.arms.map((a) => [a.arm, a.n]), [['before', 1], ['after', 0]]);
    assert.equal(r.excluded, 1);
    assert.equal(r.arms[1]!.medians.requests, null);
    h.lab.decide(e.id, 'adopt', 'rewrites fell');
    assert.equal(h.lab.experiments()[0]!.status, 'decided');
  } finally {
    h.done();
  }
});
