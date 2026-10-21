// T-119 S2a: the scale maths and the bar layout of the flow chart. Every time is fixed; "now" is passed in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TicketFlowSpan, TicketFlowState } from '@portal/contracts';
import { axisTicks, chartRange, chartWidth, durationShort, fitScale, layoutBars, MIN_BAR_PX, PAD_MS, POINT_PX, pxPerMs, UNIT_MS, UNIT_PX, type Scale } from './layout';

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

test('the range covers every span, an open one up to now, with the scale’s padding; no readable span: null', () => {
  const rows = [
    { id: 'T-1', title: 'a', spans: [span('open', 10, 30), span('in_progress', 30, null)] },
    { id: 'T-2', title: 'b', spans: [span('open', 5, 20)] },
  ];
  assert.deepEqual(chartRange(rows, NOW, 'hour'), { from: T0 + 5 * MIN - PAD_MS.hour, to: NOW + PAD_MS.hour });
  assert.deepEqual(chartRange(rows, NOW, 'minute'), { from: T0 + 5 * MIN - PAD_MS.minute, to: NOW + PAD_MS.minute });
  assert.equal(chartRange([], NOW, 'day'), null);
  assert.equal(chartRange([{ id: 'x', title: 'x', spans: [{ ...span('open', 0, 1), start: 'nope' }] }], NOW, 'day'), null);
  // A closed ticket does not stretch to now.
  assert.equal(chartRange([{ id: 'T-3', title: 'c', spans: [span('open', 0, 10), span('done', 10, 10)] }], NOW, 'hour')!.to, T0 + 10 * MIN + PAD_MS.hour);
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

test('fitScale picks the finest scale whose whole range fits the width', () => {
  assert.equal(fitScale({ from: T0, to: T0 + 30 * MIN }, 390), 'minute');
  assert.equal(fitScale({ from: T0, to: T0 + 6 * 60 * MIN }, 390), 'hour');
  assert.equal(fitScale({ from: T0, to: T0 + 10 * 24 * 60 * MIN }, 390), 'day');
});

test('durations read short: seconds, minutes, hours with minutes, days with hours', () => {
  assert.deepEqual([0, 45_000, 12 * MIN, 185 * MIN, 120 * MIN, 52 * 60 * MIN, 48 * 60 * MIN, -5].map(durationShort), ['0s', '45s', '12m', '3h 5m', '2h', '2d 4h', '2d', '0s']);
});
