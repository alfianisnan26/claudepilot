// Quiet hours, by hand-computed cases (PWA PRD §11.2): evaluated with Intl in the destination's zone, so clock changes never misplace them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QuietHours } from '@portal/contracts';
import { clock, holds, inQuietHours, localMinutes } from './quiet.js';

const q = (start: string, end: string, tz: string, breakthrough: QuietHours['breakthrough'] = ['cost_spike']): QuietHours => ({ enabled: true, start, end, tz, breakthrough });
const at = (iso: string) => new Date(iso);

test('22:00 to 07:00 in Asia/Jakarta (UTC+7, no clock change): 23:30 and 06:59 local are inside, 07:00 and 21:59 are not', () => {
  const w = q('22:00', '07:00', 'Asia/Jakarta');
  assert.equal(inQuietHours(w, at('2026-10-12T16:30:00Z')), true); // 23:30 WIB
  assert.equal(inQuietHours(w, at('2026-10-12T23:59:00Z')), true); // 06:59 WIB
  assert.equal(inQuietHours(w, at('2026-10-13T00:00:00Z')), false); // 07:00 WIB exactly: the end is exclusive
  assert.equal(inQuietHours(w, at('2026-10-12T14:59:00Z')), false); // 21:59 WIB
  assert.equal(inQuietHours(w, at('2026-10-12T15:00:00Z')), true); // 22:00 WIB: the start is inclusive
  assert.equal(inQuietHours({ ...w, enabled: false }, at('2026-10-12T16:30:00Z')), false);
});

test('America/New_York, 2026-03-08 (02:00 EST becomes 03:00 EDT at 07:00Z): 01:00 to 03:30', () => {
  const w = q('01:00', '03:30', 'America/New_York');
  assert.equal(localMinutes(at('2026-03-08T06:59:00Z'), 'America/New_York'), 1 * 60 + 59); // 01:59 EST (UTC-5)
  assert.equal(inQuietHours(w, at('2026-03-08T06:59:00Z')), true);
  assert.equal(localMinutes(at('2026-03-08T07:00:00Z'), 'America/New_York'), 3 * 60); // 03:00 EDT (UTC-4)
  assert.equal(inQuietHours(w, at('2026-03-08T07:00:00Z')), true);
  assert.equal(inQuietHours(w, at('2026-03-08T07:30:00Z')), false); // 03:30 EDT
  assert.equal(inQuietHours(w, at('2026-03-08T05:59:00Z')), false); // 00:59 EST
});

test('America/New_York, 2026-11-01 (02:00 EDT becomes 01:00 EST at 06:00Z): 01:00 to 01:30 happens twice', () => {
  const w = q('01:00', '01:30', 'America/New_York');
  assert.equal(inQuietHours(w, at('2026-11-01T05:15:00Z')), true); // 01:15 EDT
  assert.equal(inQuietHours(w, at('2026-11-01T05:45:00Z')), false); // 01:45 EDT
  assert.equal(inQuietHours(w, at('2026-11-01T06:15:00Z')), true); // 01:15 EST, the second time
  assert.equal(inQuietHours(w, at('2026-11-01T06:45:00Z')), false); // 01:45 EST
});

test('Europe/London, 2026-10-25 (02:00 BST becomes 01:00 GMT at 01:00Z): 22:00 to 07:00', () => {
  const w = q('22:00', '07:00', 'Europe/London');
  assert.equal(inQuietHours(w, at('2026-10-24T21:30:00Z')), true); // 22:30 BST
  assert.equal(inQuietHours(w, at('2026-10-24T20:59:00Z')), false); // 21:59 BST
  assert.equal(inQuietHours(w, at('2026-10-25T06:30:00Z')), true); // 06:30 GMT (a fixed BST offset would say 07:30 and miss it)
  assert.equal(inQuietHours(w, at('2026-10-25T06:59:00Z')), true); // 06:59 GMT
  assert.equal(inQuietHours(w, at('2026-10-25T07:00:00Z')), false); // 07:00 GMT
  assert.equal(clock(at('2026-10-25T06:30:00Z'), 'Europe/London'), '06:30');
});

test('break-through kinds and the test always go; a window of equal ends is empty; a bad zone holds nothing', () => {
  const w = q('22:00', '07:00', 'Asia/Jakarta');
  const night = at('2026-10-12T16:30:00Z');
  assert.equal(holds(w, 'approval', night), true);
  assert.equal(holds(w, 'cost_spike', night), false);
  assert.equal(holds(w, 'test', night), false);
  assert.equal(inQuietHours(q('07:00', '07:00', 'Asia/Jakarta'), night), false);
  assert.equal(inQuietHours(q('22:00', '07:00', 'Mars/Olympus'), night), false);
  // a same-day window: 09:00 to 17:00 UTC
  assert.equal(inQuietHours(q('09:00', '17:00', 'UTC'), at('2026-10-12T12:00:00Z')), true);
  assert.equal(inQuietHours(q('09:00', '17:00', 'UTC'), at('2026-10-12T17:00:00Z')), false);
});
