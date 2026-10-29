// The Schedules page's order, filter and row line (T-965).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduleRow } from '@portal/contracts';
import { attentionCount, canRunNow, canSwitch, detailText, everyText, triggerIdOf, visibleRows } from './model.js';

const base: ScheduleRow = {
  id: 'loop:x',
  kind: 'loop',
  name: 'x',
  module: 'tickets',
  description: null,
  interval_ms: 60_000,
  cron: null,
  last_run: null,
  last_result: null,
  last_error: null,
  next_run: null,
  state: 'ok',
  source: null,
  owner: null,
  target: null,
  action: null,
  enabled: null,
};
const row = (o: Partial<ScheduleRow>): ScheduleRow => ({ ...base, ...o });
const ago = (iso: string) => `@${iso.slice(11, 16)}`;

test('failing and late rows come first, off ones last; the server order holds within a state; the kind filter', () => {
  const rows = [
    row({ id: 'loop:a', state: 'ok' }),
    row({ id: 'trigger:t1', kind: 'trigger', state: 'disabled' }),
    row({ id: 'helper:h', kind: 'helper', state: 'stale' }),
    row({ id: 'loop:b', state: 'failing' }),
    row({ id: 'loop:c', state: 'ok' }),
    row({ id: 'loop:d', state: 'stopped' }),
  ];
  assert.deepEqual(
    visibleRows(rows, 'all').map((r) => r.id),
    ['loop:b', 'helper:h', 'loop:d', 'loop:a', 'loop:c', 'trigger:t1'],
  );
  assert.deepEqual(visibleRows(rows, 'loop').map((r) => r.id), ['loop:b', 'loop:d', 'loop:a', 'loop:c']);
  assert.deepEqual(visibleRows(rows, 'helper').map((r) => r.id), ['helper:h']);
  assert.deepEqual(visibleRows(rows, 'trigger').map((r) => r.id), ['trigger:t1']);
  assert.equal(attentionCount(rows), 2);
  assert.equal(rows[0]!.id, 'loop:a', 'the input is not reordered');
});

test('the line under a row says only what the server sent', () => {
  assert.equal(detailText(row({}), ago), 'every 1 min · tickets · not run yet');
  assert.equal(
    detailText(row({ state: 'failing', last_run: '2026-10-17T12:00:00.000Z', next_run: '2026-10-17T12:01:00.000Z', last_error: 'disk full' }), ago),
    'every 1 min · tickets · last @12:00 · next @12:01 · disk full',
  );
  assert.equal(
    detailText(row({ kind: 'trigger', interval_ms: null, cron: { expr: '0 9 * * 1-5', tz: 'Asia/Jakarta' }, target: 'docker/api-dev', action: 'ticket_session', next_run: '2026-10-17T02:00:00.000Z' }), ago),
    '0 9 * * 1-5 Asia/Jakarta · docker/api-dev · ticket + session · not run yet · next @02:00',
  );
  assert.equal(
    detailText(row({ kind: 'trigger', interval_ms: null, source: 'ci_failed', action: 'session', state: 'disabled', next_run: '2026-10-17T02:00:00.000Z' }), ago),
    'on a failed CI run · session · not run yet',
    'no next run for what is off',
  );
  assert.equal(detailText(row({ kind: 'helper', module: 'supervisor', owner: 'coordinator', interval_ms: 3_600_000, last_run: '2026-10-17T11:00:00.000Z' }), ago), 'every 1 h · coordinator · last @11:00');
});

test('only triggers have actions; a webhook trigger cannot be run by hand', () => {
  const cron = row({ id: 'trigger:trg_1', kind: 'trigger', source: 'cron', enabled: true });
  assert.deepEqual([canSwitch(cron), canRunNow(cron), triggerIdOf(cron)], [true, true, 'trg_1']);
  assert.deepEqual([canSwitch(row({ kind: 'trigger', source: 'webhook', enabled: false })), canRunNow(row({ kind: 'trigger', source: 'webhook', enabled: false }))], [true, false]);
  assert.deepEqual([canSwitch(row({})), canRunNow(row({})), canSwitch(row({ kind: 'helper' })), canRunNow(row({ kind: 'helper' }))], [false, false, false, false]);
});

test('everyText', () => {
  assert.deepEqual([everyText(30_000), everyText(90_000), everyText(300_000), everyText(21_600_000), everyText(86_400_000), everyText(172_800_000)], [
    'every 30 s',
    'every 90 s',
    'every 5 min',
    'every 6 h',
    'daily',
    'every 2 d',
  ]);
});
