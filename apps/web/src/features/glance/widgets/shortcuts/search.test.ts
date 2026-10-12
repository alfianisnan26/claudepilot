import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreItem, searchPalette, suggest, ticketByNumber, words, type PaletteItem } from './search.js';

const item = (over: Partial<PaletteItem> & { id: string; title: string }): PaletteItem => ({ kind: 'session', hint: '', to: `/x/${over.id}`, ...over });

// A small portal: two actions, two pages, four sessions (used 1 h, 2 h, 3 h and 4 days ago), a workspace and a ticket.
const H = 3_600_000;
const NOW = Date.parse('2026-10-12T12:00:00Z');
const catalogue: PaletteItem[] = [
  item({ id: 'a:new', kind: 'action', title: 'New session', hint: '', keywords: 'create start chat' }),
  item({ id: 'a:attn', kind: 'action', title: 'Needs attention' }),
  item({ id: 'p:sessions', kind: 'page', title: 'Sessions' }),
  item({ id: 'p:tickets', kind: 'page', title: 'Tickets' }),
  item({ id: 's1', title: 'Fix the tests', hint: 'Working · api-dev', keywords: 'Satria docker/api-dev', recent: NOW - H }),
  item({ id: 's2', title: 'Refactor auth', hint: 'Idle · api-dev', keywords: 'Default', recent: NOW - 2 * H }),
  item({ id: 's3', title: 'Tests: fix later', hint: 'Idle · web', recent: NOW - 3 * H }),
  item({ id: 's4', title: 'Old notes', hint: 'Ended · web', recent: NOW - 96 * H }),
  item({ id: 'w1', kind: 'workspace', title: 'api-dev', hint: 'Shell' }),
  item({ id: 't1', kind: 'ticket', title: 'Ship the new release', hint: 'Open' }),
];

test('a word scores by where it falls: exact title 120, title start 100, a title word 60, inside the title 30, beside it 10, nowhere 0', () => {
  const sc = (title: string, q: string, extra: Partial<PaletteItem> = {}) => scoreItem(item({ id: 'x', title, ...extra }), words(q));
  assert.equal(sc('Tickets', 'tickets'), 120);
  assert.equal(sc('Tickets board', 'tick'), 100);
  assert.equal(sc('Fix the tests', 'tes'), 60);
  assert.equal(sc('Retest', 'test'), 30);
  assert.equal(sc('Refactor', 'satria', { keywords: 'Satria' }), 10);
  assert.equal(sc('Refactor', 'satria', { hint: 'Satria · dev' }), 10);
  assert.equal(sc('Refactor', 'zzz'), 0);
  // every word has to be found, and they add up: "fix" starts the title (100), "tests" is a title word (60)
  assert.equal(sc('Fix the tests', 'fix tests'), 160);
  assert.equal(sc('Fix the tests', 'fix zzz'), 0);
  // a source that matched it already (a ticket found by the portal's text search) is never dropped for words it did not show
  assert.equal(sc('Ship the release', 'zzz', { matched: true }), 5);
});

test('results come best first; a tie goes to what you do, then where you go, then what you search for, then the latest used', () => {
  const found = searchPalette(catalogue, 'tests').map((i) => i.id);
  // "Fix the tests": 'tests' is a title word (60); "Tests: fix later": the title starts with it (100)
  assert.deepEqual(found, ['s3', 's1']);
  // "new": the action starts with it (100); the ticket's "Ship the new release" has a title word that does (60);
  assert.deepEqual(searchPalette(catalogue, 'new').map((i) => i.id), ['a:new', 't1']);
  // "api" is in no title: found beside two sessions (hint, 10) and as the workspace's own title (100)
  assert.deepEqual(searchPalette(catalogue, 'api').map((i) => i.id), ['w1', 's1', 's2']);
  // "sess": the page "Sessions" starts with it (100); the action "New session" has a title word that does (60)
  assert.deepEqual(searchPalette(catalogue, 'sess').map((i) => i.id), ['p:sessions', 'a:new']);
  // nothing matches
  assert.deepEqual(searchPalette(catalogue, 'qqqq'), []);
});

test('a ticket the portal found for these words stays in the list even when they are not in what the row shows, below real matches', () => {
  const found = [...catalogue, item({ id: 't2', kind: 'ticket', title: 'Rollout plan', hint: 'Open', matched: true })];
  // "release" is in t1's title (60 as a title word) and in nothing t2 shows: t2 was matched on its description by the portal (5)
  assert.deepEqual(searchPalette(found, 'release').map((i) => i.id), ['t1', 't2']);
});

test('ties: an action before a page before a session; sessions by the latest use', () => {
  const same = [
    item({ id: 'ss', title: 'Deploy', kind: 'session', recent: NOW - H }),
    item({ id: 'sa', title: 'Deploy', kind: 'session', recent: NOW - 5 * H }),
    item({ id: 'pg', title: 'Deploy', kind: 'page' }),
    item({ id: 'ac', title: 'Deploy', kind: 'action' }),
  ];
  assert.deepEqual(searchPalette(same, 'deploy').map((i) => i.id), ['ac', 'pg', 'ss', 'sa']);
});

test('one kind cannot fill the list: at most six of a kind and twelve in all', () => {
  const many = Array.from({ length: 30 }, (_, i) => item({ id: `s${i}`, title: `Build ${i}`, recent: NOW - i * H }));
  const found = searchPalette([...many, item({ id: 'p', kind: 'page', title: 'Builds' })], 'build');
  assert.equal(found.filter((i) => i.kind === 'session').length, 6);
  assert.ok(found.some((i) => i.id === 'p'), 'the page is not pushed out');
  assert.equal(found.length, 7);
  // the six kept are the best by score and then the most recent: all score 100, so s0..s5
  assert.deepEqual(found.filter((i) => i.kind === 'session').map((i) => i.id), ['s0', 's1', 's2', 's3', 's4', 's5']);
});

test('with nothing typed: the actions, the five sessions used last, then the pages', () => {
  const six = [...catalogue, item({ id: 's5', title: 'Another', recent: NOW - 5 * H }), item({ id: 's6', title: 'Yet another', recent: NOW - 6 * H })];
  assert.deepEqual(searchPalette(six, '').map((i) => i.id), ['a:new', 'a:attn', 's1', 's2', 's3', 's5', 's6', 'p:sessions', 'p:tickets']);
  assert.deepEqual(suggest(catalogue, { limit: 3 }).map((i) => i.id), ['a:new', 'a:attn', 's1']);
  assert.deepEqual(searchPalette(catalogue, '   ').map((i) => i.id), suggest(catalogue).map((i) => i.id));
});

test('a ticket number typed finds the ticket by its number', () => {
  assert.deepEqual(ticketByNumber('T-12'), { id: 'ticket:T-12', kind: 'ticket', title: 'T-12', hint: 'Open ticket', to: '/admin/tickets/T-12', matched: true });
  assert.equal(ticketByNumber(' t12 ')?.to, '/admin/tickets/T-12');
  assert.equal(ticketByNumber('T-007')?.title, 'T-7');
  assert.equal(ticketByNumber('12'), null, 'a bare number is a search, not a ticket');
  assert.equal(ticketByNumber('tests'), null);
  assert.equal(ticketByNumber('T-12 fix'), null);
});
