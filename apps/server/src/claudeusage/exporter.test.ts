// CSV and JSON export (docs/prd/claude-usage.md §20.9): escaping, formula injection, and the two files' columns.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell, exportFileName, QUOTA_CSV_HEADER, quotaCsv, requestsCsv, REQUESTS_CSV_HEADER, toCsv } from './exporter.js';
import { seedClaude, seedUsage, usageHarness } from './fixtures.js';
import { SpendReader } from './spend.js';

test('a cell is quoted when it must be, and text a spreadsheet would run as a formula is defused', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(12.5), '12.5');
  assert.equal(csvCell(-3), '-3', 'a negative number is a number');
  for (const bad of ['=SUM(A1:A9)', '+1+1', '-2+3', '@HYPERLINK("x")', '\tcmd', '\rcmd']) {
    const cell = csvCell(bad);
    assert.ok(cell.replace(/^"/, '').startsWith("'"), `${JSON.stringify(bad)} -> ${cell}`);
  }
  assert.equal(csvCell('=1,2'), `"'=1,2"`, 'defused and quoted');
  assert.equal(toCsv(['a', 'b'], [[1, 'x,y'], [null, 'z']]), 'a,b\r\n1,"x,y"\r\n,z\r\n');
});

test('the requests file: one row per bucket, Claude and model that ran something; the dollar column says it is an estimate', async () => {
  // 1d range at UTC, now 10-12 15:30: buckets from 10-11 16:00. Two rows of one Claude and model in one bucket add up: 2 requests, $0.75.
  const h = await usageHarness();
  try {
    seedClaude(h.store, 'd1', 'docker/ws1', 'Default');
    seedClaude(h.store, 's1', 'docker/ws1', '=evil()', 'claudes/0123456789abcdef');
    seedUsage(h.store, [
      { at: Date.UTC(2026, 9, 12, 9, 20), claude: 's1', model: 'claude-sonnet-4-5', input: 200, output: 100, cacheWrite: 100, cost: 0.5 },
      { at: Date.UTC(2026, 9, 12, 9, 40), claude: 's1', model: 'claude-sonnet-4-5', input: 100, output: 50, cacheRead: 800, cacheWrite: 50, cost: 0.25 },
      { at: Date.UTC(2026, 9, 11, 16, 10), claude: '', model: 'claude-opus-4-5', input: 100, output: 50, cacheRead: 400, cacheWrite: 50, cost: 1, agents: 1 },
      { at: Date.UTC(2026, 9, 10, 9, 0), claude: 'd1', input: 999, cost: 9 }, // before the window
    ]);
    const csv = requestsCsv(new SpendReader(h.store), '1d', { now: Date.UTC(2026, 9, 12, 15, 30), tzOffsetMin: 0 });
    const lines = csv.trimEnd().split('\r\n');
    assert.equal(lines[0], REQUESTS_CSV_HEADER.join(','));
    assert.ok(REQUESTS_CSV_HEADER.includes('cost_usd_estimate') && !REQUESTS_CSV_HEADER.includes('cost_usd'));
    assert.deepEqual(lines.slice(1), [
      '2026-10-11T16:00:00.000Z,Default,ws1,claude-opus-4-5,1,1,100,50,400,50,1',
      // The Claude is named "=evil()": made plain text with a leading quote (it has no comma, so no quoting needed).
      "2026-10-12T09:00:00.000Z,'=evil(),ws1,claude-sonnet-4-5,2,0,300,150,800,150,0.75",
    ]);
    // A Claude's file holds its rows only.
    const one = requestsCsv(new SpendReader(h.store), '1d', { now: Date.UTC(2026, 9, 12, 15, 30), tzOffsetMin: 0, claudeId: 'd1' }).trimEnd().split('\r\n');
    assert.equal(one.length, 2);
  } finally {
    h.done();
  }
});

test('the quota file: one row per stored reading with the percent as Claude Code reported it', () => {
  const csv = quotaCsv([
    {
      claudeName: 'Satria',
      workspaceName: 'ws1',
      history: { claudeId: 'c1', range: '1d', from: '', to: '', series: [{ key: 'week', label: 'Week', points: [{ at: '2026-10-12T02:00:00.000Z', usedPct: 22.5 }] }, { key: 'session', label: 'Session', points: [{ at: '2026-10-12T01:00:00.000Z', usedPct: 10 }, { at: '2026-10-12T02:00:00.000Z', usedPct: 40 }] }] },
    },
  ]);
  assert.deepEqual(csv.trimEnd().split('\r\n'), [QUOTA_CSV_HEADER.join(','), '2026-10-12T01:00:00.000Z,Satria,ws1,session,10', '2026-10-12T02:00:00.000Z,Satria,ws1,session,40', '2026-10-12T02:00:00.000Z,Satria,ws1,week,22.5']);
});

test('the file name has only safe characters', () => {
  assert.equal(exportFileName('requests', '7d', 'csv'), 'claudepilot-usage-requests-7d.csv');
  assert.equal(exportFileName('a/b"c', '1 d', 'json'), 'claudepilot-usage-a_b_c-1_d.json');
});
