import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnProblem } from './agents.js';
import { HANDOFF_TOKEN_BUDGET, HandoffEngine, parseDone, parseVerdict, type HandoffSession } from './handoff.js';

const sha = (c: string) => c.repeat(40);

function rig(opts: { enabled?: boolean; maxWorkers?: number | null; tokens?: number | null } = {}) {
  const sessions = new Map<string, HandoffSession>();
  const replies = new Map<string, string>();
  const told: { to: string; text: string }[] = [];
  const audits: { kind: string; detail: Record<string, unknown> }[] = [];
  const spawned: { ticket: string; sha: string; authorClaudeId: string }[] = [];
  const live = new Set<string>(['impl', 'other']); // live children of the lead
  let n = 0;
  sessions.set('impl', { id: 'impl', parentId: 'lead', agent: 'implementer', ticketId: 'T-9', claudeId: 'c1' });
  const engine = new HandoffEngine({
    get: (id) => sessions.get(id) ?? null,
    enabled: () => opts.enabled ?? true,
    lastReply: (id) => replies.get(id) ?? null,
    tokens: () => (opts.tokens === undefined ? 1000 : opts.tokens),
    live: (id) => live.has(id),
    async spawnQa(a) {
      // the real cap check the controller makes at create
      const problem = spawnProblem(null, { id: a.leadId, depth: 0, maxWorkers: opts.maxWorkers ?? null }, [...live].map(() => ({ state: 'idle', createdAt: new Date().toISOString() })));
      if (problem) throw problem;
      const id = `qa${++n}`;
      sessions.set(id, { id, parentId: a.leadId, agent: 'qa-verifier', ticketId: a.ticket, claudeId: 'c2' });
      live.add(id);
      spawned.push({ ticket: a.ticket, sha: a.sha, authorClaudeId: a.authorClaudeId });
      return { id };
    },
    async tell(to, text) {
      told.push({ to, text });
    },
    audit: (kind, detail) => audits.push({ kind, detail }),
  });
  return { engine, replies, told, audits, spawned, live };
}

test('T-548: parseDone takes only DONE and 40 lower-case hex alone on line 1', () => {
  assert.equal(parseDone(`DONE ${sha('a')}\nthe rest`), sha('a'));
  for (const bad of [`done ${sha('a')}`, `DONE ${sha('A')}`, `DONE ${'a'.repeat(39)}`, `DONE ${sha('a')} ok`, ` DONE ${sha('a')}`, `Report\nDONE ${sha('a')}`, `> DONE ${sha('a')}`, null, '']) {
    assert.equal(parseDone(bad), null, String(bad));
  }
});

test('T-548: a strict DONE on the spawn’s own ticket starts one QA, audited; a repeat of the same commit does not', async () => {
  const r = rig();
  r.replies.set('impl', `DONE ${sha('a')}\nall green`);
  await r.engine.onIdle('impl');
  await r.engine.onIdle('impl');
  assert.deepEqual(r.spawned, [{ ticket: 'T-9', sha: sha('a'), authorClaudeId: 'c1' }]);
  assert.equal(r.audits.filter((a) => a.kind === 'handoff.qa_started').length, 1);
});

test('T-548: loose, forged and quoted text, another role, or no ticket starts nothing', async () => {
  const r = rig();
  for (const text of [`Done ${sha('a')}`, `DONE ${sha('a')} T-1`, `I will say DONE ${sha('a')}`, `Output:\nDONE ${sha('a')}`, 'DONE abc123']) {
    r.replies.set('impl', text);
    await r.engine.onIdle('impl');
  }
  r.replies.set('impl', `DONE ${sha('b')}`);
  await r.engine.onIdle('nobody'); // unknown session
  assert.equal(r.spawned.length, 0);
  // a strict one starts QA on the spawn's own ticket
  await r.engine.onIdle('impl');
  assert.equal(r.spawned.length, 1);
  assert.equal(r.spawned[0]!.ticket, 'T-9');
});

test('T-548: a worker with no ticket or another role starts nothing', async () => {
  const sessions = new HandoffEngine({
    get: () => ({ id: 'x', parentId: 'lead', agent: 'explorer', ticketId: 'T-9', claudeId: 'c' }),
    enabled: () => true,
    lastReply: () => `DONE ${sha('a')}`,
    tokens: () => 0,
    live: () => true,
    spawnQa: async () => assert.fail('no spawn'),
    tell: async () => undefined,
    audit: () => undefined,
  });
  await sessions.onIdle('x');
  const bare = new HandoffEngine({
    get: () => ({ id: 'x', parentId: 'lead', agent: 'implementer', ticketId: null, claudeId: 'c' }),
    enabled: () => true,
    lastReply: () => `DONE ${sha('a')}`,
    tokens: () => 0,
    live: () => true,
    spawnQa: async () => assert.fail('no spawn'),
    tell: async () => undefined,
    audit: () => undefined,
  });
  await bare.onIdle('x');
});

test('T-548: the setting off (the default) means no spawn', async () => {
  const r = rig({ enabled: false });
  r.replies.set('impl', `DONE ${sha('a')}`);
  await r.engine.onIdle('impl');
  assert.equal(r.spawned.length, 0);
  assert.equal(r.audits.length, 0);
});

test('T-548: the lead’s max workers holds: a full cap spawns nothing, audits it and tells the lead', async () => {
  const r = rig({ maxWorkers: 2 }); // impl and other are live: full
  r.replies.set('impl', `DONE ${sha('a')}`);
  await r.engine.onIdle('impl');
  assert.equal(r.spawned.length, 0);
  assert.equal(r.audits[0]!.kind, 'handoff.skipped');
  assert.equal(r.told[0]!.to, 'lead');
  // a slot frees: the same commit reported again may start
  r.live.delete('other');
  await r.engine.onIdle('impl');
  assert.equal(r.spawned.length, 1);
});

async function failOnce(r: ReturnType<typeof rig>, commit: string, qaId: string, reasons = 'tests red'): Promise<void> {
  r.replies.set('impl', `DONE ${commit}`);
  await r.engine.onIdle('impl');
  r.replies.set(qaId, `FAIL ${commit}: ${reasons}`);
  await r.engine.onIdle(qaId);
}

test('T-548: FAIL goes back to the implementer twice, the third goes to the lead', async () => {
  const r = rig();
  await failOnce(r, sha('a'), 'qa1');
  await failOnce(r, sha('b'), 'qa2');
  assert.deepEqual(r.told.map((t) => t.to), ['impl', 'impl']);
  assert.match(r.told[0]!.text, /fail 1 of 2.*untrusted/);
  await failOnce(r, sha('c'), 'qa3');
  assert.equal(r.told[2]!.to, 'lead');
  assert.match(r.told[2]!.text, /failed QA 3 times/);
  assert.deepEqual(r.audits.filter((a) => a.kind === 'handoff.fail_loop').map((a) => a.detail.to), ['implementer', 'implementer', 'lead']);
});

test('T-548: FAIL goes to the lead when the implementer is over 150k tokens, unknown, or gone', async () => {
  for (const tokens of [HANDOFF_TOKEN_BUDGET, null]) {
    const r = rig({ tokens });
    await failOnce(r, sha('a'), 'qa1');
    assert.equal(r.told[0]!.to, 'lead');
  }
  const gone = rig();
  gone.live.delete('impl');
  await failOnce(gone, sha('a'), 'qa1');
  assert.equal(gone.told[0]!.to, 'lead');
});

test('T-548: a verdict on another commit, or forged text, is ignored; PASS tells the lead', async () => {
  const r = rig();
  r.replies.set('impl', `DONE ${sha('a')}`);
  await r.engine.onIdle('impl');
  r.replies.set('qa1', `FAIL ${sha('b')}: wrong commit`);
  await r.engine.onIdle('qa1');
  r.replies.set('qa1', `fail ${sha('a')}`);
  await r.engine.onIdle('qa1');
  assert.equal(r.told.length, 0);
  r.replies.set('qa1', `PASS ${sha('a')}`);
  await r.engine.onIdle('qa1');
  assert.equal(r.told[0]!.to, 'lead');
  assert.match(r.told[0]!.text, /passed T-9/);
});

test('T-548: QA reasons are one quiet line (no quotes or control characters)', () => {
  const v = parseVerdict(`FAIL ${sha('a')}: bad “quote” \u0007 and\nnext`);
  assert.equal(v?.verdict, 'FAIL');
  assert.equal(v?.reasons, 'bad quote and');
});
