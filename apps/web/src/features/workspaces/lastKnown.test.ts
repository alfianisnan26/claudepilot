// T-515: a workspace whose target's API did not answer shows as `unavailable`, with one InfoTip line: the reason and when it was last seen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLastKnownStatus, type Workspace } from '@portal/contracts';
import { bucketOf } from '../glance/widgets/workspaces/model';
import { unavailableNote } from './lastKnown';

const now = Date.parse('2026-10-15T08:06:00.000Z');
const base: Pick<Workspace, 'status' | 'detail' | 'lastSeenAt'> = { status: 'unavailable', detail: 'Timed out', lastSeenAt: '2026-10-15T08:03:00.000Z' };

test('an unavailable workspace says why and when it was last seen, in one line', () => {
  assert.equal(unavailableNote(base, now), 'Timed out · last seen 3 minutes ago');
  assert.equal(unavailableNote({ ...base, detail: 'TLS handshake timeout.  ' }, now), 'TLS handshake timeout · last seen 3 minutes ago');
  assert.equal(unavailableNote({ ...base, detail: undefined, lastSeenAt: undefined }, now), 'No answer · never seen');
});

test('only the unavailable state has the note', () => {
  for (const status of ['running', 'stopped', 'error', 'unreachable', 'creating'] as const) assert.equal(unavailableNote({ ...base, status }, now), null);
});

test('unavailable is a last known state and counts as failing on the glance card', () => {
  assert.equal(isLastKnownStatus('unavailable'), true);
  assert.equal(isLastKnownStatus('unreachable'), true);
  assert.equal(isLastKnownStatus('running'), false);
  assert.equal(bucketOf('unavailable'), 'failing');
});
