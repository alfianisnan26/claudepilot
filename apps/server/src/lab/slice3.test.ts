// Efficiency lab, slice 3: result tokens from the stream's usage, idle gaps and effort per slice, and stratum keys for randomized
// experiments (deterministic, balanced within one slice per stratum). Expected numbers carry their derivation from the tape (lab/testkit.ts).
// The reference script (slice_metrics.py) names result_tokens_est but does not compute it, so there is no script number to match here; the
// figures it does compute are unchanged (lab.test.ts).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LabSliceMetrics, LabStratumKey } from '@portal/contracts';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { assignSlice, blockOrder, createExperiment, stratumOf, type SliceAttrs } from './experiments.js';
import { Lab } from './index.js';
import { resultTokensOf } from './metrics.js';
import type { TicketFacts } from './outcomes.js';
import { registerLabTools } from './portalTools.js';
import { buildTape, T0, TAPE_SESSION } from './testkit.js';

const MARKER = ['MARKER', 'Y'].join('_');
const IMPL = 'toolu_lab_impl1';
const QA = 'toolu_lab_qa1';

async function harness(opts: { tickets?: (t: string) => TicketFacts | null; tape?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lab3-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const lab = new Lab({ store, now: () => T0 + 3_600_000, ...(opts.tickets ? { tickets: opts.tickets } : {}) });
  if (opts.tape !== false) for (const l of buildTape(MARKER)) lab.line(TAPE_SESSION, l);
  return { store, lab, db: store.db!, done: () => (lab.close(), store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

const slice = (list: LabSliceMetrics[], id: string) => list.find((m) => m.sliceId === id)!;

test('result tokens: the next request’s context growth less the previous output, laid on the previous request’s tool results', async () => {
  const h = await harness();
  try {
    const all = h.lab.slices();
    // Implementer, context = input + read + write: 30,003 / 32,002 / 33,502 / 34,002 / 34,802 / 34,802, outputs 100, 250, 50, 20, 10.
    // Growth: 32,002 - 30,003 - 100 = 1,899 (grep, inspect); 33,502 - 32,002 - 250 = 1,250 (rtk git status 15 chars, npm test 411 chars);
    // 34,002 - 33,502 - 50 = 450 (git log 333, Read 2,048); 34,802 - 34,002 - 20 = 780 (sleep, empty); 34,802 - 34,802 - 10 < 0: 0.
    const a = slice(all, IMPL);
    assert.equal(a.resultTokens, 1899 + 1250 + 450 + 780);
    // inspect 1,899 + 450 x 2,048/2,381 = 2,286.06; git_read 1,250 x 15/426 + 450 x 333/2,381 = 106.95; test 1,250 x 411/426 = 1,205.99.
    assert.deepEqual(a.resultTokensByClass, { inspect: 2286, git_read: 107, test: 1206, wait: 780 });
    // QA (sonnet): 12,902 - 12,002 - 30 = 870 (cat, inspect); 13,002 - 12,902 - 60 = 40 (kubectl, api). The synthetic message is no request.
    const b = slice(all, QA);
    assert.equal(b.resultTokens, 910);
    assert.deepEqual(b.resultTokensByClass, { inspect: 870, api: 40 });
    // The main turn: 53,902 - 53,002 - 300 = 600 on the two Agent results.
    const turn = slice(all, 'turn:1');
    assert.deepEqual([turn.resultTokens, turn.resultTokensByClass], [600, { agent: 600 }]);
  } finally {
    h.done();
  }
});

test('result tokens: growth after a request without a tool call is no result; unavailable (null) when no call can be linked', () => {
  const req = (message_id: string, cache_read: number, cache_write: number, output: number) => ({ message_id, at_ms: 1, model: 'm', input: 0, cache_read, cache_write_5m: cache_write, cache_write_1h: 0, cache_write, output });
  const L = [req('m1', 0, 1000, 10), req('m2', 1000, 500, 10), req('m3', 1500, 300, 10)];
  const tool = { tool: 'Bash', class: 'test', rtk: 0, results: 1, result_chars: 10 };
  assert.deepEqual(resultTokensOf(L, [{ ...tool, message_id: 'm2' }]), { total: 290, byClass: { test: 290 } }, 'm1 made no call: its 490 is not a result');
  assert.deepEqual(resultTokensOf(L, [{ ...tool, message_id: null }]), { total: null, byClass: {} }, 'rows from before migration 853');
  assert.deepEqual(resultTokensOf(L, []), { total: 0, byClass: {} }, 'no result at all: 0');
});

test('idle gaps and effort per slice', async () => {
  const h = await harness();
  try {
    const all = h.lab.slices();
    // Implementer requests at 2, 61, 125, 1,925, 1,925, 1,987 s: one gap over 5 minutes, 1,800 s.
    assert.deepEqual([slice(all, IMPL).idleMinutes, slice(all, IMPL).maxGapMinutes], [30, 30]);
    // QA requests at 0, 5, 15 s: no idle time, the longest gap 10 s = 0.17 minutes, one decimal 0.2.
    assert.deepEqual([slice(all, QA).idleMinutes, slice(all, QA).maxGapMinutes], [0, 0.2]);
    assert.equal(slice(all, IMPL).effort, null, 'the tape’s Agent calls name no effort');
    const agent = (id: string, effort: unknown) =>
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, timestamp: new Date(T0 + 5000).toISOString(), message: { id: `msg_${id}`, model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'implementer', effort, prompt: `T-287 ${MARKER}` } }] } });
    const sub = (par: string) => JSON.stringify({ type: 'assistant', parent_tool_use_id: par, timestamp: new Date(T0 + 6000).toISOString(), message: { id: `msg_in_${par}`, model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content: [] } });
    for (const l of [agent('toolu_eff_1', 'high'), agent('toolu_eff_2', `bad value ${MARKER}`), sub('toolu_eff_1'), sub('toolu_eff_2')]) h.lab.line('s-eff', l);
    const eff = h.lab.slices({ sessionId: 's-eff', kind: 'agent' });
    assert.deepEqual(eff.map((m) => [m.sliceId, m.effort]), [['toolu_eff_1', 'high'], ['toolu_eff_2', null]], 'a value that is not a plain name is not kept');
    const stored = JSON.stringify(h.db.prepare('SELECT * FROM lab_slices').all()) + JSON.stringify(h.db.prepare('SELECT * FROM lab_tools').all());
    assert.ok(!stored.includes(MARKER), 'no text of the stream in any row');
  } finally {
    h.done();
  }
});

test('a frozen slice from before slice 3 shows result tokens and gaps as unavailable, never 0', async () => {
  const h = await harness();
  try {
    const a = slice(h.lab.slices(), IMPL);
    const old: Record<string, unknown> = { ...a };
    for (const k of ['resultTokens', 'resultTokensByClass', 'idleMinutes', 'maxGapMinutes', 'effort']) delete old[k];
    h.db.prepare('UPDATE lab_slices SET frozen = ?, frozen_ms = 1 WHERE session_id = ? AND slice_id = ?').run(JSON.stringify(old), TAPE_SESSION, IMPL);
    const f = slice(h.lab.slices(), IMPL);
    assert.deepEqual([f.resultTokens, f.resultTokensByClass, f.idleMinutes, f.maxGapMinutes, f.effort], [null, {}, null, null, null]);
    assert.equal(f.resultChars, a.resultChars);
    // Retention after slice 3 freezes the new figures with the rest.
    h.db.prepare('UPDATE lab_slices SET frozen = NULL, frozen_ms = NULL').run();
    const r = new Lab({ store: h.store, now: () => T0 + 30 * 86_400_000 }).prune()!;
    assert.ok(r.frozen >= 3);
    assert.deepEqual(slice(h.lab.slices(), IMPL), a);
  } finally {
    h.done();
  }
});

test('stratum keys: the stratum is built from the keys in order; a missing value is its own level', () => {
  const at: SliceAttrs = { size: 'M', role: 'implementer', model: null, effort: 'high' };
  assert.equal(stratumOf(['size', 'role'], at), 'size=M|role=implementer');
  assert.equal(stratumOf(['effort', 'model'], at), 'effort=high|model=-');
});

test('stratified assignment by ESTIMATE size: balanced within one slice per stratum and the same draw on a replay', async () => {
  const sizes: [string, number][] = [['S', 7], ['M', 4], ['L', 1], ['XL', 6]];
  const run = async (id: string) => {
    const h = await harness({ tape: false });
    try {
      const e = createExperiment(h.db, { name: 'rtk', design: 'randomized', arms: ['on', 'off'], primaryMetric: 'p', startMs: T0, strata: ['size', 'role'] }, T0);
      // A fixed id and seed (migration 854: new experiments get a random secret seed) so two runs can be compared.
      h.db.prepare('UPDATE lab_experiments SET id = ?, seed = ? WHERE id = ?').run(id, id, e.id);
      const out: string[] = [];
      // Interleaved starts, as slices arrive: S, M, L, XL, S, M, ...
      for (let i = 0; i < 7; i++) {
        for (const [size, n] of sizes) {
          if (i >= n) continue;
          const attrs: SliceAttrs = { size, role: 'implementer', model: null, effort: null };
          out.push(`${size}:${assignSlice(h.db, { sessionId: 's', sliceId: `${size}-${i}`, attrs, atMs: T0 + i }).get(id)}`);
        }
      }
      const rows = h.db.prepare('SELECT stratum, arm, COUNT(*) AS n FROM lab_assignments GROUP BY stratum, arm').all() as { stratum: string; arm: string; n: number }[];
      return { out, rows };
    } finally {
      h.done();
    }
  };
  const id = 'exp-fixed-1';
  const first = await run(id);
  const again = await run(id);
  assert.deepEqual(again.out, first.out, 'the same slices in the same order get the same arms');
  for (const [size, n] of sizes) {
    const stratum = `size=${size}|role=implementer`;
    const on = first.rows.find((r) => r.stratum === stratum && r.arm === 'on')?.n ?? 0;
    const off = first.rows.find((r) => r.stratum === stratum && r.arm === 'off')?.n ?? 0;
    assert.equal(on + off, n);
    assert.ok(Math.abs(on - off) <= 1, `${stratum}: ${on} on, ${off} off`);
    // Recomputed from the rule: slice k of the stratum gets blockOrder(id, stratum, floor(k / 2))[k mod 2].
    const arms = first.out.filter((x) => x.startsWith(`${size}:`)).map((x) => x.slice(size.length + 1));
    assert.deepEqual(arms, arms.map((_, k) => blockOrder(id, stratum, Math.floor(k / 2), ['on', 'off'])[k % 2]));
  }
});

test('the ingest stratifies by the ticket’s ESTIMATE size when the experiment names it; slice 1 experiments keep role and model', async () => {
  const tickets = (t: string): TicketFacts | null => (t === 'T-287' ? { changes: [], estimateSize: 'M' } : null);
  const h = await harness({ tickets, tape: false });
  try {
    const sized = h.lab.createExperiment({ name: 'sized', design: 'randomized', arms: ['on', 'off'], primaryMetric: 'p', startMs: T0 - 1, strata: ['size', 'role', 'effort'] });
    const plain = h.lab.createExperiment({ name: 'plain', design: 'randomized', arms: ['on', 'off'], primaryMetric: 'p', startMs: T0 - 1 });
    assert.deepEqual([sized.strata, plain.strata], [['size', 'role', 'effort'], null]);
    for (const l of buildTape(MARKER)) h.lab.line(TAPE_SESSION, l);
    const strata = (id: string) => (h.db.prepare('SELECT stratum FROM lab_assignments WHERE experiment_id = ? ORDER BY stratum').all(id) as { stratum: string }[]).map((r) => r.stratum);
    assert.deepEqual(strata(sized.id), ['size=-|role=qa|effort=-', 'size=M|role=implementer|effort=-']);
    assert.deepEqual(strata(plain.id), ['implementer|inherit', 'qa|sonnet']);
  } finally {
    h.done();
  }
});

test('stratum keys are checked: randomized only, known keys, not empty', async () => {
  const h = await harness({ tape: false });
  try {
    const base = { name: 'x', arms: ['a', 'b'], primaryMetric: 'p', startMs: T0 };
    assert.throws(() => h.lab.createExperiment({ ...base, design: 'before_after', switchMs: T0 + 1, strata: ['size'] }), /randomized/);
    assert.throws(() => h.lab.createExperiment({ ...base, design: 'randomized', strata: ['colour' as LabStratumKey] }), /stratum keys/);
    assert.throws(() => h.lab.createExperiment({ ...base, design: 'randomized', strata: [] }), /stratum keys/);
    assert.equal(h.lab.experiments().length, 0);
  } finally {
    h.done();
  }
});

type Row = { result?: { isError?: boolean; structuredContent?: any }; error?: unknown };
const where = (m: Row) => m.result?.structuredContent as any;
const refused = (m: Row) => !!(m.error || m.result?.isError);

test('MCP: lab_experiment_set takes stratum keys (admin, confirmation); an unknown key is refused; lab_summary shows result tokens', async () => {
  const h = await harness();
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  registerLabTools(h.lab, registry);
  try {
    const admin = mcp.token('admin');
    const args = { action: 'start', name: 'sized', design: 'randomized', arms: ['on', 'off'], strata: ['size', 'role'] };
    assert.ok(refused(await mcp.call(admin.secret, 'lab_experiment_set', { ...args, strata: ['colour'] })));
    const agent = await mcp.agentToken('docker/api', 'P');
    assert.ok(refused(await mcp.call(agent.secret, 'lab_experiment_set', args)));
    const ask = where(await mcp.call(admin.secret, 'lab_experiment_set', args));
    assert.deepEqual([ask.status, ask.preview.strata], ['confirmation_required', ['size', 'role']]);
    assert.equal(h.lab.experiments().length, 0, 'nothing before the confirmation');
    const made = where(await mcp.call(admin.secret, 'lab_experiment_set', { ...args, confirm_token: ask.confirm_token }));
    assert.equal(made.did, 'started');
    assert.deepEqual(h.lab.experiments()[0]!.strata, ['size', 'role']);
    const full = where(await mcp.call(admin.secret, 'lab_summary', { since: String(T0 - 1), full: true }));
    assert.deepEqual(full.experiments[0].strata, ['size', 'role']);
    assert.ok(full.basis.resultTokens);
    const short = where(await mcp.call(admin.secret, 'lab_summary', { since: String(T0 - 1) }));
    const impl = short.rows.find((r: { role: string }) => r.role === 'implementer');
    assert.equal(impl.result_tok_p50, 4379);
  } finally {
    mcp.done();
    h.done();
  }
});
