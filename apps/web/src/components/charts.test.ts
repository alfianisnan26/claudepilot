// The chart's axis top (owner, 2026-10-18: "it should show scaling up to the max value"): at or above the highest value, never far above
// it. A peak of $210 used to draw an axis to $500.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Histogram,
  LineChart,
  ScoreTile,
  StageBars,
  arcPath,
  formatSpan,
  histogramBins,
  histogramTable,
  lastPoint,
  lineRuns,
  linePath,
  lineSummary,
  lineTable,
  linearScale,
  medianOf,
  nearestIndex,
  niceMax,
  scoreDelta,
  spreadLabels,
  stageGeometry,
  stageSummary,
  stageTable,
  timeTicks,
  unionTimes,
  valueAt,
  type StageRow,
} from './charts';

test('the axis top is the closest readable number at or above the peak', () => {
  assert.equal(niceMax(210), 250);
  assert.equal(niceMax(200), 200);
  assert.equal(niceMax(201), 250);
  assert.equal(niceMax(315), 400);
  assert.equal(niceMax(392), 400);
  assert.equal(niceMax(110), 120);
  assert.equal(niceMax(0.3), 0.3, 'no floating-point jump to the next step');
  assert.equal(niceMax(7), 8);
  assert.equal(niceMax(1003), 1200);
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-5), 1);
});

test('never below the peak, and at most a third above it (the peak fills at least 3/4 of the height)', () => {
  for (let v = 1; v < 100000; v = v * 1.07 + 0.31) {
    const m = niceMax(v);
    assert.ok(m >= v, `${m} >= ${v}`);
    assert.ok(m <= v * (4 / 3) + 1e-9, `${m} within a third of ${v}`);
  }
});

// T-2360: the metric charts. Pure helpers first, then the markup rendered to a string (no browser) at the phone width.

test('formatSpan: the shortest honest unit, rounded before the unit is picked', () => {
  assert.equal(formatSpan(850), '850ms');
  assert.equal(formatSpan(42_000), '42s');
  assert.equal(formatSpan(42 * 60_000), '42m');
  assert.equal(formatSpan(3.5 * 3_600_000), '3.5h');
  assert.equal(formatSpan(3 * 3_600_000), '3h', 'no trailing .0');
  assert.equal(formatSpan(2.1 * 86_400_000), '2.1d');
  assert.equal(formatSpan(59.6 * 60_000), '1h', '59.6 minutes is not "60m"');
  assert.equal(formatSpan(59.6 * 1000), '1m', '59.6 seconds is not "60s"');
  assert.equal(formatSpan(23.97 * 3_600_000), '1d', '23.97 hours is not "24.0h"');
  assert.equal(formatSpan(0), '0ms');
  assert.equal(formatSpan(250 * 86_400_000), '250d');
});

test('formatSpan: not a number is "unavailable", never 0', () => {
  assert.equal(formatSpan(null), 'unavailable');
  assert.equal(formatSpan(undefined), 'unavailable');
  assert.equal(formatSpan(Number.NaN), 'unavailable');
  assert.equal(formatSpan(Infinity), 'unavailable');
});

test('linearScale maps the domain onto the range; one value maps to the middle', () => {
  const f = linearScale(0, 10, 100, 0);
  assert.equal(f(0), 100);
  assert.equal(f(10), 0);
  assert.equal(f(2.5), 75);
  assert.equal(linearScale(5, 5, 10, 30)(5), 20);
});

test('timeTicks: evenly spaced, ends included; a single instant is one tick', () => {
  assert.deepEqual(timeTicks(0, 100, 3), [0, 50, 100]);
  assert.deepEqual(timeTicks(7, 7, 3), [7]);
  assert.deepEqual(timeTicks(0, 100, 1), [0]);
});

test('a null breaks the line in two: it is never bridged and never drawn as zero', () => {
  const pts = [
    { x: 0, y: 10 },
    { x: 10, y: 20 },
    { x: 20, y: null },
    { x: 30, y: 5 },
    { x: 40, y: 6 },
  ];
  assert.equal(lineRuns(pts).length, 2);
  assert.equal(linePath(pts), 'M0.0,10.0 L10.0,20.0 M30.0,5.0 L40.0,6.0');
  assert.equal(linePath([{ x: 0, y: null }]), '');
  assert.equal(
    linePath([
      { x: 0, y: Number.NaN },
      { x: 5, y: 1 },
    ]),
    '',
    'NaN is a gap too, and a lone point has no line',
  );
  assert.deepEqual(lineRuns([{ x: 1, y: 3 }]), [[{ x: 1, y: 3 }]], 'a lone point is a run of one (drawn as a dot)');
});

test('spreadLabels keeps end labels a gap apart, inside the plot, in the order given', () => {
  const out = spreadLabels([100, 102, 101], 14, 0, 300);
  const sorted = [...out].sort((a, b) => a - b);
  assert.ok(sorted[1]! - sorted[0]! >= 14 - 1e-9 && sorted[2]! - sorted[1]! >= 14 - 1e-9, `spread: ${out}`);
  assert.ok(out[0]! <= out[2]! && out[2]! <= out[1]!, 'the order of the wanted y is kept');
  const low = spreadLabels([298, 299, 300], 14, 0, 300);
  assert.ok(Math.max(...low) <= 300 && Math.min(...low) >= 300 - 28 - 1e-9, `a pile at the bottom is pushed up: ${low}`);
  assert.deepEqual(spreadLabels([50], 14, 0, 300), [50]);
  assert.deepEqual(spreadLabels([], 14, 0, 300), []);
});

test('nearestIndex, unionTimes, valueAt and lastPoint', () => {
  assert.equal(nearestIndex([0, 10, 20], 14), 1);
  assert.equal(nearestIndex([0, 10, 20], 16), 2);
  assert.equal(nearestIndex([], 5), -1);
  const a = {
    points: [
      { t: 3, v: 1 },
      { t: 1, v: null },
    ],
  };
  const b = {
    points: [
      { t: 3, v: 2 },
      { t: 2, v: 5 },
    ],
  };
  assert.deepEqual(unionTimes([a, b]), [1, 2, 3]);
  assert.equal(valueAt(a.points, 1), null, 'a null is not 0');
  assert.equal(valueAt(a.points, 2), null, 'no point at that time is not 0');
  assert.equal(valueAt(a.points, 3), 1);
  assert.deepEqual(
    lastPoint([
      { t: 1, v: 4 },
      { t: 5, v: 9 },
      { t: 9, v: null },
    ]),
    { t: 5, v: 9 },
    'the last RECORDED value',
  );
  assert.equal(lastPoint([{ t: 1, v: null }]), null);
  assert.equal(lastPoint([]), null);
});

test('histogramBins: equal bins, the top value in the last bin, nothing lost or made up', () => {
  const { edges, counts } = histogramBins([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  assert.deepEqual(edges, [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(counts, [2, 2, 2, 2, 3], 'an inner edge falls in the bin above, 10 in the last');
  assert.equal(
    counts.reduce((a, c) => a + c, 0),
    11,
  );
  assert.equal(edges.length, counts.length + 1);
});

test('histogramBins: a range, outliers, junk and degenerate input', () => {
  const r = histogramBins([1, 5, 50, Number.NaN, Infinity, -3], 2, { min: 0, max: 10 });
  assert.deepEqual(r, { edges: [0, 5, 10], counts: [1, 1] }, 'outside the range and not-numbers are left out');
  assert.deepEqual(histogramBins([]), { edges: [], counts: [] });
  const same = histogramBins([4, 4, 4], 5);
  assert.deepEqual(
    same.counts.reduce((a, c) => a + c, 0),
    3,
    'all values equal: still counted',
  );
  assert.equal(same.edges.length, same.counts.length + 1);
  assert.deepEqual(histogramBins([1, 2], 0).counts.length, 1, 'at least one bin');
});

test('medianOf: the middle, the mean of the middle two, null for nothing', () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([4, 1, 2, 3]), 2.5);
  assert.equal(medianOf([Number.NaN]), null);
  assert.equal(medianOf([]), null);
});

test('arcPath: from the left end over the top; the ends of a half circle', () => {
  assert.equal(arcPath(60, 62, 50, 0, 1), 'M10.00,62.00 A50,50 0 0 1 110.00,62.00');
  assert.equal(arcPath(60, 62, 50, 0, 0.5), 'M10.00,62.00 A50,50 0 0 1 60.00,12.00');
  assert.equal(arcPath(60, 62, 50, 0, 2), arcPath(60, 62, 50, 0, 1), 'clamped');
});

test('scoreDelta: sign in the text, tone by whether up is better, null when there is nothing to compare', () => {
  assert.deepEqual(scoreDelta(74, 70), { delta: 4, direction: 'up', text: '+4', tone: 'good' });
  assert.deepEqual(scoreDelta(70, 74), { delta: -4, direction: 'down', text: '-4', tone: 'bad' });
  assert.deepEqual(scoreDelta(70, 74, false), { delta: -4, direction: 'down', text: '-4', tone: 'good' }, 'lower is better');
  assert.equal(scoreDelta(74.04, 70)?.text, '+4', 'one decimal');
  assert.deepEqual(scoreDelta(70, 70), { delta: 0, direction: 'same', text: '0', tone: 'neutral' });
  assert.equal(scoreDelta(70, null), null);
  assert.equal(scoreDelta(null, 70), null);
  assert.equal(scoreDelta(undefined, undefined), null);
});

const row = (r: Partial<StageRow> & { key: string }): StageRow => ({ label: r.key, median: 1, p90: 2, n: 5, ...r });

test('stageGeometry: percentages of one shared axis; the whisker never ends before the bar; no median is no bar', () => {
  assert.deepEqual(stageGeometry({ median: 25, p90: 50 }, 100), { median: 25, p90: 50 });
  assert.deepEqual(stageGeometry({ median: 60, p90: 50 }, 100), { median: 60, p90: 60 }, 'a p90 under the median is held at the median');
  assert.deepEqual(stageGeometry({ median: 25, p90: null }, 100), { median: 25, p90: null });
  assert.equal(stageGeometry({ median: null, p90: 5 }, 100), null);
  assert.equal(stageGeometry({ median: 5, p90: 5 }, 0), null);
  assert.equal(stageGeometry({ median: 500, p90: 900 }, 100)?.p90, 100, 'clamped');
});

test('stage summary and table say "unavailable", n and the excluded count', () => {
  const rows = [
    row({ key: 'review', label: 'Review', median: 42 * 60_000, p90: 3.5 * 3_600_000, n: 128, excluded: 3 }),
    row({ key: 'qa', label: 'QA', median: null, p90: null, n: 0, note: 'no samples' }),
  ];
  assert.equal(stageSummary(rows[0]!, formatSpan), 'Review: median 42m, p90 3.5h, n 128, 3 excluded');
  assert.equal(stageSummary(rows[1]!, formatSpan), 'QA: median unavailable, p90 unavailable, n 0, no samples');
  assert.deepEqual(stageTable(rows, formatSpan, 'c').rows, [
    ['Review', '42m', '3.5h', '128', '3'],
    ['QA', 'unavailable', 'unavailable', '0', '0'],
  ]);
});

test('line summary and table: a missing value is "unavailable" in both', () => {
  const series = [
    {
      label: 'Median',
      points: [
        { t: 1000, v: 10 },
        { t: 2000, v: null },
        { t: 3000, v: 30 },
      ],
    },
    { label: 'Empty', points: [{ t: 1000, v: null }] },
  ];
  const t = (n: number) => `t${n / 1000}`;
  assert.equal(lineSummary('Cycle time', series, String, t), 'Cycle time. Median: latest 30 at t3, from 10 to 30. Empty: unavailable');
  assert.deepEqual(lineTable(series, String, t, 'c').rows, [
    ['t1', '10', 'unavailable'],
    ['t2', 'unavailable', 'unavailable'],
    ['t3', '30', 'unavailable'],
  ]);
  assert.deepEqual(histogramTable([0, 5, 10], [3, 4], String, 'c').rows, [
    ['0', '5', '3'],
    ['5', '10', '4'],
  ]);
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const el = createElement;

test('LineChart: an image with a summary, a legend for two series, a 44 px Table button, a gap marked on the baseline', () => {
  const series = [
    {
      key: 'a',
      label: 'Median',
      points: [
        { t: 0, v: 10 },
        { t: 1000, v: null },
        { t: 2000, v: 30 },
        { t: 3000, v: 20 },
      ],
    },
    {
      key: 'b',
      label: 'P90',
      points: [
        { t: 0, v: 40 },
        { t: 3000, v: 50 },
      ],
    },
  ];
  const html = renderToStaticMarkup(
    el(LineChart, { series, format: (v: number) => `${v}m`, ariaLabel: 'Cycle time', width: 390, target: { value: 35, label: 'Target' } }),
  );
  assert.match(html, /role="img" aria-label="Cycle time\. Median: latest 20m[^"]*P90: latest 50m/);
  assert.match(text(html), /Target 35m/);
  assert.equal((html.match(/<li class="flex items-center gap-1\.5">/g) ?? []).length, 2, 'a legend entry per series');
  assert.match(html, /<button[^>]*min-h-11[^>]*min-w-11[^>]*>Table<\/button>/);
  assert.equal((html.match(/data-chart-gap="a"[^>]*><line/g) ?? []).length, 1, 'the gap of the median is a hairline');
  assert.doesNotMatch(html, /r="3"[^>]*fill="var\(--color-surface\)"/, 'no dot on the baseline: it read as 0');
  assert.match(html, /role="group" aria-label="Cycle time: values by time"/);
  assert.equal((html.match(/role="button"/g) ?? []).length, 4, 'a focusable point per time');
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1, 'one tab stop');
  assert.match(html, /aria-label="[^"]*: Median unavailable, P90 unavailable"/, 'a time with no value says so');
});

test('LineChart: the table has the same numbers, and "unavailable"; a fourth series is not drawn; no numbers at all shows the empty text', () => {
  const mk = (key: string, v: number | null) => ({
    key,
    label: key,
    points: [
      { t: 0, v },
      { t: 1000, v },
    ],
  });
  const html = renderToStaticMarkup(
    el(LineChart, {
      series: [mk('a', 1), mk('b', null), mk('c', 3), mk('d', 4)],
      format: String,
      ariaLabel: 'x',
      width: 390,
      defaultTable: true,
    }),
  );
  assert.match(html, /<table/);
  assert.match(html, />Chart<\/button>/);
  assert.doesNotMatch(html, /<th[^>]*>d<\/th>/, 'at most three series');
  assert.match(html, /<td[^>]*text-muted[^>]*>unavailable<\/td>/);
  const none = renderToStaticMarkup(
    el(LineChart, { series: [mk('a', null)], format: String, ariaLabel: 'x', width: 390, empty: 'No data yet' }),
  );
  assert.match(text(none), /No data yet/);
  assert.doesNotMatch(none, /<path d="M/, 'nothing drawn as zero');
});

test('ScoreTile: the change has an arrow, a sign and a word; the colour only says better or worse', () => {
  const up = renderToStaticMarkup(el(ScoreTile, { label: 'Quality', score: 74, previous: 70 }));
  assert.match(text(up), /74/);
  assert.match(up, /data-delta="up" data-tone="good"/);
  assert.match(text(up), /\+4 vs previous up, better/);
  assert.match(up, /<svg[^>]*aria-hidden="true"[^>]*viewBox="0 0 120 68"|viewBox="0 0 120 68"[^>]*aria-hidden="true"/);
  const worse = renderToStaticMarkup(el(ScoreTile, { label: 'Defects', score: 74, previous: 70, higherIsBetter: false }));
  assert.match(worse, /data-delta="up" data-tone="bad"/);
  assert.match(text(worse), /up, worse/);
  const same = renderToStaticMarkup(el(ScoreTile, { label: 'Q', score: 70, previous: 70 }));
  assert.match(text(same), /0 vs previous unchanged/);
  const noPrev = renderToStaticMarkup(el(ScoreTile, { label: 'Q', score: 70 }));
  assert.doesNotMatch(noPrev, /data-delta/);
  assert.match(text(noPrev), /previous unavailable/);
});

test('ScoreTile: no score is "unavailable" with the reason, no value arc and no delta', () => {
  const html = renderToStaticMarkup(el(ScoreTile, { label: 'Quality', score: null, previous: 70, reason: 'no samples in this window' }));
  assert.match(html, /data-score="unavailable"/);
  assert.match(text(html), /unavailable no samples in this window/);
  assert.doesNotMatch(html, /data-delta/);
  assert.doesNotMatch(html, /stroke="var\(--chart-1\)"/, 'no value arc');
  const zero = renderToStaticMarkup(el(ScoreTile, { label: 'Quality', score: 0 }));
  assert.match(zero, /data-score="value"/, 'a score of 0 is a score');
  assert.match(text(zero), /\b0\b/);
});

test('StageBars: rows are 44 px buttons with their numbers when selectable; n and excluded under each; an empty row says why', () => {
  const rows = [
    row({ key: 'review', label: 'Review', median: 42 * 60_000, p90: 3.5 * 3_600_000, n: 128, excluded: 3 }),
    row({ key: 'qa', label: 'QA', median: null, p90: null, n: 0, note: 'no samples' }),
  ];
  const html = renderToStaticMarkup(
    el(StageBars, { rows, format: formatSpan, ariaLabel: 'Stage times', onSelect: () => {}, selected: 'review' }),
  );
  assert.equal((html.match(/<button[^>]*aria-label="(Review|QA):[^>]*min-h-11/g) ?? []).length, 2, 'a 44 px button per row');
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /aria-label="Review: median 42m, p90 3\.5h, n 128, 3 excluded"/);
  const t = text(html);
  assert.match(t, /42m p90 3\.5h/);
  assert.match(t, /n 128 3 excluded/);
  assert.match(t, /QA unavailable n 0 no samples/);
  assert.match(t, /Bar: median\. Whisker: p90\./);
  const plain = renderToStaticMarkup(el(StageBars, { rows, format: formatSpan, ariaLabel: 'Stage times' }));
  assert.equal((plain.match(/<button/g) ?? []).length, 1, 'without onSelect only the Table toggle is a button');
});

test('StageBars: the bar is the median and the whisker reaches the p90, on a shared axis; the table has the same numbers', () => {
  const rows = [row({ key: 'a', median: 25, p90: 50 }), row({ key: 'b', median: 10, p90: null })];
  const html = renderToStaticMarkup(el(StageBars, { rows, format: String, ariaLabel: 'x' }));
  // axis top niceMax(50) = 50: the median 25 is 50 %, the p90 100 %.
  assert.match(html, /style="width:50%;background:var\(--chart-1\)"/);
  assert.match(html, /left:100%/);
  const table = renderToStaticMarkup(el(StageBars, { rows, format: String, ariaLabel: 'x', defaultTable: true }));
  assert.match(table, /<table/);
  assert.match(table, /unavailable/);
  assert.match(text(renderToStaticMarkup(el(StageBars, { rows: [], format: String, ariaLabel: 'x', empty: 'No stages' }))), /No stages/);
});

test('Histogram: an image with a summary and the median, a focusable bin each, the table lists every bin', () => {
  const { edges, counts } = histogramBins([1, 2, 2, 3, 3, 3, 9], 4);
  const html = renderToStaticMarkup(
    el(Histogram, { edges, counts, format: (v: number) => `${v}h`, median: 3, ariaLabel: 'Cycle time', width: 390 }),
  );
  assert.match(html, /role="img" aria-label="Cycle time: 7 values in 4 bins from 1h to 9h, median 3h"/);
  assert.match(text(html), /median 3h/);
  assert.equal((html.match(/role="button"/g) ?? []).length, 4);
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1);
  assert.match(html, />Table<\/button>/);
  const table = renderToStaticMarkup(
    el(Histogram, { edges, counts, format: (v: number) => `${v}h`, median: 3, ariaLabel: 'Cycle time', width: 390, defaultTable: true }),
  );
  assert.equal((table.match(/<tr/g) ?? []).length, 5, 'a header and a row per bin');
  assert.match(table, /Cycle time, median 3h/);
});

test('Histogram: a median outside the bins is not marked; no bins is empty, not a chart of zeros', () => {
  const out = renderToStaticMarkup(
    el(Histogram, { edges: [0, 5, 10], counts: [1, 2], format: String, median: 99, ariaLabel: 'x', width: 390 }),
  );
  assert.doesNotMatch(text(out), /median 99/);
  assert.doesNotMatch(out, /stroke-dasharray/, 'no median line');
  const none = renderToStaticMarkup(
    el(Histogram, { edges: [], counts: [], format: String, ariaLabel: 'x', width: 390, empty: 'No data yet' }),
  );
  assert.match(text(none), /No data yet/);
  assert.match(none, /aria-label="x: unavailable"/);
  assert.doesNotMatch(none, /role="button"/);
});
