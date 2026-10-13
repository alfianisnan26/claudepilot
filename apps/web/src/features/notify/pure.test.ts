import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NotifyDestination, NotifyHistoryItem } from '@portal/contracts';
import { expiryText, hushedText, muteLine, muteWhere } from './mutes';
import { dayLabel, freshItems, newest, resolvedIds, toastText, toastTone } from './inbox';
import { defaultKinds, kindsSummary, MATRIX_KINDS, stateOf, withKind } from './matrix';
import { ACTIVE_MS, presenceOf, samePresence, sessionOfPath } from './presence';
import { deviceName, keyBytes, pushSupport, type PushEnv } from './push';
import { insideWindow, isTime, isZone, quietDefault, quietLine, quietProblem, windowMinutes, zoneList } from './quiet';

const env = (o: Partial<PushEnv> = {}): PushEnv => ({ hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: 'default', subscribed: false, standalone: false, ios: false, ...o });

test('push support states', () => {
  assert.equal(pushSupport(env()), 'off');
  assert.equal(pushSupport(env({ permission: 'granted', subscribed: true })), 'on');
  assert.equal(pushSupport(env({ permission: 'granted', subscribed: false })), 'off');
  assert.equal(pushSupport(env({ permission: 'denied' })), 'blocked');
  assert.equal(pushSupport(env({ hasPushManager: false })), 'unsupported');
  assert.equal(pushSupport(env({ hasNotification: false, permission: null })), 'unsupported');
  assert.equal(pushSupport(env({ ios: true, standalone: false, hasPushManager: false })), 'install');
  assert.equal(pushSupport(env({ ios: true, standalone: true })), 'off');
});

test('key bytes: base64url of a 65-byte key, and padding forms', () => {
  const bytes = new Uint8Array(65).map((_, i) => (i * 7) % 256);
  const b64url = Buffer.from(bytes).toString('base64url');
  assert.deepEqual([...keyBytes(b64url)], [...bytes]);
  assert.deepEqual([...keyBytes('-_8')], [0xfb, 0xff]);
});

test('device names', () => {
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/150.0 Mobile Safari/537.36'), 'Chrome · Android');
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 Version/18.4 Mobile/15E148 Safari/604.1'), 'Safari · iOS');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/150 Safari/537.36 Edg/150'), 'Edge · Windows');
  assert.equal(deviceName('Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0'), 'Firefox · Linux');
});

test('kinds: order, add, remove, no duplicates', () => {
  assert.deepEqual(withKind(['ci_failed'], 'approval', true), ['approval', 'ci_failed']);
  assert.deepEqual(withKind(['approval', 'ci_failed'], 'approval', false), ['ci_failed']);
  assert.deepEqual(withKind(['approval'], 'approval', true), ['approval']);
  assert.ok(!MATRIX_KINDS.includes('test'));
  assert.equal(MATRIX_KINDS.length, 11);
  // defaults by hand from the contract: everything phase 1 with defaultOn, which is every one except session_done (and test is defaultOn true, phase 1)
  assert.deepEqual(defaultKinds(), ['approval', 'human_request', 'session_failed', 'ci_failed', 'ci_waiting', 'quota_low', 'cost_spike', 'trigger_approval', 'trigger_failed', 'auto_move', 'test']);
  assert.equal(kindsSummary({ kinds: [] }), 'Nothing');
  assert.equal(kindsSummary({ kinds: ['approval', 'ci_failed'] }), '2 of 11');
  assert.equal(kindsSummary({ kinds: [...MATRIX_KINDS] }), 'Everything');
});

test('destination state chip', () => {
  assert.deepEqual(stateOf({ enabled: true, state: 'ok', lastError: null }), { label: 'On', tone: 'success' });
  assert.deepEqual(stateOf({ enabled: true, state: 'failing', lastError: 'timeout' }), { label: 'Failing', tone: 'warning' });
  assert.deepEqual(stateOf({ enabled: true, state: 'disabled', lastError: 'gone' }), { label: 'Stopped', tone: 'danger' });
  assert.deepEqual(stateOf({ enabled: false, state: 'ok', lastError: null }), { label: 'Off', tone: 'neutral' });
});

test('quiet window: 22:00 to 07:00 crosses midnight; start in, end out', () => {
  const q = { start: '22:00', end: '07:00' };
  for (const [t, inside] of [['23:30', true], ['06:59', true], ['07:00', false], ['22:00', true], ['21:59', false], ['12:00', false], ['00:00', true]] as const) assert.equal(insideWindow(q, t), inside, t);
  const day = { start: '09:00', end: '17:00' };
  assert.equal(insideWindow(day, '09:00'), true);
  assert.equal(insideWindow(day, '17:00'), false);
  assert.equal(windowMinutes(q), 9 * 60);
  assert.equal(windowMinutes(day), 8 * 60);
});

test('quiet validation and zones', () => {
  const ok = quietDefault('Asia/Jakarta', ['cost_spike']);
  assert.deepEqual(ok, { enabled: false, start: '22:00', end: '07:00', tz: 'Asia/Jakarta', breakthrough: ['cost_spike'] });
  assert.equal(quietProblem({ ...ok, enabled: true }), null);
  assert.equal(quietProblem({ ...ok, start: '7:00' }), 'Use a time like 22:00.');
  assert.equal(quietProblem({ ...ok, start: '24:00' }), 'Use a time like 22:00.');
  assert.equal(quietProblem({ ...ok, end: '22:00' }), 'Start and end are the same.');
  assert.equal(quietProblem({ ...ok, tz: 'Mars/Olympus' }), 'Pick a time zone.');
  assert.equal(isTime('00:00') && isTime('23:59') && !isTime('23:60') && !isTime(''), true);
  assert.equal(isZone('Europe/London') && isZone('UTC') && !isZone('') && !isZone('nope'), true);
  assert.equal(quietLine({ ...ok, enabled: true }), '22:00 to 07:00 · Asia/Jakarta');
  assert.equal(quietLine(ok), 'Off');
  assert.ok(zoneList('Asia/Jakarta').includes('Asia/Jakarta') && zoneList('x').includes('UTC'));
});

test('presence: active for two minutes after input, never when hidden; the session of a path', () => {
  const base = { visible: true, lastInput: 1_000_000, device: 'dst_1', pathname: '/admin/sessions/s_41' };
  assert.deepEqual(presenceOf({ ...base, now: 1_000_000 + ACTIVE_MS - 1 }), { device: 'dst_1', visible: true, active: true, session: 's_41' });
  assert.equal(presenceOf({ ...base, now: 1_000_000 + ACTIVE_MS }).active, false);
  assert.deepEqual(presenceOf({ ...base, visible: false, now: 1_000_001 }), { device: 'dst_1', visible: false, active: false, session: null });
  assert.equal(sessionOfPath('/admin/sessions'), null);
  assert.equal(sessionOfPath('/admin/sessions/s_1/'), 's_1');
  assert.equal(sessionOfPath('/admin/sessions/s%201'), 's 1');
  assert.equal(sessionOfPath('/admin/sessions/%E0%A4%A'), null);
  assert.equal(sessionOfPath('/admin/tickets/t_1'), null);
  const a = { device: null, visible: true, active: true, session: null };
  assert.equal(samePresence(a, { ...a }), true);
  assert.equal(samePresence(a, { ...a, active: false }), false);
  assert.equal(samePresence(null, a), false);
});

const item = (id: string, at: string, over: Partial<NotifyHistoryItem> = {}): NotifyHistoryItem => ({ id, kind: 'approval', at, title: 'Approval needed', body: 'api-dev', path: '/admin/sessions/s_1', subject: { type: 'session', id: 's_1' }, readAt: null, resolvedAt: null, resolution: null, muted: false, ...over });

test('inbox: fresh items are newer than the mark, unread, oldest first; the first load toasts nothing', () => {
  const items = [item('c', '2026-10-12T10:03:00Z'), item('b', '2026-10-12T10:02:00Z', { readAt: '2026-10-12T10:02:30Z' }), item('a', '2026-10-12T10:01:00Z')];
  assert.deepEqual(freshItems(items, null), []);
  assert.deepEqual(freshItems(items, '2026-10-12T10:00:00Z').map((i) => i.id), ['a', 'c']);
  assert.deepEqual(freshItems(items, '2026-10-12T10:03:00Z'), []);
  assert.equal(newest(items), '2026-10-12T10:03:00Z');
  assert.equal(newest([]), null);
  assert.deepEqual([...resolvedIds([item('x', 'z', { resolvedAt: 'y' }), item('w', 'z')])], ['x']);
});

test('inbox text and tone', () => {
  assert.equal(toastText({ title: 'CI failed', body: 'api-dev · main' }), 'CI failed · api-dev · main');
  assert.equal(toastText({ title: 'Test', body: '' }), 'Test');
  assert.equal(toastTone('ci_failed'), 'error');
  assert.equal(toastTone('approval'), 'success');
});

test('day labels', () => {
  const now = new Date(2026, 9, 12, 15, 0).getTime();
  assert.equal(dayLabel(new Date(2026, 9, 12, 1, 0).toISOString(), now), 'Today');
  assert.equal(dayLabel(new Date(2026, 9, 11, 23, 0).toISOString(), now), 'Yesterday');
  assert.equal(dayLabel(new Date(2026, 9, 1, 12, 0).toISOString(), now), '1 Oct');
});

test('type check of a destination literal used by the matrix', () => {
  const d = { kinds: ['approval'] } as Pick<NotifyDestination, 'kinds'>;
  assert.equal(kindsSummary(d), '1 of 11');
});

test('inbox: a muted item never toasts', () => {
  const items = [item('m', '2026-10-12T10:03:00Z', { muted: true }), item('a', '2026-10-12T10:01:00Z')];
  assert.deepEqual(freshItems(items, '2026-10-12T10:00:00Z').map((i) => i.id), ['a']);
});

test('mute rules in words: kind and scope, where, what is left, what it hushed', () => {
  assert.equal(muteLine({ kind: 'ci_failed', scope: { type: 'pipeline', id: 'claudepilot/deploy', label: 'claudepilot · deploy' } }), 'CI failed · claudepilot · deploy');
  assert.equal(muteLine({ kind: 'session_done', scope: null }), 'Done · all');
  const dests = [{ id: 'dst_1', name: 'iPhone' }];
  assert.equal(muteWhere({ destinationId: null }, dests), 'Everywhere');
  assert.equal(muteWhere({ destinationId: 'dst_1' }, dests), 'iPhone');
  assert.equal(muteWhere({ destinationId: 'dst_2' }, dests), 'A removed device');
  const now = Date.parse('2026-10-12T10:00:00Z');
  assert.equal(expiryText(null, now), 'Forever');
  assert.equal(expiryText('2026-10-12T10:45:00Z', now), '45 min left');
  assert.equal(expiryText('2026-10-12T15:00:00Z', now), '5 h left');
  assert.equal(expiryText('2026-10-15T10:00:00Z', now), '3 d left');
  assert.equal(expiryText('2026-10-12T09:00:00Z', now), 'Ended');
  assert.equal(hushedText(0), 'None hushed yet');
  assert.equal(hushedText(3), 'Hushed 3');
});
