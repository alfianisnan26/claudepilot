// T-119 S2a: the fixture the chart is shown with is itself well formed, so a look at it means something.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureRows } from './fixture';
import { chartRange, layoutBars } from './layout';

const START = Date.parse('2026-10-18T00:00:00.000Z');
const NOW = START + 200 * 60_000;

test('every fixture row is in time order, each span starts where the one before it ended, and only the last may run', () => {
  const rows = fixtureRows(START, NOW);
  assert.equal(rows.length, 4);
  for (const r of rows) {
    r.flow.spans.forEach((s, i) => {
      if (s.end === null) assert.equal(i, r.flow.spans.length - 1, `${r.id}: only the last span runs`);
      const prev = r.flow.spans[i - 1];
      if (prev) assert.ok(Date.parse(s.start) >= Date.parse(prev.end!), `${r.id}: span ${i} starts after the one before it`);
    });
    assert.equal(r.flow.state, r.flow.spans.at(-1)!.state);
  }
});

test('the fixture lays out: every span gets a bar, and the reopened row has two in_progress bars', () => {
  const rows = fixtureRows(START, NOW);
  const range = chartRange(rows.map((r) => ({ id: r.id, title: r.title, spans: r.flow.spans })), NOW, 'hour')!;
  for (const r of rows) assert.equal(layoutBars(r.flow.spans, range, 'hour', NOW).length, r.flow.spans.length);
  assert.equal(rows[1]!.flow.spans.filter((s) => s.state === 'in_progress').length, 2);
  assert.ok(rows.some((r) => r.flow.spans.some((s) => s.state === 'waiting')));
});
