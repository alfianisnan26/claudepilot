import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildListView, type ChatSession, type ListRow, type Rollup } from '@portal/contracts';
import { bySpawn, crewCount, crewOfRows, crewOfSessions, crewStatusGroup, fromLead, isDone, otherClaude } from './crew';
import { chipCounts } from './listOrder';

const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
let n = 0;
/** A session; `born` is when it started (minutes ago), `min` its latest activity. */
function s(over: Partial<ChatSession> & { min?: number; born?: number } = {}): ChatSession {
  const { min = n, born = min, ...rest } = over;
  n++;
  return {
    id: `s${n}`,
    workspaceId: 'docker/ws',
    cwd: '/home/node',
    title: `S ${n}`,
    state: 'idle',
    origin: 'ui',
    model: null,
    mode: 'default',
    effort: null,
    ultracode: false,
    ultracodeAvailable: false,
    process: 'gone',
    context: null,
    costUsd: 0,
    turns: 0,
    lastSeq: 0,
    waiting: 0,
    waitingFor: null,
    agentsRunning: 0,
    createdAt: at(born),
    lastActivityAt: at(min),
    endedReason: null,
    claudeId: '',
    claudeName: 'Default',
    previousClaudes: [],
    parentId: null,
    ticketId: null,
    worktree: null,
    pinnedAt: null,
    archivedAt: null,
    ...rest,
  } as ChatSession;
}

const ids = (rows: readonly ListRow[]) => rows.map((r) => r.session.id);
const heading = (view: ReturnType<typeof buildListView>, key: string) => view.groups.find((g) => g.key === key);

test('All: a worker sits under its lead, in the lead’s heading; the chips still count each session by its own state', () => {
  const lead = s({ id: 'lead', state: 'idle', born: 60, min: 1 });
  const list = [
    lead,
    s({ id: 'w-working', state: 'working', parentId: 'lead', born: 50, min: 0 }),
    s({ id: 'w-idle', state: 'idle', parentId: 'lead', born: 40, min: 2 }),
    s({ id: 'w-ended', state: 'ended', parentId: 'lead', born: 30, min: 3 }),
    s({ id: 'other', state: 'working', born: 10, min: 0 }),
  ];
  const view = buildListView(list, { groupOf: crewStatusGroup(list) });
  assert.deepEqual(ids(heading(view, 'idle')!.rows), ['lead'], 'no worker at the top of the list');
  assert.equal(heading(view, 'idle')!.count, 4, 'a heading counts what sits under it, the nested workers too');
  assert.deepEqual(ids(heading(view, 'working')!.rows), ['other'], 'the working worker is under its lead, not under In progress');
  assert.equal(heading(view, 'ended'), undefined, 'the ended worker is under its lead');
  const crew = crewOfRows(heading(view, 'idle')!.rows[0]!.children);
  assert.deepEqual(ids(crew.live), ['w-working', 'w-idle'], 'live in sight, in spawn order');
  assert.deepEqual(ids(crew.done), ['w-ended'], 'ended behind “1 done”');
  assert.deepEqual(chipCounts(list), { attention: 0, working: 2, idle: 2, pinned: 0, ended: 1, all: 5, archived: 0 }, 'chips unchanged');
});

test('All: a worker that needs you keeps Needs you, with “from” its lead; a calm chain follows its top lead', () => {
  const root = s({ id: 'root', state: 'working', born: 90 });
  const mid = s({ id: 'mid', state: 'idle', parentId: 'root', born: 80 });
  const leaf = s({ id: 'leaf', state: 'idle', parentId: 'mid', born: 70 });
  const asks = s({ id: 'asks', state: 'waiting', waiting: 1, parentId: 'mid', born: 60 });
  const list = [root, mid, leaf, asks];
  const view = buildListView(list, { groupOf: crewStatusGroup(list) });
  const needs = heading(view, 'attention')!;
  assert.deepEqual(ids(needs.rows), ['asks']);
  assert.deepEqual(fromLead(needs.rows[0]!), { id: 'mid', title: mid.title });
  const working = heading(view, 'working')!;
  assert.deepEqual(ids(working.rows), ['root']);
  assert.deepEqual(ids(working.rows[0]!.children), ['mid']);
  assert.deepEqual(ids(working.rows[0]!.children[0]!.children), ['leaf']);
  assert.equal(working.rows[0]!.rollup?.waiting, 1, 'the lead still counts the one that waits');
});

test('orphan: a worker whose lead is archived, filtered out or not found stays at the top of its own heading, “from” its lead when known', () => {
  const archivedLead = s({ id: 'gone-lead', state: 'ended', archivedAt: at(1), title: 'Old lead' });
  const w1 = s({ id: 'w1', state: 'idle', parentId: 'gone-lead' });
  const w2 = s({ id: 'w2', state: 'working', parentId: 'missing' });
  const lead = s({ id: 'lead', state: 'idle', title: 'Release lead' });
  const w3 = s({ id: 'w3', state: 'working', parentId: 'lead', title: 'worker three' });
  const list = [archivedLead, w1, w2, lead, w3];
  const view = buildListView(list, { groupOf: crewStatusGroup(list) });
  assert.deepEqual(ids(heading(view, 'idle')!.rows).sort(), ['lead', 'w1'], 'the worker of an archived lead is at the top of Idle');
  assert.deepEqual(ids(heading(view, 'idle')!.rows.find((r) => r.session.id === 'lead')!.children), ['w3'], 'a lead in the list takes its worker');
  const w1Row = heading(view, 'idle')!.rows.find((r) => r.session.id === 'w1')!;
  assert.deepEqual(fromLead(w1Row), { id: 'gone-lead', title: 'Old lead' }, 'an archived lead is linked');
  const w2Row = heading(view, 'working')!.rows.find((r) => r.session.id === 'w2')!;
  assert.equal(fromLead(w2Row), null, 'a lead the list does not have names nothing');
  // A search its lead does not match: the worker keeps its own heading (In progress), with "from".
  const searched = buildListView(list, { query: 'three', groupOf: crewStatusGroup(list, 'three') });
  assert.deepEqual(searched.groups.map((g) => [g.key, ids(g.rows)]), [['working', ['w3']]]);
  assert.deepEqual(fromLead(searched.groups[0]!.rows[0]!), { id: 'lead', title: 'Release lead' });
});

test('chips: a worker that matches while its lead does not is a top-level row with “from”; with its lead matching too it nests', () => {
  const lead = s({ id: 'lead', state: 'idle', born: 30 });
  const waiting = s({ id: 'waiting', state: 'waiting', waiting: 1, parentId: 'lead', born: 20 });
  const idleWorker = s({ id: 'idle-w', state: 'idle', parentId: 'lead', born: 10 });
  const list = [lead, waiting, idleWorker];
  const needsYou = buildListView(list, { filter: 'attention' });
  assert.deepEqual(needsYou.groups.map((g) => ids(g.rows)), [['waiting']], 'the matching worker only, not its lead as context');
  assert.deepEqual(fromLead(needsYou.groups[0]!.rows[0]!), { id: 'lead', title: lead.title });
  assert.equal(chipCounts(list).attention, 1, 'the chip counts the row it shows');
  const idle = buildListView(list, { filter: 'idle' });
  assert.deepEqual(ids(idle.groups[0]!.rows), ['lead']);
  assert.deepEqual(ids(idle.groups[0]!.rows[0]!.children), ['idle-w']);
  assert.equal(idle.groups[0]!.rows[0]!.children[0]!.parentTitle, null, 'nested: no “from”');
});

test('done: ended workers fold, one ended for safety stays in sight (it needs you)', () => {
  const ended = s({ state: 'ended', born: 3 });
  const safety = s({ state: 'ended', endedReason: 'credential: a key in a tool result', born: 2 });
  const interrupted = s({ state: 'interrupted', born: 1 });
  assert.equal(isDone(ended), true);
  assert.equal(isDone(safety), false);
  assert.equal(isDone(interrupted), false);
  const crew = crewOfSessions([interrupted, safety, ended]);
  assert.deepEqual(crew.live.map((x) => x.id), [safety.id, interrupted.id]);
  assert.deepEqual(crew.done.map((x) => x.id), [ended.id]);
});

test('order holds still: a worker does not move when it works, waits or goes idle; a new one joins at the end', () => {
  const a = s({ id: 'a', born: 30, min: 30 });
  const b = s({ id: 'b', born: 20, min: 20 });
  const c = s({ id: 'c', born: 10, min: 10 });
  const before = crewOfSessions([c, a, b]).live.map((x) => x.id);
  assert.deepEqual(before, ['a', 'b', 'c']);
  const busy = [{ ...c, state: 'waiting', waiting: 1, lastActivityAt: at(0) }, { ...a, state: 'working', lastActivityAt: at(0) }, b] as ChatSession[];
  assert.deepEqual(crewOfSessions(busy).live.map((x) => x.id), ['a', 'b', 'c'], 'the same order');
  const d = s({ id: 'd', born: 0 });
  assert.deepEqual(crewOfSessions([d, ...busy]).live.map((x) => x.id), ['a', 'b', 'c', 'd'], 'the new one at the end');
  const born = at(5);
  assert.ok(bySpawn({ id: 'x1', createdAt: born }, { id: 'x2', createdAt: born }) < 0, 'a tie goes by id');
});

test('a worker names its Claude only when it differs from its lead’s', () => {
  assert.equal(otherClaude({ claudeName: 'Default' }, { claudeName: 'Default' }), null);
  assert.equal(otherClaude({ claudeName: 'Work' }, { claudeName: 'Default' }), 'Work');
  assert.equal(otherClaude({ claudeName: null }, { claudeName: 'Default' }), null, 'unknown names nothing');
  assert.equal(otherClaude({ claudeName: 'Work' }, null), 'Work', 'no lead to compare: its own');
});

test('a lead counts its crew: a number, warning while one needs you, the words for the tip', () => {
  assert.equal(crewCount(null), null);
  const r: Rollup = { total: 3, working: 1, waiting: 1, idle: 0, interrupted: 0, ended: 1, costUsd: 0 };
  assert.deepEqual(crewCount(r), { total: 3, tone: 'warning', label: '3 started · 1 needs you · 1 working · 1 ended' });
  assert.equal(crewCount({ ...r, waiting: 0, working: 2 })!.tone, 'neutral');
  assert.equal(crewCount({ ...r, waiting: 0, interrupted: 1 })!.tone, 'warning');
});
