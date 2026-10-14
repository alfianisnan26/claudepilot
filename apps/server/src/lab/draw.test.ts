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
import { MIGRATIONS } from '../store/migrations.js';
import { Lab } from './index.js';
import { registerLabTools } from './portalTools.js';
import { KEEP_REQUESTS_MS } from './retention.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plan: any = await import(fileURLToPath(new URL('../../../../scripts/plan-step.mjs', import.meta.url)));
const T0 = Date.UTC(2030, 0, 2, 9, 0, 0);
async function harness(nowMs = T0 + 60_000, drawsOnly: boolean = plan.E2.draws_only) {
  const SIZES: Record<string, string> = { 'T-1': 'M', 'T-2': 'M', 'T-3': 'L' };
  const dataDir = mkdtempSync(join(tmpdir(), 'labdraw-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  let now = nowMs;
  const lab = new Lab({ store, now: () => now, tickets: (t) => (SIZES[t] ? { changes: [], estimateSize: SIZES[t]! } : null) });
  const e2 = lab.createExperiment({ name: plan.E2.name, hypothesis: plan.E2.hypothesis, design: plan.E2.design, arms: [...plan.E2.arms], strata: [...plan.E2.strata], primaryMetric: plan.E2.primary_metric, minN: plan.E2.min_n, thresholds: { ...plan.E2.thresholds }, drawsOnly, startMs: T0 });
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
const stat = (draws: number, bound: number, redraw: number, session = 'orch', optedOut = 0) => ({ session, draws, bound, unbound: draws - bound, redraw, opted_out: optedOut });

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
    assert.equal(drawn.arm, drawnArm(h.seedOf(), 'T-1', plan.ARMS), 'the arm of the ticket, from the secret seed');

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
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(1, 0, 0, 'orch', 1)], 'the excluded call went without its ticket’s draw');
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
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(2, 1, 1, 'orch', 1)]);
    assert.equal(row(h, 'orch', 'toolu_throwaway')?.excluded, 'draw not bound');
    assert.equal(row(h, 'orch', 'toolu_real')?.arm, second.arms[0]!.arm, 'the bound slice keeps its drawn arm');
    // Two draws for different tickets (two slices dispatched together) are no redraw.
    h.lab.drawArms({ ...forT1, ticket: 'T-2' });
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(3, 1, 1, 'orch', 1)]);
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
      return { arm: h.lab.drawArms({ ...forT1, ticket: 'T-2' }).arms[0]!.arm, want: drawnArm(h.seedOf(), 'T-2', plan.ARMS) };
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
    // A call made inside a sub-agent (nested) is never read for a draw: E2 is draws-only, so it is a slice without a draw (out); the draw stays open.
    h.lab.line('orch', agentCall('toolu_nested', `Ticket T-3, size L. Lab-Draw: ${d.draw}`, { parent: 'toolu_parent' }));
    assert.equal(statusOf(h, d.draw), 'open');
    assert.equal(row(h, 'orch', 'toolu_nested')?.excluded, 'no draw');
    // The key on a later line of the prompt is not read.
    h.lab.line('orch', agentCall('toolu_line2', `Ticket T-3, size L.\nLab-Draw: ${d.draw}`));
    assert.equal(statusOf(h, d.draw), 'open');
    assert.equal(row(h, 'orch', 'toolu_line2')?.excluded, 'no draw');
    // No running experiment: a draw has no arm and the brief is the ordinary one.
    h.lab.stop(h.e2.id);
    assert.deepEqual(h.lab.drawArms({ ...forT1, ticket: 'T-2' }).arms, []);
  } finally {
    h.done();
  }
});

test('draws are not block places: ordinary slices keep balanced blocks around them; the drawn arm comes from the secret seed, not the id', async () => {
  const run = async (withDraws: boolean) => {
    const h = await harness(T0 + 60_000, false);
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
  assert.deepEqual(a.drawn, a.drawn.map((_, i) => drawnArm('seed-fixed', `T-${100 + i}`, plan.ARMS)));
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

test('third review, defect 2: the ticket’s spelling and the role do not steer the arm; redraws count by ticket', async () => {
  const h = await harness();
  try {
    const a = h.lab.drawArms({ ...forT1, ticket: 'T-12' });
    const b = h.lab.drawArms({ ...forT1, ticket: 'T-012' });
    const c = h.lab.drawArms({ ...forT1, ticket: 'T-0012', role: 'general-purpose' });
    assert.deepEqual([b.arms[0]!.arm, c.arms[0]!.arm], [a.arms[0]!.arm, a.arms[0]!.arm], 'one ticket, one arm, whatever the spelling or the role');
    // Over many tickets and roles, so a hash that read the spelling or the role could not pass by chance (two arms: 1 in 2 per draw).
    for (let n = 30; n < 38; n++) {
      const want = drawArms(h.db, { sessionId: 'many', draw: `d-${String(n).padStart(12, '0')}`, for: { ...forT1, ticket: `T-${n}` }, size: 'M', atMs: T0 }).get(h.e2.id);
      for (const [i, role] of ['implementer', 'general-purpose', 'claude', 'explorer', 'reviewer'].entries()) {
        const got = drawArms(h.db, { sessionId: 'many', draw: `d-${String(n).padStart(6, '0')}${String(i).padStart(6, '0')}`, for: { ...forT1, ticket: `T-${'0'.repeat(i)}${n}`, role }, size: 'M', atMs: T0 });
        assert.equal(got.get(h.e2.id), want, `T-${'0'.repeat(i)}${n} as ${role}`);
      }
    }
    assert.equal(a.arms[0]!.arm, drawnArm(h.seedOf(), 'T-12', plan.ARMS));
    assert.equal((h.db.prepare('SELECT ticket FROM lab_draws WHERE draw = ?').get(b.draw) as { ticket: string }).ticket, 'T-12', 'stored as one spelling');
    assert.deepEqual(h.lab.drawStats(h.e2.id).filter((x) => x.session === 'orch'), [stat(3, 0, 2)], 'the second and third are redraws');
    // A call that writes the ticket another way binds the draw (the same ticket).
    h.lab.line('orch', agentCall('toolu_spelled', `Ticket T-0012. Lab-Draw: ${b.draw}`));
    assert.equal(statusOf(h, b.draw), 'bound');
    // Roles do not share a draw: the bind still checks the role.
    h.lab.line('orch', agentCall('toolu_role', `Ticket T-12. Lab-Draw: ${c.draw}`));
    assert.equal(statusOf(h, c.draw), 'refused');
  } finally {
    h.done();
  }
});

test('third review, defect 3: a draws-only experiment gives no block arm; a peek, then a slice without the draw or with a made-up key, is out and counted', async () => {
  const h = await harness();
  try {
    assert.equal(h.e2.drawsOnly, true, 'E2 is draws-only (plan-step.mjs e2)');
    const peek = h.lab.drawArms(forT1);
    h.lab.line('orch', agentCall('toolu_nodraw', 'Ticket T-1, size M.'));
    assert.deepEqual(row(h, 'orch', 'toolu_nodraw'), { arm: null, stratum: '', excluded: 'no draw' }, 'no block arm');
    h.lab.line('orch', agentCall('toolu_madeup', 'Ticket T-1, size M. Lab-Draw: d-0123456789ab'));
    assert.equal(row(h, 'orch', 'toolu_madeup')?.excluded, 'draw not bound');
    // A slice of a ticket never drawn for is out too, but it is no opt-out.
    h.lab.line('orch', agentCall('toolu_other', 'Ticket T-2, size M.'));
    assert.equal(row(h, 'orch', 'toolu_other')?.excluded, 'no draw');
    assert.deepEqual(h.lab.drawStats(h.e2.id), [stat(1, 0, 0, 'orch', 2)], 'the abandoned draw and the two slices that went without it');
    assert.equal(statusOf(h, peek.draw), 'open');
    // The draw used: the slice has its arm; an experiment that is not draws-only still block-assigns a slice without a draw.
    h.lab.line('orch', agentCall('toolu_drawn', `Ticket T-1, size M. Lab-Draw: ${peek.draw}`));
    assert.equal(row(h, 'orch', 'toolu_drawn')?.arm, peek.arms[0]!.arm);
    const plain = h.lab.createExperiment({ name: 'plain', design: 'randomized', arms: ['a', 'b'], primaryMetric: 'm', startMs: T0 });
    assert.equal(plain.drawsOnly, false);
    assert.ok(assignSlice(h.db, { sessionId: 'orch', sliceId: 'later', attrs: { size: 'M', role: 'implementer', model: 'opus', effort: null }, atMs: T0 + 1 }).get(plain.id));
    assert.throws(() => h.lab.createExperiment({ name: 'ba', design: 'before_after', primaryMetric: 'm', startMs: T0, switchMs: T0 + 1, drawsOnly: true }), /draws only/);
  } finally {
    h.done();
  }
});

test('third review, defect 1: a database at migration 854 upgrades (855): the draw column backfilled, a seed for every experiment, draws work', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'labdraw-mig-'));
  const secretKey = parseSecretKey(generateSecretKey());
  try {
    const old = await Store.open({ dataDir, secretKey, migrations: MIGRATIONS.filter((m) => m.version !== 855) });
    const cols = (t: string, db = old.db!) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols('lab_experiments').includes('seed') && !cols('lab_assignments').includes('draw'), 'the 854 schema');
    old.db!.prepare("INSERT INTO lab_experiments (id, name, hypothesis, design, arms, primary_metric, guardrails, thresholds, min_n, status, start_ms, created_ms) VALUES ('exp-old', 'old', '', 'randomized', '[\"a\",\"b\"]', 'm', '[]', '{}', 0, 'running', ?, ?)").run(T0, T0);
    old.db!.prepare("INSERT INTO lab_draws (draw, session_id, ticket, role, model, effort, size, drawn_ms) VALUES ('d-00000000000a', 'orch', 'T-1', 'implementer', 'opus', NULL, NULL, ?)").run(T0);
    old.db!.prepare("INSERT INTO lab_assignments (experiment_id, session_id, slice_id, arm, stratum, assigned_ms) VALUES ('exp-old', 'orch', 'draw:d-00000000000a', 'a', 'implementer|opus', ?), ('exp-old', 'orch', 'plain-1', 'b', 'implementer|opus', ?)").run(T0, T0);
    old.close();
    const store = await Store.open({ dataDir, secretKey });
    try {
      const db = store.db!;
      assert.ok(cols('lab_assignments', db).includes('draw') && cols('lab_experiments', db).includes('draws_only'));
      assert.deepEqual(db.prepare('SELECT slice_id, draw FROM lab_assignments ORDER BY slice_id').all().map((r) => ({ ...r })), [
        { slice_id: 'draw:d-00000000000a', draw: 'd-00000000000a' },
        { slice_id: 'plain-1', draw: null },
      ]);
      const seed = (db.prepare("SELECT seed, draws_only FROM lab_experiments WHERE id = 'exp-old'").get() as { seed: string; draws_only: number });
      assert.match(seed.seed, /^[0-9a-f]{32}$/, 'a fresh secret seed, not the id');
      assert.equal(seed.draws_only, 0);
      const lab = new Lab({ store, now: () => T0 + 60_000, tickets: () => ({ changes: [], estimateSize: 'M' }) });
      try {
        const d = lab.drawArms(forT1);
        assert.equal(d.arms[0]!.arm, drawnArm(seed.seed, 'T-1', ['a', 'b']));
        assert.ok(assignSlice(db, { sessionId: 'orch', sliceId: 'plain-2', attrs: { size: 'M', role: 'implementer', model: 'opus', effort: null }, atMs: T0 + 2 }).get('exp-old'));
        assert.deepEqual(lab.drawStats('exp-old'), [stat(2, 0, 1)]);
      } finally {
        lab.close();
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
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
    assert.equal(full.experiments.find((e: { id: string }) => e.id === h.e2.id).draws_only, true);
    assert.ok(!JSON.stringify(full).includes('"seed"'), 'no seed in the answer');
  } finally {
    mcp.done();
    h.done();
  }
});
