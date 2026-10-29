import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSession } from '@portal/contracts';
import {
  authorOf,
  authorsOf,
  dayKey,
  dayLabel,
  lastId,
  mergeMessages,
  tail,
  THREAD_PAGE,
  threadCount,
  threadOf,
  type CrewMessage,
} from './crewThread';

// A fixed clock and local-time dates: no test depends on the real day or the machine's zone.
const NOW = new Date(2026, 9, 29, 15, 0, 0);
const local = (day: number, hour: number) => new Date(2026, 9, day, hour, 0, 0).toISOString();
const msg = (id: number, from: string, text = `m${id}`, at = local(29, 9)): CrewMessage => ({ id, from, text, at });
const sess = (id: string, over: Partial<ChatSession> = {}) =>
  ({ id, title: `T ${id}`, agent: null, createdAt: local(28, 1), ...over }) as ChatSession;

test('messages merge by id, each once, oldest first; a re-read of a page changes nothing', () => {
  const known = [msg(1, 'a'), msg(2, 'b')];
  const merged = mergeMessages(known, [msg(2, 'b', 'edited'), msg(3, 'a')]);
  assert.deepEqual(
    merged.map((m) => m.id),
    [1, 2, 3],
  );
  assert.equal(merged[1]!.text, 'edited', 'the newer read wins');
  assert.deepEqual(mergeMessages(merged, merged), merged);
  assert.deepEqual(
    mergeMessages([msg(5, 'a'), msg(2, 'a')], []).map((m) => m.id),
    [2, 5],
    'sorted by id, not by arrival',
  );
  assert.deepEqual(
    known.map((m) => m.id),
    [1, 2],
    'the input is not changed',
  );
});

test('the next read goes on from the newest id known, 0 for none', () => {
  assert.equal(lastId([]), 0);
  assert.equal(lastId([msg(4, 'a'), msg(9, 'a'), msg(7, 'a')]), 9);
});

test('authors: the lead and its workers by id, their roles from `agent`, an unknown id is a worker the portal no longer lists', () => {
  const authors = authorsOf(sess('L', { title: 'Konfersi lead', agent: 'lead' }), [
    sess('w1', { title: 'Fix login', agent: 'implementer' }),
    sess('w2', { title: '  ', agent: '  ' }),
  ]);
  assert.deepEqual(authorOf(authors, 'L'), { id: 'L', name: 'Konfersi lead', role: 'lead', isLead: true, known: true });
  assert.deepEqual(authorOf(authors, 'w1'), { id: 'w1', name: 'Fix login', role: 'implementer', isLead: false, known: true });
  assert.deepEqual(
    authorOf(authors, 'w2'),
    { id: 'w2', name: 'Untitled', role: null, isLead: false, known: true },
    'a blank title and role say nothing',
  );
  assert.deepEqual(authorOf(authors, 'gone'), { id: 'gone', name: 'Worker', role: null, isLead: false, known: false });
  // The lead not read yet (a worker's page): its messages still show, as a worker the portal does not list.
  assert.equal(authorOf(authorsOf(null, []), 'L').known, false);
});

test('the thread: one name per run of one author, a heading when the day changes, a new run after a day change', () => {
  const authors = authorsOf(sess('L'), [sess('w1'), sess('w2')]);
  const messages = [
    msg(1, 'w1', 'a', local(27, 22)),
    msg(2, 'w1', 'b', local(28, 8)),
    msg(3, 'w1', 'c', local(28, 9)),
    msg(4, 'w2', 'd', local(28, 10)),
    msg(5, 'L', 'e', local(29, 9)),
    msg(6, 'L', 'f', local(29, 10)),
  ];
  const entries = threadOf(messages, authors, NOW);
  assert.deepEqual(
    entries.map((e) => (e.kind === 'day' ? `# ${e.label}` : `${e.id}${e.first ? '*' : ''}`)),
    [`# ${dayLabel(dayKey(local(27, 22)), NOW)}`, '1*', '# Yesterday', '2*', '3', '4*', '# Today', '5*', '6'],
  );
  const five = entries.find((e) => e.kind === 'message' && e.id === 5);
  assert.equal(five?.kind === 'message' && five.author.isLead, true);
});

test('the same author on two days starts a run again under the new day heading', () => {
  const authors = authorsOf(sess('L'), [sess('w1')]);
  const entries = threadOf([msg(1, 'w1', 'a', local(28, 23)), msg(2, 'w1', 'b', local(29, 0))], authors, NOW);
  const firsts = entries.filter((e) => e.kind === 'message').map((e) => e.kind === 'message' && e.first);
  assert.deepEqual(firsts, [true, true]);
});

test('a message with no readable time joins the day before it and never starts a heading of its own', () => {
  const authors = authorsOf(sess('L'), [sess('w1')]);
  const entries = threadOf([msg(1, 'w1', 'a', local(29, 9)), msg(2, 'w1', 'b', 'not a time')], authors, NOW);
  assert.deepEqual(
    entries.map((e) => e.kind),
    ['day', 'message', 'message'],
  );
  assert.equal(threadOf([], authors, NOW).length, 0, 'an empty channel is an empty thread');
});

test('the day label: Today, Yesterday, else the date (the year only when it is not this one)', () => {
  assert.equal(dayLabel(dayKey(NOW), NOW), 'Today');
  assert.equal(dayLabel(dayKey(new Date(2026, 9, 28, 23, 59)), NOW), 'Yesterday');
  assert.equal(dayLabel(dayKey(new Date(2026, 8, 30)), new Date(2026, 9, 1, 8)), 'Yesterday', 'across a month end');
  assert.match(dayLabel('2026-03-04', NOW), /4/);
  assert.doesNotMatch(dayLabel('2026-03-04', NOW), /2026/);
  assert.match(dayLabel('2025-03-04', NOW), /2025/);
  assert.equal(dayLabel('garbage', NOW), '');
  assert.equal(dayKey('garbage'), '');
});

test('the newest messages stay in sight and the older ones are counted for the "Earlier" row', () => {
  const all = Array.from({ length: 70 }, (_, i) => msg(i + 1, 'a'));
  const first = tail(all, THREAD_PAGE);
  assert.equal(first.items.length, THREAD_PAGE);
  assert.equal(first.items[0]!.id, 41);
  assert.equal(first.items.at(-1)!.id, 70);
  assert.equal(first.older, 40);
  assert.equal(tail(all, THREAD_PAGE * 3).older, 0, 'asking for more than there is shows all');
  assert.equal(tail(all, THREAD_PAGE * 3).items.length, 70);
  assert.deepEqual(tail([], 30), { items: [], older: 0 });
  assert.equal(tail(all, 0).items.length, 0);
  assert.equal(tail(all, -5).older, 70, 'a negative count shows none, never everything');
});

test('the count in words, for a screen reader and the tip', () => {
  assert.equal(threadCount(1), '1 crew message');
  assert.equal(threadCount(3), '3 crew messages');
});
