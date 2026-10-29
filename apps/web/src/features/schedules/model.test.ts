// The Schedules page's order, filter and row line (T-965).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduleRow } from '@portal/contracts';
import type { Trigger } from '@portal/contracts';
import { detailErrors, emptyTriggerForm, formFromTrigger, formProblems, triggerBody } from './editor.js';
import { attentionCount, canEdit, canRunNow, canSwitch, detailRows, detailText, everyText, settleList, triggerIdOf, visibleRows } from './model.js';

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
  assert.deepEqual(
    visibleRows(rows, 'loop').map((r) => r.id),
    ['loop:b', 'loop:d', 'loop:a', 'loop:c'],
  );
  assert.deepEqual(
    visibleRows(rows, 'helper').map((r) => r.id),
    ['helper:h'],
  );
  assert.deepEqual(
    visibleRows(rows, 'trigger').map((r) => r.id),
    ['trigger:t1'],
  );
  assert.equal(attentionCount(rows), 2);
  assert.equal(rows[0]!.id, 'loop:a', 'the input is not reordered');
});

test('the line under a row says only what the server sent', () => {
  assert.equal(detailText(row({}), ago), 'every 1 min · tickets · not run yet');
  assert.equal(
    detailText(
      row({ state: 'failing', last_run: '2026-10-17T12:00:00.000Z', next_run: '2026-10-17T12:01:00.000Z', last_error: 'disk full' }),
      ago,
    ),
    'every 1 min · tickets · last @12:00 · next @12:01 · disk full',
  );
  assert.equal(
    detailText(
      row({
        kind: 'trigger',
        interval_ms: null,
        cron: { expr: '0 9 * * 1-5', tz: 'Asia/Jakarta' },
        target: 'docker/api-dev',
        action: 'ticket_session',
        next_run: '2026-10-17T02:00:00.000Z',
      }),
      ago,
    ),
    '0 9 * * 1-5 Asia/Jakarta · docker/api-dev · ticket + session · not run yet · next @02:00',
  );
  assert.equal(
    detailText(
      row({
        kind: 'trigger',
        interval_ms: null,
        source: 'ci_failed',
        action: 'session',
        state: 'disabled',
        next_run: '2026-10-17T02:00:00.000Z',
      }),
      ago,
    ),
    'on a failed CI run · session · not run yet',
    'no next run for what is off',
  );
  assert.equal(
    detailText(
      row({ kind: 'helper', module: 'supervisor', owner: 'coordinator', interval_ms: 3_600_000, last_run: '2026-10-17T11:00:00.000Z' }),
      ago,
    ),
    'every 1 h · coordinator · last @11:00',
  );
});

test('only triggers have actions; a webhook trigger cannot be run by hand', () => {
  const cron = row({ id: 'trigger:trg_1', kind: 'trigger', source: 'cron', enabled: true });
  assert.deepEqual([canSwitch(cron), canRunNow(cron), triggerIdOf(cron)], [true, true, 'trg_1']);
  assert.deepEqual(
    [
      canSwitch(row({ kind: 'trigger', source: 'webhook', enabled: false })),
      canRunNow(row({ kind: 'trigger', source: 'webhook', enabled: false })),
    ],
    [true, false],
  );
  assert.deepEqual(
    [canSwitch(row({})), canRunNow(row({})), canSwitch(row({ kind: 'helper' })), canRunNow(row({ kind: 'helper' }))],
    [false, false, false, false],
  );
});

test('everyText', () => {
  assert.deepEqual(
    [everyText(30_000), everyText(90_000), everyText(300_000), everyText(21_600_000), everyText(86_400_000), everyText(172_800_000)],
    ['every 30 s', 'every 90 s', 'every 5 min', 'every 6 h', 'daily', 'every 2 d'],
  );
});

test('a failed load is an error with its reason, never an empty list (T-965 UX finding)', async () => {
  const reason = (e: unknown) => (e instanceof Error ? e.message : 'No answer from the portal.');
  const [failed, offline, none, some] = await Promise.allSettled([
    Promise.reject(new Error('Server error (502)')),
    Promise.reject('offline'),
    Promise.resolve([] as ScheduleRow[]),
    Promise.resolve([base]),
  ]);
  const err = settleList(failed, reason);
  assert.deepEqual(err, { status: 'error', message: 'Server error (502)' });
  assert.notEqual(err.status, 'ready', 'a rejected load must not become a list the page calls empty');
  assert.deepEqual(settleList(offline, reason), { status: 'error', message: 'No answer from the portal.' });
  assert.deepEqual(settleList(none, reason), { status: 'ready', items: [] });
  assert.deepEqual(settleList(some, reason), { status: 'ready', items: [base] });
});

// ---- T-2950: the detail sheet and the triggers editor.

test('the detail sheet lists what the server sent and leaves out what it did not; next run only while it runs', () => {
  const trig = row({ id: 'trigger:t1', kind: 'trigger', name: 'Nightly', module: 'triggers', interval_ms: null, cron: { expr: '0 3 * * *', tz: 'UTC' }, source: 'cron', target: 'docker/api', action: 'ticket_session', owner: 'u_a', last_run: '2026-10-17T03:00:00.000Z', last_result: 'ok', next_run: '2026-10-18T03:00:00.000Z', enabled: true });
  assert.deepEqual(detailRows(trig, ago), [
    { label: 'Kind', value: 'Trigger' },
    { label: 'State', value: 'OK' },
    { label: 'Source', value: 'cron' },
    { label: 'Schedule', value: '0 3 * * * (UTC)' },
    { label: 'Workspace', value: 'docker/api' },
    { label: 'Action', value: 'Ticket + session' },
    { label: 'Owner', value: 'u_a' },
    { label: 'Last run', value: '@03:00' },
    { label: 'Result', value: 'OK' },
    { label: 'Next run', value: '@03:00' },
  ]);
  assert.ok(!detailRows({ ...trig, state: 'disabled' }, ago).some((d) => d.label === 'Next run'), 'an off trigger has no next run');
  const loop = detailRows(row({ state: 'failing', last_run: '2026-10-17T12:00:00.000Z', last_result: 'failed', last_error: 'boom' }), ago);
  assert.deepEqual(loop.map((d) => d.label), ['Kind', 'State', 'Module', 'Runs', 'Last run', 'Result', 'Error']);
  assert.equal(loop.find((d) => d.label === 'Runs')!.value, 'every 1 min');
  assert.equal(detailRows(row({}), ago).find((d) => d.label === 'Last run')!.value, 'Not yet');
  assert.equal(canEdit(trig), true);
  assert.equal(canEdit(row({})), false, 'a loop is code, not editable');
});

const trigger = (o: Partial<Trigger> = {}): Trigger =>
  ({
    id: 'trg_a',
    ownerId: 'u_a',
    name: 'Nightly',
    enabled: true,
    source: 'cron',
    cron: { expr: '0 3 * * *', tz: 'Asia/Jakarta', catchUp: 'once' },
    webhook: null,
    ciFailed: null,
    action: { type: 'ticket', workspaceId: 'docker/api', claudeId: 'c1', cwd: '/w', worktree: false, permissionMode: 'plan', template: 'Do it', ticket: { type: 'bug', priority: 'high', tags: ['x'], assignTo: 'owner' } },
    ...o,
  }) as Trigger;

test('the editor: a new trigger is a cron trigger; a change keeps the action fields the form does not show', () => {
  const f = { ...emptyTriggerForm('docker/api'), name: '  Nightly  ', expr: '0  4 * * *', template: 'Check it' };
  assert.deepEqual(triggerBody(f, null), {
    name: 'Nightly',
    enabled: true,
    source: 'cron',
    cron: { expr: '0 4 * * *', tz: '', catchUp: 'skip' },
    action: { type: 'session', workspaceId: 'docker/api', claudeId: null, cwd: null, worktree: true, permissionMode: 'default', template: 'Check it', ticket: null },
  });
  const t = trigger();
  const edit = triggerBody({ ...formFromTrigger(t), template: 'Do it now' }, t) as { action: Trigger['action']; cron: unknown; source?: unknown };
  assert.equal(edit.source, undefined, 'the source never changes');
  assert.deepEqual(edit.cron, { expr: '0 3 * * *', tz: 'Asia/Jakarta', catchUp: 'once' });
  assert.deepEqual(edit.action, { ...t.action, template: 'Do it now' }, 'Claude, folder, worktree, mode and ticket kept');
  const ci = trigger({ source: 'ci_failed', cron: null });
  assert.equal('cron' in triggerBody(formFromTrigger(ci), ci), false, 'a CI trigger gets no cron');
  assert.equal((triggerBody({ ...formFromTrigger(t), action: 'session' }, t) as { action: Trigger['action'] }).action.ticket, null);
});

test('the editor catches the empty form; the server’s field errors map onto the fields', () => {
  assert.deepEqual(Object.keys(formProblems(emptyTriggerForm(), true)).sort(), ['action.workspaceId', 'name']);
  assert.ok(formProblems({ ...emptyTriggerForm('docker/api'), name: 'x', expr: '0 3 * *' }, true)['cron.expr']);
  assert.deepEqual(formProblems({ ...emptyTriggerForm('docker/api'), name: 'x', expr: '' }, false), {}, 'no cron for another source');
  assert.ok(formProblems({ ...emptyTriggerForm('docker/api'), name: 'x'.repeat(61) }, true).name);
  assert.deepEqual(detailErrors({ name: 'Too long', 'cron.expr': 'Bad', n: 3 }), { name: 'Too long', 'cron.expr': 'Bad' });
  assert.deepEqual(detailErrors(null), {});
  assert.deepEqual(detailErrors(['x']), {});
});
