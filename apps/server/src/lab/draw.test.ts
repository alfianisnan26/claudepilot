// Efficiency lab, T-292 slice 3: draws. The arm of a slice whose treatment is the brief itself (E2, pack on or off) is drawn before the brief
// is written (`lab_arm_draw`) and bound when the top-level Agent call that carries `Lab-Draw: <key>` on its first line starts in the same
// session, for the same ticket, role, model and effort. The brief head comes from scripts/plan-step.mjs, the experiment from its E2 spec, so
// the script and the lab are checked together. Negative twins: the review's probes A (a draw taken by another role) and B (a redraw hidden
// behind a throwaway call), a nested call, another session, a reused key. No clock is read.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { declaredToolPolicies } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { LAB_TOOL_POLICIES } from './authz.js';
import { assignSlice, blockOrder, bindDraw, drawArms, DRAW_SLICE } from './experiments.js';
import { Lab } from './index.js';
import { registerLabTools } from './portalTools.js';
import { KEEP_REQUESTS_MS } from './retention.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plan: any = await import(fileURLToPath(new URL('../../../../scripts/plan-step.mjs', import.meta.url)));
const T0 = Date.UTC(2030, 0, 2, 9, 0, 0);
const SIZES: Record<string, string> = { 'T-1': 'M', 'T-2': 'M', 'T-3': 'L' };

async function harness(nowMs = T0 + 60_000) {
  const dataDir = mkdtempSync(join(tmpdir(), 'labdraw-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  let now = nowMs;
  const lab = new Lab({ store, now: () => now, tickets: (t) => (SIZES[t] ? { changes: [], estimateSize: SIZES[t]! } : null) });
  const e2 = lab.createExperiment({ name: plan.E2.name, hypothesis: plan.E2.hypothesis, design: plan.E2.design, arms: [...plan.E2.arms], strata: [...plan.E2.strata], primaryMetric: plan.E2.primary_metric, minN: plan.E2.min_n, thresholds: { ...plan.E2.thresholds }, startMs: T0 });
  return { store, lab, db: store.db!, e2, setNow: (ms: number) => (now = ms), done: () => (lab.close(), store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}
type H = Awaited<ReturnType<typeof harness>>;

/** The orchestrator's Agent call, as the stream line the lab reads; `parent` makes it a call from inside a sub-agent. */
const agentCall = (toolUseId: string, prompt: string, o: { role?: string; model?: string | null; parent?: string; at?: number } = {}) =>
  JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: o.parent ?? null,
    timestamp: new Date(o.at ?? T0 + 120_000).toISOString(),
    message: { id: `msg_${toolUseId}`, model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type: o.role ?? 'implementer', ...(o.model === null ? {} : { model: o.model ?? 'opus' }), prompt } }] },
  });

const row = (h: H, session: string, slice: string) => {
  const r = h.db.prepare('SELECT arm, stratum, excluded FROM lab_assignments WHERE experiment_id = ? AND session_id = ? AND slice_id = ?').get(h.e2.id, session, slice) as { arm: string | null; stratum: string; excluded: string | null } | undefined;
  return r ? { arm: r.arm, stratum: r.stratum, excluded: r.excluded } : null;
};
const statusOf = (h: H, draw: string) => (h.db.prepare('SELECT status FROM lab_draws WHERE draw = ?').get(draw) as { status: string } | undefined)?.status;
const forT1 = { sessionId: 'orch', ticket: 'T-1', role: 'implementer', model: 'opus', effort: null };

test('a draw made before the brief is the arm the slice keeps; the stratum is the ticket’s ESTIMATE size', async () => {
  const h = await harness();
  try {
    const d = h.lab.drawArms(forT1);
    assert.match(d.draw, plan.DRAW);
    assert.equal(d.arms.length, 1);
    const drawn = d.arms[0]!;
    assert.deepEqual([drawn.experiment, drawn.name], [h.e2.id, 'E2-context-compiler']);
    assert.equal(row(h, 'orch', DRAW_SLICE + d.draw)?.stratum, 'size=M|role=implementer|model=opus');
    assert.deepEqual(h.lab.drawStats(h.e2.id), [{ session: 'orch', unbound: 1, redraw: 0 }]);

    const head = plan.briefHead({ ticket: 'T-1', size: 'M', arm: drawn.arm, draw: d.draw, manifestBlock: drawn.arm === 'treatment' ? 'manifest' : null });
    // Without the bind this slice would be excluded (its brief names a draw it did not get): checked by removing bindDraw.
    h.lab.line('orch', agentCall('toolu_draw_1', head + '\nThe rest of the brief.'));
    assert.deepEqual(row(h, 'orch', 'toolu_draw_1'), { arm: drawn.arm, stratum: 'size=M|role=implementer|model=opus', excluded: null });
    assert.equal(row(h, 'orch', DRAW_SLICE + d.draw), null, 'the draw row moved to the slice');
    assert.equal(statusOf(h, d.draw), 'bound');
    assert.deepEqual(h.lab.drawStats(h.e2.id), []);

    // A replayed line changes nothing.
    h.lab.line('orch', agentCall('toolu_draw_1', head));
    assert.deepEqual(row(h, 'orch', 'toolu_draw_1')?.arm, drawn.arm);
    // The same key in a second Agent call binds nothing, and that slice is kept out: its brief was written for an arm it was not given.
    h.lab.line('orch', agentCall('toolu_draw_2', head));
    assert.deepEqual(row(h, 'orch', 'toolu_draw_2'), { arm: null, stratum: '', excluded: 'draw not bound' });
  } finally {
    h.done();
  }
});

test('probe A: a draw made for one role cannot be taken by a call of another role; the draw stays unbound and the call is excluded', async () => {
  const h = await harness();
  try {
    const d = h.lab.drawArms({ ...forT1, role: 'perf-tester' });
    h.lab.line('orch', agentCall('toolu_a', `Ticket T-1, size M. Lab-Draw: ${d.draw}`, { role: 'implementer' }));
    assert.equal(statusOf(h, d.draw), 'refused');
    assert.ok(row(h, 'orch', DRAW_SLICE + d.draw)?.arm, 'still held under the draw');
    assert.deepEqual(row(h, 'orch', 'toolu_a'), { arm: null, stratum: '', excluded: 'draw not bound' });
    assert.deepEqual(h.lab.drawStats(h.e2.id), [{ session: 'orch', unbound: 1, redraw: 0 }]);
    // Ticket and effort are checked too.
    const t = h.lab.drawArms(forT1);
    assert.equal(bindDraw(h.db, { sessionId: 'orch', draw: t.draw, sliceId: 'x', for: { ticket: 'T-2', role: 'implementer', model: 'opus', effort: null }, atMs: T0 }), 'refused');
    assert.equal(bindDraw(h.db, { sessionId: 'orch', draw: t.draw, sliceId: 'x', for: { ticket: 'T-1', role: 'implementer', model: 'opus', effort: 'high' }, atMs: T0 }), 'refused');
    // A refused draw still binds to the call it was drawn for.
    assert.equal(bindDraw(h.db, { sessionId: 'orch', draw: t.draw, sliceId: 'x', for: { ticket: 'T-1', role: 'implementer', model: 'opus', effort: null }, atMs: T0 }), 'bound');
  } finally {
    h.done();
  }
});

test('the honest mismatch: drawn for opus, dispatched with the model left out; refused, counted, the slice out of the experiment', async () => {
  const h = await harness();
  try {
    const d = h.lab.drawArms(forT1);
    h.lab.line('orch', agentCall('toolu_h', `Ticket T-1, size M. Lab-Draw: ${d.draw}`, { model: null }));
    assert.equal(statusOf(h, d.draw), 'refused');
    assert.equal(row(h, 'orch', 'toolu_h')?.excluded, 'draw not bound');
    const report = h.lab.report(h.e2.id)!;
    assert.deepEqual(report.arms.map((a) => a.n), [0, 0], 'the slice is in no arm');
    assert.equal(report.excluded, 1);
  } finally {
    h.done();
  }
});

test('probe B: a redraw bound to a throwaway call of another role does not hide it: unbound, counted as a redraw, the throwaway excluded', async () => {
  const h = await harness();
  try {
    const first = h.lab.drawArms(forT1);
    const second = h.lab.drawArms(forT1);
    h.lab.line('orch', agentCall('toolu_real', `Ticket T-1, size M. Lab-Draw: ${second.draw}`));
    h.lab.line('orch', agentCall('toolu_throwaway', `Ticket T-1, size M. Lab-Draw: ${first.draw}`, { role: 'explorer', model: 'haiku' }));
    assert.equal(statusOf(h, first.draw), 'refused');
    assert.deepEqual(h.lab.drawStats(h.e2.id), [{ session: 'orch', unbound: 1, redraw: 1 }]);
    assert.equal(row(h, 'orch', 'toolu_throwaway')?.excluded, 'draw not bound');
    assert.equal(row(h, 'orch', 'toolu_real')?.arm, second.arms[0]!.arm, 'the bound slice keeps its drawn arm');
    // Two draws for different tickets (two slices dispatched together) are no redraw.
    h.lab.drawArms({ ...forT1, ticket: 'T-2' });
    assert.deepEqual(h.lab.drawStats(h.e2.id), [{ session: 'orch', unbound: 2, redraw: 1 }]);
  } finally {
    h.done();
  }
});

test('a draw binds only in its session, from a top-level call, on the prompt’s first line', async () => {
  const h = await harness();
  try {
    const d = h.lab.drawArms({ ...forT1, ticket: 'T-3' });
    h.lab.line('someone-else', agentCall('toolu_other', `Ticket T-3, size L. Lab-Draw: ${d.draw}`));
    assert.equal(row(h, 'someone-else', 'toolu_other')?.excluded, 'draw not bound', 'another session’s call carrying the key is kept out');
    assert.equal(statusOf(h, d.draw), 'open', 'the draw is untouched');
    // A call made inside a sub-agent (nested) is never read for a draw: it is assigned as any slice, the draw stays open.
    h.lab.line('orch', agentCall('toolu_nested', `Ticket T-3, size L. Lab-Draw: ${d.draw}`, { parent: 'toolu_parent' }));
    assert.equal(statusOf(h, d.draw), 'open');
    assert.ok(row(h, 'orch', 'toolu_nested')?.arm, 'assigned as usual');
    // The key on a later line of the prompt is not read.
    h.lab.line('orch', agentCall('toolu_line2', `Ticket T-3, size L.\nLab-Draw: ${d.draw}`));
    assert.equal(statusOf(h, d.draw), 'open');
    assert.equal(row(h, 'orch', 'toolu_line2')?.excluded, null);
    // No running experiment: a draw has no arm and the brief is the ordinary one.
    h.lab.stop(h.e2.id);
    assert.deepEqual(h.lab.drawArms({ ...forT1, ticket: 'T-2' }).arms, []);
  } finally {
    h.done();
  }
});

test('draws share the blocks with ordinary slices, balanced; the block order is seeded by the experiment’s secret seed, not its id', async () => {
  const run = async () => {
    const h = await harness();
    try {
      const seed = (h.db.prepare('SELECT seed FROM lab_experiments WHERE id = ?').get(h.e2.id) as { seed: string }).seed;
      assert.match(seed, /^[0-9a-f]{32}$/);
      assert.ok(!JSON.stringify(h.lab.experiments()).includes(seed), 'the seed is never shown');
      h.db.prepare('UPDATE lab_experiments SET id = ?, seed = ? WHERE id = ?').run('exp-e2-fixed', 'seed-fixed', h.e2.id);
      const out: string[] = [];
      for (let i = 0; i < 6; i++) {
        const f = { ticket: `T-${100 + i}`, role: 'implementer', model: 'opus', effort: null };
        const attrs = { size: 'M', role: 'implementer', model: 'opus', effort: null };
        // Alternate a draw and an ordinary start in the same stratum.
        const got = i % 2 ? assignSlice(h.db, { sessionId: 'orch', sliceId: `plain-${i}`, attrs, atMs: T0 + i }) : drawArms(h.db, { sessionId: 'orch', draw: `d-00000000000${i}`, for: f, size: 'M', atMs: T0 + i });
        out.push(got.get('exp-e2-fixed')!);
      }
      return out;
    } finally {
      h.done();
    }
  };
  const a = await run();
  assert.deepEqual(a, await run(), 'deterministic for a given seed');
  const stratum = 'size=M|role=implementer|model=opus';
  assert.deepEqual(a, a.map((_, k) => blockOrder('seed-fixed', stratum, Math.floor(k / 2), plan.ARMS)[k % 2]), 'the seed, not the id, orders the block');
  for (let b = 0; b < 3; b++) assert.deepEqual([a[2 * b], a[2 * b + 1]].sort(), ['control', 'treatment'], `block ${b}`);
});

test('retention drops unbound draws older than the horizon; a bound draw and a recent one stay', async () => {
  const h = await harness();
  try {
    const old = h.lab.drawArms(forT1);
    const used = h.lab.drawArms({ ...forT1, ticket: 'T-2' });
    h.lab.line('orch', agentCall('toolu_used', `Ticket T-2, size M. Lab-Draw: ${used.draw}`));
    h.setNow(T0 + 60_000 + KEEP_REQUESTS_MS - 1000);
    const recent = h.lab.drawArms({ ...forT1, ticket: 'T-3' });
    h.setNow(T0 + 60_000 + KEEP_REQUESTS_MS + 1000);
    assert.equal(h.lab.prune()!.draws, 1);
    assert.equal(statusOf(h, old.draw), undefined);
    assert.equal(row(h, 'orch', DRAW_SLICE + old.draw), null);
    assert.equal(statusOf(h, used.draw), 'bound');
    assert.ok(row(h, 'orch', 'toolu_used')?.arm);
    assert.equal(statusOf(h, recent.draw), 'open');
    assert.ok(row(h, 'orch', DRAW_SLICE + recent.draw));
  } finally {
    h.done();
  }
});

type Row = { result?: { isError?: boolean; structuredContent?: any }; error?: unknown };
const where = (m: Row) => m.result?.structuredContent as any;
const refused = (m: Row) => !!(m.error || m.result?.isError);

test('MCP: lab_arm_draw is an agent tool for its own session; the coordinator sees unbound draws and redraws per session', async () => {
  const h = await harness();
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  registerLabTools(h.lab, registry);
  try {
    assert.deepEqual(declaredToolPolicies().get('lab_arm_draw'), LAB_TOOL_POLICIES.lab_arm_draw);
    assert.deepEqual(LAB_TOOL_POLICIES.lab_arm_draw, { kind: 'agent', reach: 'session', audit: 'lab.arm.draw' });
    const agent = await mcp.agentToken('docker/api', 'orch-session');
    const raw = await mcp.call(agent.secret, 'lab_arm_draw', { ticket: 'T-1', role: 'implementer', model: 'opus' });
    const r = where(raw);
    assert.match(r.draw, plan.DRAW);
    assert.equal(r.arms.length, 1);
    assert.ok(plan.ARMS.includes(r.arms[0].arm));
    assert.equal(r.arms[0].experiment, h.e2.id);
    assert.ok(JSON.stringify(raw.result).includes(`Lab-Draw: ${r.draw}`), 'the summary line names what to put in the brief');
    assert.ok(row(h, 'orch-session', DRAW_SLICE + r.draw), 'held under the caller’s own session');
    where(await mcp.call(agent.secret, 'lab_arm_draw', { ticket: 'T-1', role: 'implementer', model: 'opus' }));
    assert.ok(refused(await mcp.call(agent.secret, 'lab_arm_draw', { ticket: 'not a ticket' })), 'validated input');
    assert.ok(refused(await mcp.call(mcp.token('admin').secret, 'lab_arm_draw', { ticket: 'T-1' })), 'an admin token has no session to draw for');
    const full = where(await mcp.call(mcp.token('admin').secret, 'lab_summary', { full: true }));
    assert.deepEqual(full.experiments.find((e: { id: string }) => e.id === h.e2.id).draws_unbound, [{ session: 'orch-session', unbound: 2, redraw: 1 }]);
    assert.ok(!JSON.stringify(full).includes('"seed"'), 'no seed in the answer');
  } finally {
    mcp.done();
    h.done();
  }
});
