// The panel's chat, composer, thread and list rules (PILOT-1111, owner feedback 2026-10-31).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReporterChatMessage, ReporterTicket, ReporterTicketComment } from '@portal/contracts';
import {
  appendPage,
  chatStatus,
  composerHeight,
  composerKey,
  groupComments,
  keyboardInset,
  mergeLines,
  needsClamp,
  newUuid,
  refreshLimit,
  relTime,
  reuseRows,
  rowThumb,
  windowRange,
} from './chatModel';

const line = (seq: number, kind: ReporterChatMessage['kind'] = 'assistant', text = `m${seq}`): ReporterChatMessage => ({ seq, at: '', kind, text, from: null, tool: null, images: [] });
const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });

test('mergeLines: live lines append in seq order, once; a repeat returns the same array (nothing re-renders)', () => {
  const cur = [line(1), line(2)];
  assert.equal(mergeLines(cur, []), cur);
  assert.equal(mergeLines(cur, [line(2)]), cur, 'only what is shown already');
  assert.deepEqual(mergeLines(cur, [line(4), line(3), line(2)]).map((m) => m.seq), [1, 2, 3, 4]);
  // Older lines (scrolling up) land in front.
  assert.deepEqual(mergeLines([line(10)], [line(8), line(9)]).map((m) => m.seq), [8, 9, 10]);
});

test('chatStatus: busy, waiting on an approval, ended (no sending), idle', () => {
  assert.deepEqual(chatStatus({ state: 'working', waiting: 0 }), { word: 'Working', tone: 'busy', canSend: true });
  assert.equal(chatStatus({ state: 'idle', waiting: 1 }).word, 'Needs approval');
  assert.equal(chatStatus({ state: 'ended', waiting: 0 }).canSend, false);
  assert.equal(chatStatus(null).canSend, false);
  assert.match(newUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('composerKey: desktop Enter sends and Shift+Enter breaks the line; touch Enter breaks it; Ctrl/Cmd+Enter sends; IME is left alone', () => {
  assert.equal(composerKey(key('Enter'), false), 'send');
  assert.equal(composerKey(key('Enter', { shiftKey: true }), false), 'newline');
  assert.equal(composerKey(key('Enter'), true), 'newline');
  assert.equal(composerKey(key('Enter', { metaKey: true }), true), 'send');
  assert.equal(composerKey(key('Enter', { ctrlKey: true }), false), 'send');
  assert.equal(composerKey(key('Enter', { isComposing: true }), false), null);
  assert.equal(composerKey(key('a'), false), null);
});

test('composerHeight: one 44 px line, grows with the text, stops at five lines', () => {
  assert.equal(composerHeight(20), 44);
  assert.equal(composerHeight(64), 64);
  assert.equal(composerHeight(500), 20 * 5 + 24);
});

test('keyboardInset: the part of the layout viewport the keyboard covers; none without visualViewport', () => {
  assert.equal(keyboardInset(844, { height: 500, offsetTop: 0 }), 344);
  assert.equal(keyboardInset(844, { height: 844, offsetTop: 0 }), 0);
  assert.equal(keyboardInset(844, null), 0);
});

const comment = (id: number, author: string, minutes: number, kind: ReporterTicketComment['authorKind'] = 'person', body = 'x'): ReporterTicketComment => ({
  id: String(id),
  author,
  authorKind: kind,
  body,
  createdAt: new Date(Date.UTC(2026, 0, 1, 10, minutes)).toISOString(),
});

test('groupComments: consecutive comments by one author within ten minutes are one group; another author or a gap starts a new one', () => {
  const g = groupComments([comment(3, 'Lead', 5, 'agent'), comment(1, 'Lead', 0, 'agent'), comment(2, 'Lead', 2, 'agent'), comment(4, 'You', 6, 'reporter'), comment(5, 'You', 30, 'reporter')]);
  assert.deepEqual(
    g.map((x) => [x.author, x.items.map((c) => c.id)]),
    [
      ['Lead', ['1', '2', '3']],
      ['You', ['4']],
      ['You', ['5']],
    ],
  );
});

test('relTime and needsClamp', () => {
  const now = Date.UTC(2026, 0, 10, 12);
  assert.equal(relTime(new Date(now - 20_000).toISOString(), now), 'now');
  assert.equal(relTime(new Date(now - 5 * 60_000).toISOString(), now), '5m');
  assert.equal(relTime(new Date(now - 3 * 3_600_000).toISOString(), now), '3h');
  assert.equal(relTime(new Date(now - 2 * 86_400_000).toISOString(), now), '2d');
  assert.equal(relTime(new Date(now - 30 * 86_400_000).toISOString(), now), '2025-12-11');
  assert.equal(needsClamp('one\ntwo'), false);
  assert.equal(needsClamp('a\nb\nc\nd\ne'), true);
  assert.equal(needsClamp('x'.repeat(400)), true);
});

const shot = (url: string | null) => ({ captureId: 'c', index: 1, pageUrl: '', anchor: {} as never, note: null, createdAt: '', screenshotUrl: url });
const ticket = (k: string, extra: Partial<ReporterTicket> = {}) => ({ key: k, summary: k, captures: [], ...extra }) as unknown as ReporterTicket;

test('rowThumb: this page’s shot first, else the first with a screenshot, null for a ticket without one (no placeholder)', () => {
  assert.equal(rowThumb({ captures: [] }), null, 'filed outside the widget');
  assert.equal(rowThumb({ captures: [shot(null)] }), null, 'a capture whose screenshot never arrived');
  assert.equal(rowThumb({ captures: [shot('/a'), shot('/b')] }), '/a');
  assert.equal(rowThumb({ captures: [shot('/a'), shot('/b')] }, [shot('/b')]), '/b');
});

test('reuseRows: a refresh keeps unchanged ticket objects (memoised rows skip), and the same array when nothing changed', () => {
  const a = ticket('K-1');
  const b = ticket('K-2');
  const cur = [a, b];
  assert.equal(reuseRows(cur, [ticket('K-1'), ticket('K-2')]), cur, 'nothing changed: the same array');
  const next = reuseRows(cur, [ticket('K-1'), ticket('K-2', { summary: 'changed' })]);
  assert.notEqual(next, cur);
  assert.equal(next[0], a, 'unchanged row keeps its object');
  assert.notEqual(next[1], b);
  assert.deepEqual(reuseRows(null, [a]), [a]);
});

test('pagination: appendPage adds the next page once per key; a refresh asks for what is loaded (max 100)', () => {
  const out = appendPage([ticket('K-1'), ticket('K-2')], [ticket('K-2', { summary: 'new' }), ticket('K-3')]);
  assert.deepEqual(out.map((t) => t.key), ['K-1', 'K-2', 'K-3']);
  assert.equal(out[1]!.summary, 'new');
  assert.equal(refreshLimit(0), 50);
  assert.equal(refreshLimit(80), 80);
  assert.equal(refreshLimit(400), 100);
});

test('windowRange: only rows near the scrolled-to range render, clamped to the list', () => {
  assert.deepEqual(windowRange(500, 0, 800, 80, 5), { start: 0, end: 15 });
  assert.deepEqual(windowRange(500, 8000, 800, 80, 5), { start: 95, end: 115 });
  assert.deepEqual(windowRange(500, 1e9, 800, 80, 5), { start: 485, end: 500 }, 'past the end: the last rows');
  assert.deepEqual(windowRange(0, 0, 800, 80), { start: 0, end: 0 });
  const r = windowRange(100, 4000, 800, 80, 8);
  assert.ok(r.end - r.start <= 10 + 16, 'a bounded number of rows, however long the list');
});
