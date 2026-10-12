import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RevealEngine } from './engine';
import { advance, shown, type Arrival } from './pacing';
import { PACE } from './tokens';

/** A deterministic random source, so a "random" stream is the same on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Trace {
  /** When each word (by index) arrived. */
  arrived: number[];
  /** When each word (by index) was first showing. */
  revealed: number[];
  /** Words showing at each tick. */
  counts: number[];
}

/**
 * Runs the pacing against a stream with a fake 60 Hz clock: `bursts` are [time, words] pairs. Returns when each
 * word arrived and when it showed.
 */
function run(bursts: [number, number][], opts: { endAt?: number; until: number; tick?: number }): Trace {
  const tick = opts.tick ?? 1000 / 60;
  const arrivals: Arrival[] = [];
  const arrived: number[] = [];
  const revealed: number[] = [];
  const counts: number[] = [];
  let total = 0;
  let pos = 0;
  let from = 0;
  let endedAt: number | null = null;
  let b = 0;
  for (let t = 0; t <= opts.until; t += tick) {
    while (b < bursts.length && bursts[b]![0] <= t) {
      const n = bursts[b]![1];
      for (let i = 0; i < n; i++) arrived.push(bursts[b]![0]);
      total += n;
      arrivals.push({ t: bursts[b]![0], total });
      b++;
    }
    if (opts.endAt !== undefined && t >= opts.endAt && endedAt === null) endedAt = t;
    pos = advance(pos, from, t, arrivals, endedAt);
    from = t;
    const n = shown(pos, total);
    counts.push(n);
    while (revealed.length < n) revealed.push(t);
  }
  return { arrived, revealed, counts };
}

const lag = (t: Trace) => t.revealed.map((r, i) => r - t.arrived[i]!);

describe('pacing: the reveal position', () => {
  it('shows a lone word on the first frame after it arrives', () => {
    const t = run([[100, 1]], { until: 400 });
    assert.ok(lag(t)[0]! <= 17, `lag ${lag(t)[0]}`);
  });

  it('never shows more than has arrived, and never goes back', () => {
    const t = run([[0, 3], [50, 2], [400, 7]], { until: 2000 });
    assert.equal(t.counts.at(-1), 12);
    for (let i = 1; i < t.counts.length; i++) assert.ok(t.counts[i]! >= t.counts[i - 1]!);
  });

  it('shows a trickle of single words as they come, each within a frame', () => {
    const bursts: [number, number][] = Array.from({ length: 10 }, (_, i) => [i * 300, 1]);
    const t = run(bursts, { until: 3500 });
    for (const l of lag(t)) assert.ok(l <= 34, `lag ${l}`);
  });

  it('never lets a word wait longer than the cap, whatever the burst', () => {
    // Irregular arrivals with some huge bursts (a whole code block flushed at once).
    const rand = rng(7);
    for (let round = 0; round < 40; round++) {
      const bursts: [number, number][] = [];
      let at = 0;
      for (let i = 0; i < 60; i++) {
        at += rand() < 0.15 ? 200 + rand() * 600 : rand() * 90;
        bursts.push([at, rand() < 0.1 ? 40 + Math.floor(rand() * 160) : 1 + Math.floor(rand() * 9)]);
      }
      const t = run(bursts, { until: at + 4000 });
      const worst = Math.max(...lag(t));
      assert.ok(worst <= PACE.maxLagMs + 40, `round ${round}: a word waited ${worst.toFixed(0)} ms`);
      assert.equal(t.counts.at(-1), t.arrived.length);
    }
  });

  it('flushes what is left quickly once the stream has ended', () => {
    // 100 words arrive at once at t=0; the stream ends at t=50: everything shows within the flush time.
    const t = run([[0, 100]], { until: 1000, endAt: 50 });
    const last = t.revealed.at(-1)!;
    assert.ok(last <= 50 + PACE.flushMs + 40, `last word at ${last.toFixed(0)} ms`);
  });

  it('spreads a steady stream out: smoother than the arrivals', () => {
    // 40 words/s as bursts of 4 every 100 ms, with jitter.
    const rand = rng(3);
    const bursts: [number, number][] = [];
    let at = 0;
    for (let i = 0; i < 40; i++) {
      at += 60 + rand() * 80;
      bursts.push([at, 4]);
    }
    const t = run(bursts, { until: at + 1500 });
    // Words per 50 ms window, across the middle of the stream (past the start-up, before the end).
    const windowCounts = (times: number[]) => {
      const w: number[] = [];
      for (let from = 500; from + 50 < at - 300; from += 50) w.push(times.filter((x) => x >= from && x < from + 50).length);
      return w;
    };
    const std = (xs: number[]) => {
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    };
    const inStd = std(windowCounts(t.arrived));
    const outStd = std(windowCounts(t.revealed));
    assert.ok(outStd < inStd * 0.65, `arrivals vary ${inStd.toFixed(2)} per window, the reveal ${outStd.toFixed(2)}`);
    // And it stays within the lag budget while doing it.
    assert.ok(Math.max(...lag(t)) <= PACE.maxLagMs, `lag ${Math.max(...lag(t)).toFixed(0)}`);
  });

  it('does not stall in a gap: the speed eases down instead of stopping', () => {
    // A burst, then half a second of silence, then another burst.
    const t = run([[0, 30], [700, 30]], { until: 2500 });
    // During the silence the reveal is still moving at the start of it.
    const at = (ms: number) => t.counts[Math.round(ms / (1000 / 60))]!;
    assert.ok(at(250) > at(100), 'moving');
  });

  it('catches up at once after a long pause (a hidden tab): everything overdue shows in one step', () => {
    const arrivals: Arrival[] = [{ t: 0, total: 50 }];
    const pos = advance(0, 0, 30_000, arrivals);
    assert.equal(pos, 50);
  });
});

describe('RevealEngine', () => {
  it('shows only whole words: the last word waits until whitespace follows, or the stream ends', () => {
    const e = new RevealEngine();
    e.feed('Hello wor', false, 0);
    const v = e.step(16);
    assert.equal(v.text.slice(0, v.cut), 'Hello');
    e.feed('Hello world', false, 50);
    assert.equal(e.words, 1, 'world may still grow');
    e.feed('Hello world', true, 100);
    assert.equal(e.words, 2);
    const w = e.step(200);
    assert.equal(w.text.slice(0, w.cut), 'Hello world');
  });

  it('reveals the words in order and ends up with the whole text', () => {
    const e = new RevealEngine();
    const text = 'one two three four five six seven eight nine ten ';
    e.feed(text, true, 0);
    let prev = 0;
    for (let t = 16; t < 1000; t += 16) {
      const v = e.step(t);
      assert.ok(v.cut >= prev);
      prev = v.cut;
    }
    assert.equal(prev, text.trimEnd().length);
  });

  it('marks words as finished playing after freshMs', () => {
    const e = new RevealEngine();
    e.feed('alpha beta gamma ', true, 0);
    e.step(16);
    const early = e.step(100);
    assert.equal(early.staticCut, 0);
    const late = e.step(1000);
    assert.equal(late.staticCut, late.cut);
    assert.equal(e.settledAt(1000), true);
  });

  it('starts over when the text is replaced by something that is not a continuation', () => {
    const e = new RevealEngine();
    e.feed('first reply here ', true, 0);
    e.step(16);
    e.step(1000);
    e.feed('Another one ', false, 1100);
    assert.equal(e.words, 2);
    const v = e.step(1116);
    assert.ok(v.cut <= 'Another one'.length);
    assert.equal(v.staticCut, 0, 'the new reply has not played yet');
  });

  it('shows what a stalled page missed plain, with no animation to play', () => {
    const e = new RevealEngine();
    e.feed('one two three four five six ', false, 0);
    e.step(16);
    const v = e.step(30_000); // the tab was hidden for half a minute
    assert.equal(v.cut, 'one two three four five six'.length);
    assert.equal(v.staticCut, v.cut);
  });

  it('shows everything at once, plain, with reduced motion', () => {
    const e = new RevealEngine();
    e.feed('a b c d e f ', false, 0);
    const v = e.step(16, true);
    assert.equal(v.cut, 'a b c d e f'.length);
    assert.equal(v.staticCut, v.cut);
  });

  it('knows when there is nothing left to do', () => {
    const e = new RevealEngine();
    assert.equal(e.busy(0), false);
    e.feed('hi there ', false, 0);
    assert.equal(e.busy(0), true);
    e.step(16);
    e.step(300);
    assert.equal(e.busy(300), true, 'shown words still playing');
    e.step(900);
    assert.equal(e.busy(900), false);
  });
});
