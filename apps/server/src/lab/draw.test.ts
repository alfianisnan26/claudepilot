// Efficiency lab, T-292 slice 3: draws. The arm of a slice whose treatment is the brief itself (E2, pack on or off) is drawn before the brief
// is written (`lab_arm_draw`) and bound when the Agent call that carries `Lab-Draw: <key>` starts in the same session. The brief head comes
// from scripts/plan-step.mjs, the experiment from its E2 spec, so the script and the lab are checked together. No clock is read.
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
import { assignSlice, bindDraw, createExperiment, drawArms, DRAW_SLICE } from './experiments.js';
import { Lab } from './index.js';
import { registerLabTools } from './portalTools.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plan: any = await import(fileURLToPath(new URL('../../../../scripts/plan-step.mjs', import.meta.url)));
const T0 = Date.UTC(2030, 0, 2, 9, 0, 0);
const SIZES: Record<string, string> = { 'T-1': 'M', 'T-2': 'M', 'T-3': 'L' };

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'labdraw-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const lab = new Lab({ store, now: () => T0 + 60_000, tickets: (t) => (SIZES[t] ? { changes: [], estimateSize: SIZES[t]! } : null) });
  const e2 = lab.createExperiment({ name: plan.E2.name, hypothesis: plan.E2.hypothesis, design: plan.E2.design, arms: [...plan.E2.arms], strata: [...plan.E2.strata], primaryMetric: plan.E2.primary_metric, minN: plan.E2.min_n, thresholds: { ...plan.E2.thresholds }, startMs: T0 });
  return { store, lab, db: store.db!, e2, done: () => (lab.close(), store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

/** The orchestrator's Agent call, as the stream line the lab reads. */
const agentCall = (toolUseId: string, prompt: string, at = T0 + 120_000) =>
  JSON.stringify({ type: 'assistant', parent_tool_use_id: null, timestamp: new Date(at).toISOString(), message: { id: `msg_${toolUseId}`, model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type: 'implementer', model: 'opus', prompt } }] } });

const armOf = (h: Awaited<ReturnType<typeof harness>>, session: string, slice: string) =>
  (h.db.prepare('SELECT arm, stratum FROM lab_assignments WHERE experiment_id = ? AND session_id = ? AND slice_id = ?').get(h.e2.id, session, slice) as { arm: string; stratum: string } | undefined) ?? null;

test('a draw made before the brief is the arm the slice keeps; the stratum is the ticket’s ESTIMATE size', async () => {
  const h = await harness();
  try {
    const d = h.lab.drawArms({ sessionId: 'orch', ticket: 'T-1', role: 'implementer', model: 'opus', effort: null });
    assert.match(d.draw, plan.DRAW);
    assert.equal(d.arms.length, 1);
    const drawn = d.arms[0]!;
    assert.deepEqual([drawn.experiment, drawn.name], [h.e2.id, 'E2-context-compiler']);
    assert.equal(armOf(h, 'orch', DRAW_SLICE + d.draw)?.stratum, 'size=M|role=implementer|model=opus');
    assert.equal(h.lab.unboundDraws(h.e2.id), 1);

    const head = plan.briefHead({ ticket: 'T-1', size: 'M', arm: drawn.arm, draw: d.draw, manifestBlock: drawn.arm === 'treatment' ? 'manifest' : null });
    h.lab.line('orch', agentCall('toolu_draw_1', head + '\nThe rest of the brief.'));
    assert.deepEqual(armOf(h, 'orch', 'toolu_draw_1'), { arm: drawn.arm, stratum: 'size=M|role=implementer|model=opus' });
    assert.equal(armOf(h, 'orch', DRAW_SLICE + d.draw), null, 'the draw row moved to the slice');
    assert.equal(h.lab.unboundDraws(h.e2.id), 0);

    // A replayed line changes nothing; the same key in a second Agent call binds nothing (once only): that slice is assigned as usual.
    h.lab.line('orch', agentCall('toolu_draw_1', head));
    assert.equal(armOf(h, 'orch', 'toolu_draw_1')?.arm, drawn.arm);
    h.lab.line('orch', agentCall('toolu_draw_2', head));
    const second = armOf(h, 'orch', 'toolu_draw_2');
    assert.ok(second, 'assigned');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM lab_assignments WHERE experiment_id = ?').get(h.e2.id)!.n, 2);
  } finally {
    h.done();
  }
});

test('draws share the blocks with ordinary slices: balanced within one slice per stratum, and the same draw sequence on a replay', async () => {
  const run = async () => {
    const h = await harness();
    try {
      h.db.prepare('UPDATE lab_experiments SET id = ? WHERE id = ?').run('exp-e2-fixed', h.e2.id);
      const out: string[] = [];
      for (let i = 0; i < 6; i++) {
        const attrs = { size: 'M', role: 'implementer', model: 'opus', effort: null };
        // Alternate a draw and an ordinary start in the same stratum.
        const got = i % 2 ? assignSlice(h.db, { sessionId: 'orch', sliceId: `plain-${i}`, attrs, atMs: T0 + i }) : drawArms(h.db, { sessionId: 'orch', draw: `d-00000000000${i}`, attrs, atMs: T0 + i });
        out.push(got.get('exp-e2-fixed')!);
      }
      return out;
    } finally {
      h.done();
    }
  };
  const a = await run();
  assert.deepEqual(a, await run(), 'deterministic');
  for (let b = 0; b < 3; b++) assert.deepEqual([a[2 * b], a[2 * b + 1]].sort(), ['control', 'treatment'], `block ${b}`);
});

test('a draw binds only in the session that drew it; a draw never used stays counted', async () => {
  const h = await harness();
  try {
    const d = h.lab.drawArms({ sessionId: 'orch', ticket: 'T-3', role: 'implementer', model: 'opus', effort: null });
    assert.equal(bindDraw(h.db, 'someone-else', d.draw, 'toolu_x'), 0);
    h.lab.line('someone-else', agentCall('toolu_other', `Ticket T-3, size L. Lab-Draw: ${d.draw}`));
    assert.ok(armOf(h, 'someone-else', 'toolu_other'), 'the other session’s slice gets its own assignment');
    assert.ok(armOf(h, 'orch', DRAW_SLICE + d.draw), 'the draw is untouched');
    assert.equal(h.lab.unboundDraws(h.e2.id), 1, 'visible: drawing until an arm suits would show');
    // No running experiment: a draw has no arm and the brief is the ordinary one.
    h.lab.stop(h.e2.id);
    assert.deepEqual(h.lab.drawArms({ sessionId: 'orch', ticket: 'T-2', role: 'implementer', model: 'opus', effort: null }).arms, []);
  } finally {
    h.done();
  }
});

type Row = { result?: { isError?: boolean; structuredContent?: any }; error?: unknown };
const where = (m: Row) => m.result?.structuredContent as any;
const refused = (m: Row) => !!(m.error || m.result?.isError);

test('MCP: lab_arm_draw is an agent tool for its own session; the coordinator sees unbound draws', async () => {
  const h = await harness();
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  registerLabTools(h.lab, registry);
  try {
    assert.deepEqual(declaredToolPolicies().get('lab_arm_draw'), LAB_TOOL_POLICIES.lab_arm_draw);
    assert.deepEqual(LAB_TOOL_POLICIES.lab_arm_draw, { kind: 'agent', reach: 'session', audit: 'lab.arm.draw' });
    const agent = await mcp.agentToken('docker/api', 'orch-session');
    const r = where(await mcp.call(agent.secret, 'lab_arm_draw', { ticket: 'T-1', role: 'implementer', model: 'opus' }));
    assert.match(r.draw, plan.DRAW);
    assert.equal(r.arms.length, 1);
    assert.ok(plan.ARMS.includes(r.arms[0].arm));
    assert.equal(r.arms[0].experiment, h.e2.id);
    assert.ok(r.summary.includes(`Lab-Draw: ${r.draw}`));
    assert.ok(armOf(h, 'orch-session', DRAW_SLICE + r.draw), 'held under the caller’s own session');
    assert.ok(refused(await mcp.call(agent.secret, 'lab_arm_draw', { ticket: 'not a ticket' })), 'validated input');
    assert.ok(refused(await mcp.call(mcp.token('admin').secret, 'lab_arm_draw', { ticket: 'T-1' })), 'an admin token has no session to draw for');
    const full = where(await mcp.call(mcp.token('admin').secret, 'lab_summary', { full: true }));
    assert.equal(full.experiments.find((e: { id: string }) => e.id === h.e2.id).draws_unbound, 1);
  } finally {
    mcp.done();
    h.done();
  }
});
