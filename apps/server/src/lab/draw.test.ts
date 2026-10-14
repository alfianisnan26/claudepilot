// Efficiency lab, T-292 slice 3: draws. The arm of a slice whose treatment is the brief itself (E2, pack on or off) is drawn before the brief
// is written (`lab_arm_draw`) and bound when the top-level Agent call that carries `Lab-Draw: <key>` on its first line starts in the same
// session, for the same ticket, role, model and effort. The brief head comes from scripts/plan-step.mjs, the experiment from its E2 spec, so
// the script and the lab are checked together. Negative twins: the review's probes A (a draw taken by another role) and B (a redraw hidden
// behind a throwaway call), a nested call, another session, a reused key; the second review's: a throwaway call that matches the draw in
// every attribute, a peek draw for another ticket, retention deleting the evidence, a changed ESTIMATE size. No clock is read.
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
import { assignSlice, blockOrder, bindDraw, drawArms, drawnArm, DRAW_SLICE } from './experiments.js';
import { Lab } from './index.js';
import { registerLabTools } from './portalTools.js';
import { KEEP_REQUESTS_MS } from './retention.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plan: any = await import(fileURLToPath(new URL('../../../../scripts/plan-step.mjs', import.meta.url)));
const T0 = Date.UTC(2030, 0, 2, 9, 0, 0);
async function harness(nowMs = T0 + 60_000) {
  const SIZES: Record<string, string> = { 'T-1': 'M', 'T-2': 'M', 'T-3': 'L' };
  const dataDir = mkdtempSync(join(tmpdir(), 'labdraw-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  let now = nowMs;
  const lab = new Lab({ store, now: () => now, tickets: (t) => (SIZES[t] ? { changes: [], estimateSize: SIZES[t]! } : null) });
  const e2 = lab.createExperiment({ name: plan.E2.name, hypothesis: plan.E2.hypothesis, design: plan.E2.design, arms: [...plan.E2.arms], strata: [...plan.E2.strata], primaryMetric: plan.E2.primary_metric, minN: plan.E2.min_n, thresholds: { ...plan.E2.thresholds }, startMs: T0 });
  const seedOf = () => (store.db!.prepare('SELECT seed FROM lab_experiments WHERE id = ?').get(e2.id) as { seed: string }).seed;
  return { store, lab, db: store.db!, e2, sizes: SIZES, seedOf, setNow: (ms: number) => (now = ms), done: () => (lab.close(), store.close(), rmSync(dataDir, { recursive: true, force: true })) };
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
const stat = (draws: number, bound: number, redraw: number, session = 'orch') => ({ session, draws, bound, unbound: draws - bound, redraw });

test('a draw made before the brief is the arm the slice keeps; the stratum is the ticket’s ESTIMATE size', async () => {
  const h = await harness();
  try {
    const d = h.lab.drawArms(forT1);
    assert.match(d.draw, plan.DRAW);
    assert.equal(d.arms.length, 1);
    const drawn = d.arms[0]!;
    assert.deepEqual([drawn.experiment, drawn.name], [h.e2.id, 'E2-context-compiler']);
    assert.equal(row(h, 'orch', DRAW_SLICE + d.draw)?.stratum, 'size=M|role=implementer|model=opus');
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(1, 0, 0)]);
    assert.equal(drawn.arm, drawnArm(h.seedOf(), 'T-1', 'implementer', plan.ARMS), 'the arm of the ticket and role, from the secret seed');

    const head = plan.briefHead({ ticket: 'T-1', size: 'M', arm: drawn.arm, draw: d.draw, manifestBlock: drawn.arm === 'treatment' ? 'manifest' : null });
    // Without the bind this slice would be excluded (its brief names a draw it did not get): checked by removing bindDraw.
    h.lab.line('orch', agentCall('toolu_draw_1', head + '\nThe rest of the brief.'));
    assert.deepEqual(row(h, 'orch', 'toolu_draw_1'), { arm: drawn.arm, stratum: 'size=M|role=implementer|model=opus', excluded: null });
    assert.equal(row(h, 'orch', DRAW_SLICE + d.draw), null, 'the draw row moved to the slice');
    assert.equal(statusOf(h, d.draw), 'bound');
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(1, 1, 0)], 'a bound draw is still counted');

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
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(1, 0, 0)]);
    // Ticket, effort and the ESTIMATE size are checked too.
    const t = h.lab.drawArms(forT1);
    const f1 = { ticket: 'T-1', role: 'implementer', model: 'opus', effort: null };
    assert.equal(bindDraw(h.db, { sessionId: 'orch', draw: t.draw, sliceId: 'x', for: { ...f1, ticket: 'T-2' }, size: 'M', atMs: T0 }), 'refused');
    assert.equal(bindDraw(h.db, { sessionId: 'orch', draw: t.draw, sliceId: 'x', for: { ...f1, effort: 'high' }, size: 'M', atMs: T0 }), 'refused');
    assert.equal(bindDraw(h.db, { sessionId: 'orch', draw: t.draw, sliceId: 'x', for: f1, size: 'L', atMs: T0 }), 'refused', 'the size changed');
    // A refused draw still binds to the call it was drawn for.
    assert.equal(bindDraw(h.db, { sessionId: 'orch', draw: t.draw, sliceId: 'x', for: f1, size: 'M', atMs: T0 }), 'bound');
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
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(2, 1, 1)]);
    assert.equal(row(h, 'orch', 'toolu_throwaway')?.excluded, 'draw not bound');
    assert.equal(row(h, 'orch', 'toolu_real')?.arm, second.arms[0]!.arm, 'the bound slice keeps its drawn arm');
    // Two draws for different tickets (two slices dispatched together) are no redraw.
    h.lab.drawArms({ ...forT1, ticket: 'T-2' });
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(3, 1, 1)]);
  } finally {
    h.done();
  }
});

test('second review, defect 1: a throwaway call that matches the draw in every attribute neither changes the arm nor hides the redraw', async () => {
  const h = await harness();
  try {
    const first = h.lab.drawArms(forT1);
    // The throwaway: the same ticket, role, model and effort, so it binds the first draw.
    h.lab.line('orch', agentCall('toolu_throwaway', `Ticket T-1, size M. Lab-Draw: ${first.draw}`));
    assert.equal(statusOf(h, first.draw), 'bound');
    const second = h.lab.drawArms(forT1);
    assert.equal(second.arms[0]!.arm, first.arms[0]!.arm, 'drawing again gives the same arm: nothing to gain');
    h.lab.line('orch', agentCall('toolu_real', `Ticket T-1, size M. Lab-Draw: ${second.draw}`));
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(2, 2, 1)], 'both draws counted, the second as a redraw, though both are bound');
    // Another model or effort for the same ticket and role is the same arm too (no shopping by changing the dispatch).
    assert.equal(h.lab.drawArms({ ...forT1, model: 'sonnet', effort: 'high' }).arms[0]!.arm, first.arms[0]!.arm);
  } finally {
    h.done();
  }
});

test('second review, defect 1: a peek draw for another ticket of the same size says nothing about the next ticket’s arm', async () => {
  const run = async (peeks: number) => {
    const h = await harness();
    try {
      for (let i = 0; i < peeks; i++) h.lab.drawArms({ ...forT1, ticket: `T-${200 + i}` });
      return { arm: h.lab.drawArms({ ...forT1, ticket: 'T-2' }).arms[0]!.arm, want: drawnArm(h.seedOf(), 'T-2', 'implementer', plan.ARMS) };
    } finally {
      h.done();
    }
  };
  // In two-arm blocks a peek at place 2k told the arm at 2k+1; now the arm is the ticket's own, whatever was drawn before it.
  for (const peeks of [0, 1, 2, 3]) {
    const r = await run(peeks);
    assert.equal(r.arm, r.want, `${peeks} peeks`);
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

test('draws are not block places: ordinary slices keep balanced blocks around them; the drawn arm comes from the secret seed, not the id', async () => {
  const run = async (withDraws: boolean) => {
    const h = await harness();
    try {
      const seed = h.seedOf();
      assert.match(seed, /^[0-9a-f]{32}$/);
      assert.ok(!JSON.stringify(h.lab.experiments()).includes(seed), 'the seed is never shown');
      h.db.prepare('UPDATE lab_experiments SET id = ?, seed = ? WHERE id = ?').run('exp-e2-fixed', 'seed-fixed', h.e2.id);
      const plain: string[] = [];
      const drawn: string[] = [];
      const attrs = { size: 'M', role: 'implementer', model: 'opus', effort: null };
      for (let i = 0; i < 6; i++) {
        if (withDraws) drawn.push(drawArms(h.db, { sessionId: 'orch', draw: `d-00000000000${i}`, for: { ticket: `T-${100 + i}`, role: 'implementer', model: 'opus', effort: null }, size: 'M', atMs: T0 + i }).get('exp-e2-fixed')!);
        plain.push(assignSlice(h.db, { sessionId: 'orch', sliceId: `plain-${i}`, attrs, atMs: T0 + i }).get('exp-e2-fixed')!);
      }
      return { plain, drawn };
    } finally {
      h.done();
    }
  };
  const a = await run(true);
  assert.deepEqual(a, await run(true), 'deterministic for a given seed');
  assert.deepEqual(a.plain, (await run(false)).plain, 'the draws moved no ordinary slice');
  const stratum = 'size=M|role=implementer|model=opus';
  assert.deepEqual(a.plain, a.plain.map((_, k) => blockOrder('seed-fixed', stratum, Math.floor(k / 2), plan.ARMS)[k % 2]), 'the seed, not the id, orders the block');
  for (let b = 0; b < 3; b++) assert.deepEqual([a.plain[2 * b], a.plain[2 * b + 1]].sort(), ['control', 'treatment'], `block ${b}`);
  assert.deepEqual(a.drawn, a.drawn.map((_, i) => drawnArm('seed-fixed', `T-${100 + i}`, 'implementer', plan.ARMS)));
});

test('a draw is for a ticket', async () => {
  const h = await harness();
  try {
    assert.throws(() => drawArms(h.db, { sessionId: 'orch', draw: 'd-000000000001', for: { ticket: null, role: 'implementer', model: 'opus', effort: null }, size: null, atMs: T0 }), /for a ticket/);
  } finally {
    h.done();
  }
});

test('the ESTIMATE size changed between the draw and the call: refused, the slice out', async () => {
  const h = await harness();
  try {
    const d = h.lab.drawArms(forT1);
    h.sizes['T-1'] = 'L';
    h.lab.line('orch', agentCall('toolu_resized', `Ticket T-1, size L. Lab-Draw: ${d.draw}`));
    assert.equal(statusOf(h, d.draw), 'refused');
    assert.equal(row(h, 'orch', 'toolu_resized')?.excluded, 'draw not bound');
  } finally {
    h.done();
  }
});

test('second review, defect 3: retention expires unbound draws and keeps them as evidence; an expired draw no longer binds', async () => {
  const h = await harness();
  try {
    const old = h.lab.drawArms(forT1);
    const used = h.lab.drawArms({ ...forT1, ticket: 'T-2' });
    h.lab.line('orch', agentCall('toolu_used', `Ticket T-2, size M. Lab-Draw: ${used.draw}`));
    h.setNow(T0 + 60_000 + KEEP_REQUESTS_MS - 1000);
    const recent = h.lab.drawArms({ ...forT1, ticket: 'T-3' });
    h.setNow(T0 + 60_000 + KEEP_REQUESTS_MS + 1000);
    assert.equal(h.lab.prune()!.draws, 1);
    assert.equal(statusOf(h, old.draw), 'expired');
    assert.ok(row(h, 'orch', DRAW_SLICE + old.draw)?.arm, 'its held arm stays');
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(3, 1, 0)], 'every draw still counted');
    assert.equal(statusOf(h, used.draw), 'bound');
    assert.ok(row(h, 'orch', 'toolu_used')?.arm);
    assert.equal(statusOf(h, recent.draw), 'open');
    assert.equal(h.lab.prune()!.draws, 0, 'safe to run again');
    // A redraw after the expiry is still a redraw.
    h.lab.drawArms(forT1);
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(4, 1, 1)]);
    // Too late: the expired draw is refused and the call kept out.
    h.lab.line('orch', agentCall('toolu_late', `Ticket T-1, size M. Lab-Draw: ${old.draw}`, { at: T0 + 60_000 + KEEP_REQUESTS_MS + 2000 }));
    assert.equal(statusOf(h, old.draw), 'expired');
    assert.equal(row(h, 'orch', 'toolu_late')?.excluded, 'draw not bound');
  } finally {
    h.done();
  }
});

type Row = { result?: { isError?: boolean; structuredContent?: any }; error?: unknown };
const where = (m: Row) => m.result?.structuredContent as any;
const refused = (m: Row) => !!(m.error || m.result?.isError);

test('MCP: lab_arm_draw is an agent tool for its own session; the coordinator sees every draw, bound, unbound and redraws per session', async () => {
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
    const again = where(await mcp.call(agent.secret, 'lab_arm_draw', { ticket: 'T-1', role: 'implementer', model: 'opus' }));
    assert.equal(again.arms[0].arm, r.arms[0].arm, 'the same arm for the same ticket and role');
    assert.ok(refused(await mcp.call(agent.secret, 'lab_arm_draw', { ticket: 'not a ticket' })), 'validated input');
    assert.ok(refused(await mcp.call(agent.secret, 'lab_arm_draw', { role: 'implementer' })), 'a draw names its ticket');
    assert.ok(refused(await mcp.call(mcp.token('admin').secret, 'lab_arm_draw', { ticket: 'T-1' })), 'an admin token has no session to draw for');
    const full = where(await mcp.call(mcp.token('admin').secret, 'lab_summary', { full: true }));
    assert.deepEqual(full.experiments.find((e: { id: string }) => e.id === h.e2.id).draws, [stat(2, 0, 1, 'orch-session')]);
    assert.ok(!JSON.stringify(full).includes('"seed"'), 'no seed in the answer');
  } finally {
    mcp.done();
    h.done();
  }
});
