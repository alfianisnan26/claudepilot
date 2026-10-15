// T-376: the transcript a tab holds, in pages from the newest (history.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatEvent, ChatEventPage } from '@portal/contracts';
import { appendLive, asPage, EMPTY_HISTORY, expand, isCut, lastSeq, mergeEvents, olderDone, olderFailed, olderStart, seed, seedAll, type History } from './history';

const at = new Date().toISOString();
const ev = (seq: number, over: Partial<ChatEvent> = {}): ChatEvent => ({ seq, at, kind: 'assistant', text: `e${seq}`, ...over });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));
const seqs = (h: History) => h.events.map((e) => e.seq);
const page = (events: ChatEvent[], more: boolean): ChatEventPage => ({ events, more, before: more ? events[0]!.seq : null });

/** A tool_result cut to a preview of `keep` characters out of `whole`, as the server sends it in a page. */
const cut = (seq: number, whole: string, keep = 5): ChatEvent => ({ seq, at, kind: 'tool_result', toolUseId: `call-${seq}`, text: whole.slice(0, keep), textLength: whole.length });

describe('history: pages from the newest', () => {
  it('the newest page seeds it; more and before say where the older page starts', () => {
    const h = seed(EMPTY_HISTORY, page(range(301, 500), true));
    assert.equal(h.seeded, true);
    assert.equal(h.more, true);
    assert.equal(h.before, 301);
    assert.equal(h.events.length, 200);
    assert.equal(lastSeq(h.events), 500);
  });

  it('older pages go before, in order, until the start is reached', () => {
    let h = seed(EMPTY_HISTORY, page(range(301, 500), true));
    const s1 = olderStart(h);
    assert.ok(s1);
    assert.equal(s1.older, 'loading');
    h = olderDone(s1, 301, page(range(101, 300), true));
    assert.deepEqual([h.events[0]!.seq, h.before, h.more, h.older], [101, 101, true, 'idle']);
    h = olderDone(olderStart(h)!, 101, page(range(1, 100), false));
    assert.equal(h.more, false);
    assert.equal(h.before, null);
    assert.deepEqual(seqs(h), range(1, 500).map((e) => e.seq));
    // The start reached: nothing more to ask.
    assert.equal(olderStart(h), null);
  });

  it('one older page at a time; none before the newest is in', () => {
    assert.equal(olderStart(EMPTY_HISTORY), null);
    const loading = olderStart(seed(EMPTY_HISTORY, page(range(11, 20), true)))!;
    assert.equal(olderStart(loading), null);
  });

  it('a failed older page can be asked again', () => {
    const h = olderFailed(olderStart(seed(EMPTY_HISTORY, page(range(11, 20), true)))!);
    assert.equal(h.older, 'failed');
    assert.equal(olderStart(h)?.older, 'loading');
  });

  it('a page for a before that is no longer current merges but does not move more and before', () => {
    const h = { ...seed(EMPTY_HISTORY, page(range(11, 20), true)), older: 'loading' as const };
    const after = olderDone(h, 999, page(range(5, 10), false));
    assert.deepEqual(seqs(after).slice(0, 2), [5, 6]);
    assert.equal(after.more, true);
    assert.equal(after.before, 11);
  });

  it('live events go at the end while older pages are read', () => {
    let h = seed(EMPTY_HISTORY, page(range(11, 20), true));
    h = olderStart(h)!;
    h = appendLive(h, [ev(21), ev(22)]);
    h = olderDone(h, 11, page(range(1, 10), false));
    assert.deepEqual(seqs(h), range(1, 22).map((e) => e.seq));
    assert.equal(lastSeq(h.events), 22);
  });

  it('live events seen twice (a resume overlapping the page) are held once', () => {
    let h = seed(EMPTY_HISTORY, page(range(1, 5), false));
    h = appendLive(h, [ev(4), ev(5), ev(6)]);
    assert.deepEqual(seqs(h), [1, 2, 3, 4, 5, 6]);
    assert.equal(appendLive(h, []), h);
  });

  it('a portal from before T-376 answers a plain list: the whole transcript, nothing older', () => {
    assert.deepEqual(asPage(range(1, 3)), { events: range(1, 3), more: false, before: null });
    const p = page(range(5, 6), true);
    assert.equal(asPage(p), p);
  });

  it('a page that could not be read: the socket sends everything, so nothing is older', () => {
    const h = seedAll(EMPTY_HISTORY);
    assert.deepEqual([h.seeded, h.more, h.before], [true, false, null]);
  });
});

describe('history: cut tool results', () => {
  const whole = 'x'.repeat(5000);

  it('a preview is cut; the whole event and other events are not', () => {
    assert.equal(isCut(cut(3, whole)), true);
    assert.equal(isCut({ ...cut(3, whole), text: whole }), false);
    assert.equal(isCut(ev(1)), false);
  });

  it('opening one puts the whole event in its place', () => {
    const h = seed(EMPTY_HISTORY, page([ev(1), cut(2, whole), ev(3)], false));
    const opened = expand(h, { ...cut(2, whole), text: whole, textLength: undefined });
    assert.equal(opened.events[1]!.text, whole);
    assert.equal(isCut(opened.events[1]!), false);
    assert.deepEqual(seqs(opened), [1, 2, 3]);
    // An event not held changes nothing.
    assert.equal(expand(h, ev(9)), h);
  });

  it('a preview never replaces the whole copy held (a page read again, a live copy first)', () => {
    const wholeEvent: ChatEvent = { ...cut(2, whole), text: whole, textLength: undefined };
    const merged = mergeEvents([ev(1), wholeEvent], [cut(2, whole), ev(3)]);
    assert.equal(merged[1]!.text, whole);
    // The other way round, the whole copy wins.
    assert.equal(mergeEvents([ev(1), cut(2, whole)], [wholeEvent])[1]!.text, whole);
  });
});
