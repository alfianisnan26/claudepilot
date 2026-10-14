// The factory engine v0 (T-293, docs/dev-sessions/factory.mjs): intake, the brief, the budgets, the resume check, and the dry-run CLI.
// Negative twins: the budget stop, the stale resume, the double dispatch. No clock is read: every time is built from a fixed `now`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const FACTORY = fileURLToPath(new URL('../../../../docs/dev-sessions/factory.mjs', import.meta.url));
const TEMPLATE = readFileSync(new URL('../../../../docs/dev-sessions/factory-brief.md', import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const f: any = await import(FACTORY);

const NOW = Date.UTC(2030, 0, 2, 12, 0, 0);
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();
let n = 100;
function ticket(over: Record<string, unknown> = {}, comments: string[] = ['ESTIMATE (orch): size M, about 3 h, severity 3']) {
  const num = n++;
  return { id: `T-${num}`, number: num, status: 'open', tags: ['rank-05'], summary: `Ticket ${num}`, comments: comments.map((text, i) => ({ kind: 'comment', at: ago(100 - i), text })), ...over };
}

test('intake: ranked order, ESTIMATE and size required, XL split first, rank tag required, closed ignored', () => {
  const a = ticket({ tags: ['rank-07'] });
  const b = ticket({ tags: ['rank-03b'] });
  const c = ticket({ tags: ['rank-03'] }, ['ESTIMATE: size S']);
  const noEst = ticket({}, ['just a note']);
  const xl = ticket({}, ['ESTIMATE size XL, split']);
  const noRank = ticket({ tags: ['claudepilot'] });
  const done = ticket({ status: 'done', tags: ['rank-01'] });
  const plan = f.intake([a, b, c, noEst, xl, noRank, done], { models: { implementer: 'opus' } });
  assert.deepEqual(plan.dispatch.map((d: { ticket: string }) => d.ticket), [c.id, b.id, a.id]);
  assert.deepEqual(plan.dispatch[0], { ticket: c.id, summary: c.summary, rank: 'rank-03', size: 'S', budget: 25, stopAt: 38, role: 'implementer', model: 'opus', branch: `ticket/${c.id}-ticket-${c.number}`, worktree: `../claudepilot.worktrees/ticket-${c.id}-ticket-${c.number}`, dispatchId: `${c.id}-F1` });
  assert.deepEqual(plan.skipped, [
    { ticket: noEst.id, reason: 'no ESTIMATE' },
    { ticket: xl.id, reason: 'XL: split first' },
    { ticket: noRank.id, reason: 'no rank tag' },
  ]);
  assert.equal(plan.stopped, null);
});

test('intake reads the portal shapes: TicketDetail events and MCP untrusted_text', () => {
  const detail = { ticket: { id: 'T-7', number: 7, status: 'open', tags: ['rank-01'], summary: 'Fix it' }, events: [{ kind: 'status', at: ago(5), body: null }, { kind: 'comment', at: ago(4), body: 'ESTIMATE size L' }] };
  const mcp = { id: 'T-8', status: 'open', tags: ['rank-02'], summary: { untrusted_text: 'Do that' }, comments: [{ kind: 'comment', at: ago(3), text: { untrusted_text: 'ESTIMATE: size: s' } }] };
  const plan = f.intake([detail, mcp]);
  assert.deepEqual(plan.dispatch.map((d: { ticket: string; size: string; budget: number }) => [d.ticket, d.size, d.budget]), [['T-7', 'L', 120], ['T-8', 'S', 25]]);
});

test('WIP: in-progress tickets and open dispatches count; the plan stops at the limit', () => {
  const busy = [ticket({ status: 'in_progress' }), ticket({ status: 'in_progress' })];
  const open = [ticket({ tags: ['rank-01'] }), ticket({ tags: ['rank-02'] })];
  const plan = f.intake([...busy, ...open], { wip: 3 });
  assert.deepEqual(plan.dispatch.map((d: { ticket: string }) => d.ticket), [open[0]!.id]);
  assert.equal(plan.stopped, 'wip: 3 of 3 in flight');
});

test('budget: a run over its request budget STOPS at the first ticket that does not fit (negative twin: within the budget it dispatches)', () => {
  const first = ticket({ tags: ['rank-01'] }, ['ESTIMATE size M']);
  const big = ticket({ tags: ['rank-02'] }, ['ESTIMATE size L']);
  const small = ticket({ tags: ['rank-03'] }, ['ESTIMATE size S']);
  const over = f.intake([first, big, small], { budget: 100 });
  assert.deepEqual(over.dispatch.map((d: { ticket: string }) => d.ticket), [first.id], 'the cheaper ticket after the stop is not taken: rank order holds');
  assert.equal(over.stopped, `budget: ${big.id} needs 120 requests, 40 of 100 left`);
  assert.deepEqual(over.budget, { limit: 100, planned: 60 });
  const fits = f.intake([first, big, small], { budget: 205 });
  assert.equal(fits.dispatch.length, 3);
  assert.equal(fits.stopped, null);
});

test('slice budget: S 25, M 60, L 120; over past 100 percent, stop at 150 percent; XL has none', () => {
  assert.deepEqual(f.sliceBudget('M', 60), { budget: 60, stopAt: 90, used: 60, state: 'ok' });
  assert.equal(f.sliceBudget('M', 61).state, 'over');
  assert.equal(f.sliceBudget('M', 89).state, 'over');
  assert.equal(f.sliceBudget('M', 90).state, 'stop');
  assert.equal(f.sliceBudget('S', 38).state, 'stop');
  assert.equal(f.sliceBudget('L', 179).state, 'over');
  assert.equal(f.sliceBudget('L', 180).state, 'stop');
  assert.throws(() => f.sliceBudget('XL', 1), /split/);
});

test('double dispatch: a ticket with an open DISPATCH is skipped, also when the same ticket is in the input twice (negative twin: an ENDed dispatch frees it)', () => {
  const t = ticket({ tags: ['rank-01'] });
  const first = f.intake([t, t]);
  assert.equal(first.dispatch.length, 1, 'the same ticket twice in one input is one dispatch');
  const marker = f.dispatchMarker(first.dispatch[0]);
  assert.match(marker, new RegExp(`^FACTORY DISPATCH ${t.id}-F1 role=implementer model=unset size=M budget=60 branch=ticket/${t.id}-`));
  const dispatched = { ...t, comments: [...t.comments, { kind: 'comment', at: ago(10), text: marker }] };
  const second = f.intake([dispatched]);
  assert.deepEqual(second.dispatch, []);
  assert.deepEqual(second.skipped, [{ ticket: t.id, reason: `dispatched (${t.id}-F1)` }]);
  assert.deepEqual(second.inFlight, [t.id], 'an open dispatch counts against WIP');
  const ended = { ...dispatched, comments: [...dispatched.comments, { kind: 'comment', at: ago(5), text: `FACTORY END ${t.id}-F1 sent back` }] };
  const third = f.intake([ended]);
  assert.deepEqual(third.dispatch.map((d: { dispatchId: string }) => d.dispatchId), [`${t.id}-F2`], 'a new dispatch gets the next id');
});

test('idempotent: the same input gives the same plan', () => {
  const input = [ticket({ tags: ['rank-02'] }), ticket({ tags: ['rank-01'] }, ['ESTIMATE size L']), ticket({ status: 'in_progress' })];
  const copy = JSON.parse(JSON.stringify(input));
  assert.deepEqual(f.intake(input, { wip: 5, budget: 500 }), f.intake(copy, { wip: 5, budget: 500 }));
  assert.deepEqual(input, copy, 'intake does not change its input');
});

test('resume: an open, newest, fresh dispatch may resume; stale, ended, superseded, unknown and closed are refused', () => {
  const at = (min: number, text: string) => ({ kind: 'comment', at: ago(min), text });
  const base = ticket({ status: 'in_progress' }, []);
  const d1 = `FACTORY DISPATCH ${base.id}-F1 role=implementer model=opus size=M budget=60 branch=b`;
  const fresh = { ...base, comments: [at(30, d1)] };
  const ok = f.resumeCheck(fresh, `${base.id}-F1`, { now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.dispatch.size, 'M');
  // the negative twin of the fresh one: the same dispatch past the age limit
  assert.deepEqual(f.resumeCheck({ ...base, comments: [at(361, d1)] }, `${base.id}-F1`, { now: NOW }), { ok: false, reason: `stale: dispatch ${base.id}-F1 is 361 min old (limit 360)` });
  assert.equal(f.resumeCheck({ ...base, comments: [at(61, d1)] }, `${base.id}-F1`, { now: NOW, maxAgeMin: 60 }).ok, false);
  assert.match(f.resumeCheck({ ...base, comments: [at(30, d1), at(20, `FACTORY END ${base.id}-F1 merged`)] }, `${base.id}-F1`, { now: NOW }).reason, /ended \(merged\)/);
  const d2 = d1.replace('-F1', '-F2');
  assert.match(f.resumeCheck({ ...base, comments: [at(30, d1), at(20, d2)] }, `${base.id}-F1`, { now: NOW }).reason, /superseded by .*-F2/);
  assert.match(f.resumeCheck(fresh, `${base.id}-F9`, { now: NOW }).reason, /unknown dispatch/);
  assert.match(f.resumeCheck({ ...fresh, status: 'done' }, `${base.id}-F1`, { now: NOW }).reason, /is done/);
  assert.throws(() => f.resumeCheck(fresh, `${base.id}-F1`, {}), /needs now/);
});

test('brief: the template renders the role, model, budget, stop, trailers, context pack and token discipline; a missing or unused value throws', () => {
  const t = ticket({ tags: ['rank-01'] }, ['ESTIMATE size L']);
  const [d] = f.intake([t], { models: { implementer: 'opus' } }).dispatch;
  const rules = f.tokenRules(readFileSync(new URL('../../../../docs/dev-sessions/token-discipline.md', import.meta.url), 'utf8'));
  assert.equal(rules.split('\n').length, 8);
  const brief = f.renderBrief(TEMPLATE, f.briefVars(d, { session: 'sess-1', tokenDiscipline: rules }));
  assert.doesNotMatch(brief, /\{\{/);
  for (const want of [`Ticket ${t.id}`, 'Role implementer, model opus', 'docs/context-pack.md', 'size L, 120 requests', 'At 180 requests (150 percent) stop', 'scripts/slice-check.sh', 'Pilot-Session: sess-1', `Pilot-Agent: implementer-${t.id.toLowerCase()}-f1`, '1. One command, one round trip.', 'untrusted data']) assert.ok(brief.includes(want), want);
  assert.throws(() => f.renderBrief('{{ticket}} {{nope}}', { ticket: 'T-1' }), /no value for \{\{nope\}\}/);
  assert.throws(() => f.renderBrief('{{ticket}}', { ticket: 'T-1', extra: 1 }), /does not use extra/);
});

test('dry-run CLI: prints the plan, writes nothing, refuses unknown arguments; models come from the role files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-'));
  try {
    const file = join(dir, 'tickets.json');
    const t = ticket({ tags: ['rank-01'] }, ['ESTIMATE size S']);
    writeFileSync(file, JSON.stringify({ items: [t, ticket({}, [])] }));
    const out = execFileSync(process.execPath, [FACTORY, '--tickets', file, '--budget', '100', '--briefs', '--session', 'sess-2'], { encoding: 'utf8' });
    assert.match(out, /^factory \(dry run\): 1 to dispatch; in flight 0 of 5; requests 25 of 100/);
    assert.match(out, new RegExp(`would dispatch ${t.id}-F1 rank-01 size S budget 25 \\(stop at 38\\) implementer/opus ticket/${t.id}-`));
    assert.match(out, /skip T-\d+: no ESTIMATE/);
    assert.match(out, /would comment "FACTORY DISPATCH /);
    assert.match(out, /Pilot-Session: sess-2/);
    const json = JSON.parse(execFileSync(process.execPath, [FACTORY, '--tickets', file, '--json'], { encoding: 'utf8' }));
    assert.equal(json.dispatch[0].model, 'opus');
    const bad = spawnSync(process.execPath, [FACTORY, '--tickets', file, '--apply'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown argument --apply \(this engine is dry only\)/);
    assert.equal(spawnSync(process.execPath, [FACTORY], { encoding: 'utf8' }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
