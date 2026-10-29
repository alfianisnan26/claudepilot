import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSession } from '@portal/contracts';
import {
  atBottom,
  authorOf,
  authorsOf,
  dayKey,
  dayLabel,
  CHANNEL_START,
  lastId,
  mergeMessages,
  readChannel,
  reasonOf,
  scrollTarget,
  settleChannel,
  tabWrap,
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

const page = (ids: number[], more = false) => ({ items: ids.map((i) => msg(i, 'a')), more });

test('a failed read is an error with its reason, never an empty channel', () => {
  const failed = settleChannel(CHANNEL_START, { failed: new Error('Not found') });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'Not found');
  assert.deepEqual(failed.messages, []);
  assert.notEqual(failed.status, 'ready', 'an empty list after a failure is not "no messages"');
  // A reason is always words: a blank error, a string, a thing that is not an error.
  assert.equal(reasonOf(new Error('  ')), 'The portal did not answer.');
  assert.equal(reasonOf('Too many requests'), 'Too many requests');
  assert.equal(reasonOf({ code: 1 }), 'The portal did not answer.');
  assert.equal(reasonOf(undefined), 'The portal did not answer.');
});

test('a failed re-read keeps what was read before and says it failed; the next good read clears the reason', () => {
  const ready = settleChannel(CHANNEL_START, { ok: [msg(1, 'a'), msg(2, 'a')] });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.reason, null);
  const failed = settleChannel(ready, { failed: new Error('Could not reach the server.') });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(
    failed.messages.map((m) => m.id),
    [1, 2],
  );
  const again = settleChannel(failed, { ok: [msg(3, 'a')] });
  assert.deepEqual([again.status, again.reason, again.messages.map((m) => m.id)], ['ready', null, [1, 2, 3]]);
});

test('an empty channel that read fine is ready with no messages (the empty state), not failed', () => {
  const empty = settleChannel(CHANNEL_START, { ok: [] });
  assert.deepEqual([empty.status, empty.messages.length, empty.reason], ['ready', 0, null]);
});

test('readChannel goes on from the newest id known, page after page, and stops at the end', async () => {
  const asked: number[] = [];
  const pages = [page([1, 2], true), page([3, 4], true), page([5], false)];
  const load = await readChannel(async (after) => (asked.push(after), pages.shift()!), []);
  assert.deepEqual(asked, [0, 2, 4]);
  assert.deepEqual([load.status, load.messages.map((m) => m.id)], ['ready', [1, 2, 3, 4, 5]]);
  const re = await readChannel(async (after) => (asked.push(after), page([6])), load.messages);
  assert.equal(asked.at(-1), 5, 'a re-read asks only after the newest known');
  assert.equal(re.messages.length, 6);
});

test('readChannel: a page that fails fails the read, keeping the pages before it; a stuck "more" with nothing returned stops', async () => {
  let calls = 0;
  const half = await readChannel(async () => {
    if (++calls === 2) throw new Error('Gateway timeout');
    return page([1, 2], true);
  }, []);
  assert.deepEqual([half.status, half.reason, half.messages.map((m) => m.id)], ['failed', 'Gateway timeout', [1, 2]]);
  const never = await readChannel(async () => ({ items: [], more: true }), []);
  assert.equal(never.status, 'ready', 'no items returned ends the loop, never a spin');
  let capped = 0;
  await readChannel(async (after) => (capped++, { items: [msg(after + 1, 'a')], more: true }), [], 3);
  assert.equal(capped, 3, 'at most maxPages reads');
});

test('scroll: the first open goes to the newest; a reader already at the end stays there; a reader above it is left alone', () => {
  const now = { rowTop: null, scrollHeight: 4000, clientHeight: 500 };
  assert.equal(scrollTarget('bottom', now), 3500);
  assert.equal(scrollTarget('bottom', { ...now, scrollHeight: 300 }), 0, 'content shorter than the view: the top');
  assert.equal(scrollTarget(null, now), null);
  assert.equal(atBottom(3500, 500, 4000), true);
  assert.equal(atBottom(3470, 500, 4000), true, 'within the slack');
  assert.equal(atBottom(3000, 500, 4000), false);
});

test('scroll: older messages joining above keep the message being read exactly where it was', () => {
  // Reading the row `m31` 268 px below the top of the view (scrollTop 0); 30 older rows of 90 px join above it: its top moves from 268 to 2968.
  const anchor = { key: 'm31', offset: 268, scrollTop: 0, scrollHeight: 3977 };
  const after = scrollTarget(anchor, { rowTop: 2968, scrollHeight: 6677, clientHeight: 560 });
  assert.equal(after, 2700, 'the row sits 268 px below the top again');
  // The row is gone (folded away): the growth of the content is what was added above.
  assert.equal(
    scrollTarget({ key: null, offset: 0, scrollTop: 120, scrollHeight: 3977 }, { rowTop: null, scrollHeight: 6677, clientHeight: 560 }),
    2820,
  );
  assert.equal(
    scrollTarget({ ...anchor, key: 'gone' }, { rowTop: null, scrollHeight: 6677, clientHeight: 560 }),
    2700,
    'a lost row falls back to the growth',
  );
});

test('Tab stays inside the popover: past the last stop to the first, Shift+Tab before the first to the last', () => {
  assert.equal(tabWrap(2, 3, false), 0);
  assert.equal(tabWrap(0, 3, true), 2);
  assert.equal(tabWrap(-1, 3, true), 2, 'focus on the container itself');
  assert.equal(tabWrap(1, 3, false), null, 'inside: the browser moves');
  assert.equal(tabWrap(1, 3, true), null);
  assert.equal(tabWrap(0, 1, false), 0, 'a single stop keeps focus');
  assert.equal(tabWrap(0, 0, false), null, 'nothing to trap');
});
