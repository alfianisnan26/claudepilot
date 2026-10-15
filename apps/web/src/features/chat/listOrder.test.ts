import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildListView, type ChatSession } from '@portal/contracts';
import { canFold, chipCounts, defaultChip, ofProgram, programCounts, programInput, statusGroup, statusOf, STATUS_ORDER, visibleChips, withChange, withDefaultChip, type ChipChoice } from './listOrder';

const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
let n = 0;
function s(over: Partial<ChatSession> & { min?: number } = {}): ChatSession {
  const { min = n, ...rest } = over;
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
    createdAt: at(min),
    lastActivityAt: at(min),
    endedReason: null,
    claudeId: '',
    claudeName: null,
    previousClaudes: [],
    parentId: null,
    ticketId: null,
    worktree: null,
    pinnedAt: null,
    archivedAt: null,
    ...rest,
  } as ChatSession;
}

test('the order of attention: Needs you, In progress, Idle, Pinned, Ended', () => {
  assert.deepEqual(STATUS_ORDER, ['attention', 'working', 'idle', 'pinned', 'ended']);
});

test('the page opens on the first chip with sessions, All when there is none', () => {
  const pin = at(0);
  const waiting = s({ state: 'waiting', waiting: 1 });
  const working = s({ state: 'working' });
  const idle = s();
  const pinnedEnded = s({ state: 'ended', pinnedAt: pin });
  const ended = s({ state: 'ended' });
  assert.equal(defaultChip(chipCounts([idle, working, waiting, ended])), 'attention');
  assert.equal(defaultChip(chipCounts([idle, working, ended])), 'working');
  assert.equal(defaultChip(chipCounts([idle, ended, pinnedEnded])), 'idle', 'Idle before Pinned');
  assert.equal(defaultChip(chipCounts([pinnedEnded, ended])), 'pinned');
  assert.equal(defaultChip(chipCounts([ended])), 'ended');
  assert.equal(defaultChip(chipCounts([])), 'all');
  assert.equal(defaultChip(chipCounts([s({ state: 'waiting', waiting: 1, archivedAt: pin })])), 'all', 'archived sessions do not count');
  assert.equal(defaultChip(chipCounts([s({ state: 'ended', endedReason: 'credential: a key in a tool result' })])), 'attention', 'ended for safety needs you');
});

test('T-321: the default chip follows the counts until the person picks one, and a pending default never undoes the pick', () => {
  const waiting = s({ state: 'waiting', waiting: 1 });
  const idle = s();
  const start: ChipChoice = { filter: 'attention', archived: false, picked: false };
  // Before a pick the default applies, and moves with the counts.
  assert.equal(withDefaultChip(start, chipCounts([idle])).filter, 'idle');
  assert.equal(withDefaultChip(withDefaultChip(start, chipCounts([idle])), chipCounts([idle, waiting])).filter, 'attention');
  // The updates in the order React runs them when All is tapped right after the list first shows: the tap's, then the default of the
  // effect still pending from the render before the tap (its "not picked" is stale). The tap stands.
  const counts = chipCounts([idle, waiting]);
  const queue = [(v: ChipChoice) => withChange(v, { archived: false, filter: 'all' }), (v: ChipChoice) => withDefaultChip(v, counts)];
  const after = queue.reduce((v, update) => update(v), withDefaultChip(start, counts));
  assert.deepEqual(after, { filter: 'all', archived: false, picked: true });
  // Archived is a pick too; a search is not.
  assert.equal(withChange(start, { archived: true, filter: 'all' }).picked, true);
  assert.equal(withChange({ ...start, query: 'x' }, { query: 'y' }).picked, false);
  assert.equal(withDefaultChip(withChange(start, { archived: true }), chipCounts([idle])).filter, 'attention', 'kept as it was, not re-defaulted');
});

test('a chip shows only when it has sessions; Pinned and All always, the chip you are on stays, Archived before All', () => {
  const counts = chipCounts([s(), s({ state: 'ended' })]);
  assert.deepEqual(visibleChips(counts, 'idle'), ['idle', 'pinned', 'ended', 'all']);
  assert.deepEqual(visibleChips(counts, 'attention'), ['attention', 'idle', 'pinned', 'ended', 'all'], 'the chip you are on, even empty');
  const more = chipCounts([s({ state: 'waiting', waiting: 2 }), s({ state: 'starting' }), s({ state: 'ended', archivedAt: at(1) })]);
  assert.deepEqual(visibleChips(more, 'attention'), ['attention', 'working', 'pinned', 'archived', 'all']);
  assert.deepEqual(visibleChips(chipCounts([]), 'all'), ['pinned', 'all']);
});

test('counts: Pinned overlaps the others, starting counts as in progress, archived apart', () => {
  const c = chipCounts([s({ state: 'starting' }), s({ state: 'working', pinnedAt: at(0) }), s({ state: 'interrupted' }), s({ state: 'ended', archivedAt: at(0) })]);
  assert.deepEqual(c, { attention: 1, working: 2, idle: 0, pinned: 1, ended: 0, all: 3, archived: 1 });
});

test('each session sits under one heading in All: what matters most wins, a calm pin goes under Pinned', () => {
  const pin = at(0);
  assert.equal(statusOf(s({ state: 'waiting', waiting: 1, pinnedAt: pin })), 'attention');
  assert.equal(statusOf(s({ state: 'interrupted' })), 'attention');
  assert.equal(statusOf(s({ state: 'working', pinnedAt: pin })), 'working');
  assert.equal(statusOf(s({ state: 'idle', pinnedAt: pin })), 'pinned');
  assert.equal(statusOf(s({ state: 'ended', pinnedAt: pin })), 'pinned');
  assert.equal(statusOf(s({ state: 'idle' })), 'idle');
  assert.equal(statusOf(s({ state: 'ended' })), 'ended');
  assert.equal(statusOf(s({ state: 'ended', endedReason: 'integrity: the transcript does not match' })), 'attention');
});

test('All grouped: the headings in the order of attention with their counts, a pinned row leads its heading, a child of another heading sits under a header for its parent', () => {
  const pin = at(0);
  const parent = s({ id: 'parent', state: 'idle', min: 1 });
  const list = [
    s({ id: 'ended', state: 'ended', min: 0 }),
    s({ id: 'idle-new', state: 'idle', min: 0 }),
    parent,
    s({ id: 'child-waiting', state: 'waiting', waiting: 1, parentId: 'parent', min: 9 }),
    s({ id: 'working', state: 'working', min: 5 }),
    s({ id: 'working-pinned', state: 'working', pinnedAt: pin, min: 50 }),
    s({ id: 'calm-pin', state: 'idle', pinnedAt: pin, min: 3 }),
  ];
  const view = buildListView(list, { groupOf: statusGroup });
  assert.deepEqual(
    view.groups.map((g) => [g.key, g.title, g.count]),
    [
      ['attention', 'Needs you', 1],
      ['working', 'In progress', 2],
      ['idle', 'Idle', 2],
      ['pinned', 'Pinned', 1],
      ['ended', 'Ended', 1],
    ],
  );
  const rows = (key: string) => view.groups.find((g) => g.key === key)!.rows.map((r) => r.session.id);
  assert.deepEqual(rows('working'), ['working-pinned', 'working'], 'the pinned row leads, though older');
  assert.deepEqual(rows('idle'), ['idle-new', 'parent']);
  // Its parent is under another heading: it sits under a header for it (T-369), which the heading does not count.
  const header = view.groups[0]!.rows[0]!;
  assert.deepEqual([header.session.id, header.context], ['parent', true]);
  assert.equal(header.children[0]!.session.id, 'child-waiting');
  assert.equal(header.children[0]!.parentTitle, null);
  assert.equal(view.groups.find((g) => g.key === 'idle')!.rows[1]!.rollup?.waiting, 1, 'the parent still counts what it started');
});

test('an empty heading is not shown; Needs you never folds', () => {
  const view = buildListView([s({ state: 'idle' }), s({ state: 'ended' })], { groupOf: statusGroup });
  assert.deepEqual(view.groups.map((g) => g.key), ['idle', 'ended']);
  assert.equal(canFold('attention'), false);
  assert.ok(STATUS_ORDER.filter((k) => k !== 'attention').every(canFold));
});

test('the program filter (T-259 slice 3): the programs by name with their counts; a program keeps only its chats, null keeps all', () => {
  const kg = (program: string | null) => ({ keepGoing: { program } as ChatSession['keepGoing'] });
  const list = [s(kg('event')), s(kg('konfersi')), s(kg('event')), s(), s(kg(null))];
  assert.deepEqual(programCounts(list), [
    { program: 'event', count: 2 },
    { program: 'konfersi', count: 1 },
  ]);
  assert.deepEqual(ofProgram(list, 'event').map((x) => x.id), [list[0]!.id, list[2]!.id]);
  assert.equal(ofProgram(list, null).length, 5);
  assert.deepEqual(ofProgram(list, 'gone'), []);
  assert.deepEqual(programCounts([s()]), []);
});

test('a program as typed in Session info: trimmed and lowercased; empty is none; anything else is refused', () => {
  assert.equal(programInput('  Event '), 'event');
  assert.equal(programInput(''), null);
  assert.equal(programInput('   '), null);
  assert.equal(programInput('two words'), undefined);
  assert.equal(programInput('-lead'), undefined);
  assert.equal(programInput('a'.repeat(41)), undefined);
});
