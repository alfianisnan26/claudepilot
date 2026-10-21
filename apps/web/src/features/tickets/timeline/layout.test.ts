// T-119: the scale maths and the bar layout of the Timeline. Every time is fixed; "now" is passed in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TICKET_TIMELINE_LIMITS, type TicketFlowSpan, type TicketFlowState } from '@portal/contracts';
import { axisTicks, chartWidth, durationShort, initials, layoutBars, LEGEND, MIN_BAR_PX, moveFocus, patternStyle, POINT_PX, pxPerMs, shading, STATE_LABEL, STATE_LOOK, timeLeft, UNIT_MS, UNIT_PX, windowFor, type Scale } from './layout';

const T0 = Date.parse('2026-10-18T00:00:00.000Z');
const MIN = 60_000;
const at = (m: number): string => new Date(T0 + m * MIN).toISOString();
const span = (state: TicketFlowState, from: number, to: number | null): TicketFlowSpan => ({
  state,
  start: at(from),
  end: to === null ? null : at(to),
  durationMs: ((to ?? 0) - from) * MIN,
  by: null,
  reason: null,
});
const NOW = T0 + 120 * MIN;

test('a scale is pixels per unit: one unit is its width, and the three scales are ordered', () => {
  for (const s of ['minute', 'hour', 'day'] as Scale[]) assert.equal(pxPerMs(s) * UNIT_MS[s], UNIT_PX[s]);
  assert.ok(pxPerMs('minute') > pxPerMs('hour') && pxPerMs('hour') > pxPerMs('day'));
});

test('bars: left and width follow the scale; an open span runs to now; a tiny span keeps a tappable width', () => {
  const range = { from: T0, to: NOW };
  const bars = layoutBars([span('open', 0, 10), span('in_progress', 10, 40), span('in_review', 40, null), span('blocked', 40, 40)], range, 'minute', NOW);
  const k = pxPerMs('minute');
  assert.deepEqual(bars.map((b) => [b.state, b.left, b.width]), [
    ['open', 0, 10 * MIN * k],
    ['in_progress', 10 * MIN * k, 30 * MIN * k],
    ['in_review', 40 * MIN * k, 80 * MIN * k],
    ['blocked', 40 * MIN * k, MIN_BAR_PX],
  ]);
  assert.deepEqual(bars.map((b) => b.running), [false, false, true, false]);
  assert.equal(bars[2]!.endMs, NOW);
  // A bigger unit makes the same span narrower.
  assert.ok(layoutBars([span('open', 0, 10)], range, 'hour', NOW)[0]!.width < bars[0]!.width);
  assert.deepEqual(layoutBars([span('open', 0, 10)], range, 'hour', NOW)[0]!.width, Math.max(MIN_BAR_PX, 10 * MIN * pxPerMs('hour')));
});

test('a closed state is a mark of a fixed width centred on its time, never a stretch and never zero', () => {
  const range = { from: T0, to: NOW };
  const [done, dropped] = layoutBars([span('done', 60, 60), span('wont_do', 90, 90)], range, 'hour', NOW);
  assert.equal(done!.point, true);
  assert.equal(done!.width, POINT_PX);
  assert.equal(done!.left, 60 * MIN * pxPerMs('hour') - POINT_PX / 2);
  assert.equal(dropped!.width, POINT_PX);
  assert.equal(layoutBars([span('open', 0, 1)], range, 'hour', NOW)[0]!.point, false);
});

test('a span with an unreadable start is left out, and each bar keeps the index of its span', () => {
  const bars = layoutBars([span('open', 0, 10), { ...span('open', 0, 1), start: 'nope' }, span('in_progress', 10, 20)], { from: T0, to: NOW }, 'hour', NOW);
  assert.deepEqual(bars.map((b) => b.index), [0, 2]);
});

test('axis ticks sit on multiples of the step, in order, inside the range, and the width is the range on the scale', () => {
  const range = { from: T0 + 7 * MIN, to: T0 + 32 * MIN };
  const t = axisTicks(range, 'minute');
  assert.deepEqual(t.map((x) => (x.at - T0) / MIN), [10, 15, 20, 25, 30]);
  assert.equal(t[0]!.left, 3 * MIN * pxPerMs('minute'));
  assert.deepEqual(axisTicks({ from: T0 - 30 * MIN, to: T0 + 150 * MIN }, 'hour').map((x) => (x.at - T0) / MIN), [0, 60, 120]);
  assert.equal(chartWidth(range, 'minute'), Math.ceil(25 * MIN * pxPerMs('minute')));
  assert.deepEqual(axisTicks({ from: T0 + 1, to: T0 + 2 }, 'day'), []);
});

test('the window is the scale’s default length (the API’s) up to now, its end on the next whole minute', () => {
  const now = T0 + 90 * MIN + 12_345;
  for (const s of ['minute', 'hour', 'day'] as Scale[]) {
    const w = windowFor(s, now);
    assert.equal(w.to, T0 + 91 * MIN);
    assert.equal(w.to - w.from, TICKET_TIMELINE_LIMITS[s].defaultWindowMs);
  }
  assert.deepEqual(windowFor('hour', now), windowFor('hour', now + 30_000), 'the same request within the minute');
  assert.equal(windowFor('hour', T0).to, T0, 'a whole minute stays');
});

test('bars are clipped to the window: one that began before starts at 0 and says so; outside the window, none', () => {
  const range = { from: T0 + 30 * MIN, to: T0 + 90 * MIN };
  const k = pxPerMs('minute');
  const bars = layoutBars([span('open', 0, 40), span('in_progress', 40, null), span('done', 10, 10), span('blocked', 100, 110), span('open', 0, 20)], range, 'minute', T0 + 200 * MIN);
  assert.deepEqual(bars.map((b) => [b.state, b.left, b.width, b.cutStart, b.index]), [
    ['open', 0, 10 * MIN * k, true, 0],
    ['in_progress', 10 * MIN * k, 50 * MIN * k, false, 1],
  ]);
  assert.equal(bars[1]!.running, true);
  assert.equal(bars[1]!.endMs, T0 + 200 * MIN, 'the details still know when it really ends');
  assert.equal(layoutBars([span('done', 60, 60)], range, 'minute', NOW).length, 1, 'a close inside the window is a mark');
  assert.equal(layoutBars([span('done', 95, 95)], range, 'minute', NOW).length, 0, 'a close after the window is not');
});

test('a time on the chart: its pixels, or null outside the window (markers, the now line)', () => {
  const range = { from: T0, to: T0 + 60 * MIN };
  assert.equal(timeLeft(T0 + 30 * MIN, range, 'minute'), 30 * MIN * pxPerMs('minute'));
  assert.equal(timeLeft(T0 - 1, range, 'minute'), null);
  assert.equal(timeLeft(T0 + 61 * MIN, range, 'minute'), null);
  assert.equal(timeLeft(NaN, range, 'minute'), null);
});

test('shading: weekends at the day scale (two days a week), nights at the hour scale (8 hours a day), nothing at the minute scale', () => {
  const start = new Date(T0);
  start.setHours(0, 0, 0, 0);
  const week = { from: start.getTime(), to: start.getTime() + 7 * 86_400_000 };
  const total = (xs: { width: number }[]) => xs.reduce((n, x) => n + x.width, 0);
  assert.ok(Math.abs(total(shading(week, 'day')) - 2 * UNIT_PX.day) < 1, 'two days of a week');
  const day = { from: start.getTime(), to: start.getTime() + 86_400_000 };
  assert.ok(Math.abs(total(shading(day, 'hour')) - 8 * UNIT_PX.hour) < 1, '22:00 to 06:00');
  assert.deepEqual(shading(day, 'minute'), []);
  for (const x of shading(week, 'hour')) assert.ok(x.left >= 0 && x.left + x.width <= chartWidth(week, 'hour') + 1, 'inside the chart');
});

test('every state has a word, a letter of its own and a look; blocked, waiting and won’t do carry a pattern too', () => {
  assert.deepEqual([...LEGEND].sort(), Object.keys(STATE_LOOK).sort());
  const letters = LEGEND.map((s) => STATE_LOOK[s].letter);
  assert.equal(new Set(letters).size, letters.length, 'letters are unique');
  for (const s of LEGEND) assert.ok(STATE_LABEL[s] && STATE_LOOK[s].bar.startsWith('bg-'), s);
  const bars = LEGEND.map((s) => `${STATE_LOOK[s].bar}|${STATE_LOOK[s].pattern}`);
  assert.equal(new Set(bars.filter((_, i) => !['done', 'wont_do'].includes(LEGEND[i]!))).size, 5, 'the stretch states differ in colour or pattern');
  for (const s of ['blocked', 'waiting', 'wont_do'] as const) assert.ok(patternStyle(STATE_LOOK[s].pattern).backgroundImage, s);
  assert.deepEqual(patternStyle('none'), {});
});

test('initials: two letters of a name, and a mark for none', () => {
  assert.deepEqual(['Build lane', 'frontend', 'QA: blind review', '', '  ', 'éclair bot'].map(initials), ['BL', 'FR', 'QB', '?', '?', 'ÉB']);
});

test('arrow keys move between bars: along a row, and to the nearest row with bars above or below', () => {
  const counts = [2, 0, 3, 1];
  assert.deepEqual(moveFocus(counts, { row: 0, bar: 0 }, 'ArrowRight'), { row: 0, bar: 1 });
  assert.equal(moveFocus(counts, { row: 0, bar: 1 }, 'ArrowRight'), null);
  assert.equal(moveFocus(counts, { row: 0, bar: 0 }, 'ArrowLeft'), null);
  assert.deepEqual(moveFocus(counts, { row: 0, bar: 1 }, 'ArrowDown'), { row: 2, bar: 1 }, 'the empty row is skipped');
  assert.deepEqual(moveFocus(counts, { row: 2, bar: 2 }, 'ArrowDown'), { row: 3, bar: 0 }, 'clamped to the row’s bars');
  assert.deepEqual(moveFocus(counts, { row: 2, bar: 0 }, 'ArrowUp'), { row: 0, bar: 0 });
  assert.equal(moveFocus(counts, { row: 0, bar: 0 }, 'ArrowUp'), null);
  assert.equal(moveFocus(counts, { row: 0, bar: 0 }, 'Enter'), null);
});

test('durations read short: seconds, minutes, hours with minutes, days with hours', () => {
  assert.deepEqual([0, 45_000, 12 * MIN, 185 * MIN, 120 * MIN, 52 * 60 * MIN, 48 * 60 * MIN, -5].map(durationShort), ['0s', '45s', '12m', '3h 5m', '2h', '2d 4h', '2d', '0s']);
});
