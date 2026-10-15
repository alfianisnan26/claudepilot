import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildListView, type ChatSession, type ListRow, type Rollup } from '@portal/contracts';
import { bySpawn, crewCount, crewOfRows, crewOfSessions, crewStatusGroup, fromLead, isDone, otherClaude, selectable } from './crew';
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

test('All: a worker that needs you keeps Needs you, under a header for its lead (not “from”); a calm chain follows its top lead', () => {
  const root = s({ id: 'root', state: 'working', born: 90 });
  const mid = s({ id: 'mid', state: 'idle', parentId: 'root', born: 80 });
  const leaf = s({ id: 'leaf', state: 'idle', parentId: 'mid', born: 70 });
  const asks = s({ id: 'asks', state: 'waiting', waiting: 1, parentId: 'mid', born: 60 });
  const list = [root, mid, leaf, asks];
  const view = buildListView(list, { groupOf: crewStatusGroup(list) });
  const needs = heading(view, 'attention')!;
  assert.deepEqual(ids(needs.rows), ['mid'], 'its lead as a header');
  assert.equal(needs.rows[0]!.context, true);
  assert.deepEqual(ids(needs.rows[0]!.children), ['asks']);
  assert.equal(fromLead(needs.rows[0]!.children[0]!), null, 'the header names the lead, no “from”');
  assert.equal(needs.count, 1, 'the heading counts the worker, not the header');
  const working = heading(view, 'working')!;
  assert.deepEqual(ids(working.rows), ['root']);
  assert.deepEqual(ids(working.rows[0]!.children), ['mid']);
  assert.deepEqual(ids(working.rows[0]!.children[0]!.children), ['leaf']);
  assert.equal(working.rows[0]!.rollup?.waiting, 1, 'the lead still counts the one that waits');
});

test('orphan: a worker whose lead is archived or not found stays at the top of its own heading, “from” an archived lead; a search its lead misses gives a header', () => {
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
  // A search its lead does not match: the worker keeps its own heading (In progress), under a header for its lead.
  const searched = buildListView(list, { query: 'three', groupOf: crewStatusGroup(list, 'three') });
  assert.deepEqual(searched.groups.map((g) => [g.key, ids(g.rows), g.count]), [['working', ['lead'], 1]]);
  assert.equal(searched.groups[0]!.rows[0]!.context, true);
  assert.deepEqual(ids(searched.groups[0]!.rows[0]!.children), ['w3']);
  assert.equal(fromLead(searched.groups[0]!.rows[0]!.children[0]!), null);
  assert.equal(searched.shown, 1, 'the search shows one session');
});

test('chips: a worker that matches while its lead does not sits under a lead header; with its lead matching too it nests', () => {
  const lead = s({ id: 'lead', state: 'idle', born: 30 });
  const waiting = s({ id: 'waiting', state: 'waiting', waiting: 1, parentId: 'lead', born: 20 });
  const idleWorker = s({ id: 'idle-w', state: 'idle', parentId: 'lead', born: 10 });
  const list = [lead, waiting, idleWorker];
  const needsYou = buildListView(list, { filter: 'attention' });
  assert.deepEqual(needsYou.groups.map((g) => ids(g.rows)), [['lead']], 'the lead as a header');
  assert.equal(needsYou.groups[0]!.rows[0]!.context, true);
  assert.deepEqual(ids(needsYou.groups[0]!.rows[0]!.children), ['waiting'], 'only the matching worker under it');
  assert.equal(fromLead(needsYou.groups[0]!.rows[0]!.children[0]!), null);
  assert.equal(chipCounts(list).attention, 1, 'the chip counts the worker, not the header');
  assert.deepEqual(selectable(needsYou.groups[0]!.rows).map((x) => x.id), ['waiting'], 'Select all takes the worker only');
  const idle = buildListView(list, { filter: 'idle' });
  assert.deepEqual(ids(idle.groups[0]!.rows), ['lead']);
  assert.deepEqual(ids(idle.groups[0]!.rows[0]!.children), ['idle-w']);
  assert.equal(idle.groups[0]!.rows[0]!.children[0]!.parentTitle, null, 'nested: no “from”');
});

// T-369 (the owner, 2026-10-15): the In progress chip while a lead waits idle for its workers' reports showed them as flat rows "from" it.
test('T-369: In progress with the lead idle: its working workers sit under one lead header, in spawn order, where the first would sit', () => {
  const solo1 = s({ id: 'solo1', state: 'working', min: 1, born: 100 });
  const lead = s({ id: 'lead', state: 'idle', title: 'Konfersi: migration', min: 30, born: 90 });
  const wa = s({ id: 'wa', state: 'working', parentId: 'lead', min: 4, born: 80 });
  const wb = s({ id: 'wb', state: 'working', parentId: 'lead', min: 2, born: 70 });
  const wIdle = s({ id: 'w-idle', state: 'idle', parentId: 'lead', min: 3, born: 60 });
  const solo3 = s({ id: 'solo3', state: 'working', min: 3, born: 50 });
  const list = [solo1, lead, wa, wb, wIdle, solo3];
  const view = buildListView(list, { filter: 'working' });
  const rows = view.groups[0]!.rows;
  assert.deepEqual(ids(rows), ['solo1', 'lead', 'solo3'], 'the header sits where its first worker (wb, 2 min ago) would sit');
  const header = rows[1]!;
  assert.equal(header.context, true);
  assert.deepEqual(ids(crewOfRows(header.children).live), ['wa', 'wb'], 'its workers in the view, in spawn order; the idle one is not in the chip');
  assert.ok(header.children.every((c) => fromLead(c) === null), 'no “from” under a header');
  assert.equal(header.rollup?.total, 3, 'the header counts the lead’s whole crew');
  assert.deepEqual([view.shown, view.groups[0]!.count, chipCounts(list).working], [4, 4, 4], 'the header is not a match: not in the counts');
  assert.deepEqual(selectable(rows).map((x) => x.id).sort(), ['solo1', 'solo3', 'wa', 'wb'], 'Select all leaves the header out');
});

test('T-369: two leads each get one header with their own workers', () => {
  const l1 = s({ id: 'l1', state: 'idle', born: 90, min: 50 });
  const l2 = s({ id: 'l2', state: 'idle', born: 80, min: 50 });
  const list = [
    l1,
    l2,
    s({ id: 'a1', state: 'working', parentId: 'l1', born: 70, min: 5 }),
    s({ id: 'b1', state: 'working', parentId: 'l2', born: 60, min: 1 }),
    s({ id: 'a2', state: 'working', parentId: 'l1', born: 50, min: 6 }),
    s({ id: 'b2', state: 'working', parentId: 'l2', born: 40, min: 7 }),
  ];
  const rows = buildListView(list, { filter: 'working' }).groups[0]!.rows;
  assert.deepEqual(ids(rows), ['l2', 'l1'], 'l2 first: its first worker is the newest');
  assert.ok(rows.every((r) => r.context));
  assert.deepEqual(ids(crewOfRows(rows[0]!.children).live), ['b1', 'b2']);
  assert.deepEqual(ids(crewOfRows(rows[1]!.children).live), ['a1', 'a2']);
});

test('T-369: a worker of a worker keeps its level under the header; a worker whose own lead is out gets a header nested in the tree', () => {
  const list = [
    s({ id: 'L', state: 'idle', born: 90 }),
    s({ id: 'W1', state: 'working', parentId: 'L', born: 80 }),
    s({ id: 'X', state: 'working', parentId: 'W1', born: 70 }),
    s({ id: 'W2', state: 'working', parentId: 'L', born: 60 }),
    s({ id: 'W3', state: 'idle', parentId: 'L', born: 50 }),
    s({ id: 'Y', state: 'working', parentId: 'W3', born: 40 }),
  ];
  const view = buildListView(list, { filter: 'working' });
  const rows = view.groups[0]!.rows;
  assert.deepEqual(ids(rows), ['L']);
  const live = crewOfRows(rows[0]!.children).live;
  assert.deepEqual(ids(live), ['W1', 'W2', 'W3'], 'spawn order under the header');
  assert.deepEqual(ids(live[0]!.children), ['X'], 'the worker of a worker stays under it');
  assert.equal(live[2]!.context, true, 'W3 is idle: a header of its own, under L');
  assert.deepEqual(ids(live[2]!.children), ['Y']);
  assert.deepEqual(selectable(rows).map((x) => x.id).sort(), ['W1', 'W2', 'X', 'Y']);
  assert.equal(view.groups[0]!.count, 4);
});

test('T-369: a worker whose lead is archived has no header and keeps “from”', () => {
  const old = s({ id: 'old', state: 'ended', archivedAt: at(1), title: 'Old lead' });
  const w = s({ id: 'w', state: 'working', parentId: 'old' });
  const rows = buildListView([old, w], { filter: 'working' }).groups[0]!.rows;
  assert.deepEqual(ids(rows), ['w']);
  assert.equal(rows[0]!.context, false);
  assert.deepEqual(fromLead(rows[0]!), { id: 'old', title: 'Old lead' });
});

test('T-369: the tree holds still when its lead flips between Idle and Working (QA A9)', () => {
  const lead = s({ id: 'lead', state: 'idle', born: 90, min: 40 });
  const list = [
    s({ id: 'newer', state: 'working', min: 1 }),
    lead,
    s({ id: 'w', state: 'working', parentId: 'lead', born: 50, min: 5 }),
    s({ id: 'older', state: 'working', min: 9 }),
  ];
  const before = buildListView(list, { filter: 'working' }).groups[0]!.rows;
  assert.deepEqual(ids(before), ['newer', 'lead', 'older']);
  assert.equal(before[1]!.context, true);
  // The lead takes a worker's report: it works, and its latest activity is now.
  const flipped = list.map((x) => (x.id === 'lead' ? { ...x, state: 'working' as const, lastActivityAt: at(0) } : x));
  const after = buildListView(flipped, { filter: 'working' }).groups[0]!.rows;
  assert.deepEqual(ids(after), ['newer', 'lead', 'older'], 'the same place');
  assert.equal(after[1]!.context, false, 'now a row of the chip');
  assert.deepEqual(ids(after[1]!.children), ['w']);
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
