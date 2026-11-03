// WebMCP auto-approve in the panel (PILOT-1128): which grant answers an ask (group, expiry), the indicator and the Settings lines.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReporterAgentGrant } from '@portal/contracts';
import { grantFor, grantLine, indicatorText, liveGrants, untilText } from './agentGrants';

const NOW = Date.parse('2026-11-03T10:00:00');
const g = (over: Partial<ReporterAgentGrant>): ReporterAgentGrant => ({
  id: 'rag_1',
  group: 'file',
  scope: 'session',
  bucketKey: 'WMCP',
  origin: 'http://127.0.0.1:4700',
  createdAt: new Date(NOW - 60_000).toISOString(),
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
  ...over,
});

test('grantFor: the grant of the ask’s group that is still in time, else null (the sheet asks)', () => {
  const grants = [g({ id: 'a', group: 'file' }), g({ id: 'b', group: 'comment', expiresAt: new Date(NOW - 1).toISOString() })];
  assert.equal(grantFor(grants, 'file', NOW)?.id, 'a');
  assert.equal(grantFor(grants, 'comment', NOW), null, 'expired');
  assert.equal(grantFor(grants, 'attach', NOW), null, 'another group');
  assert.equal(grantFor([], 'file', NOW), null);
  assert.deepEqual(
    liveGrants(grants, NOW).map((x) => x.id),
    ['a'],
  );
});

test('indicator: on while any grant is in time, naming its groups; off with none', () => {
  assert.equal(indicatorText([], NOW), null);
  assert.equal(indicatorText([g({ expiresAt: new Date(NOW - 1).toISOString() })], NOW), null);
  assert.equal(
    indicatorText(
      [g({ group: 'file' }), g({ id: 'x', group: 'comment', scope: 'always' }), g({ id: 'y', group: 'file', scope: 'always' })],
      NOW,
    ),
    'Agent auto-approve on: file reports, comment',
  );
});

test('Settings lines: group, scope and until (a time today, a date later)', () => {
  assert.equal(grantLine(g({ expiresAt: new Date(NOW + 2 * 3_600_000).toISOString() }), NOW), 'file reports · this session · until 12:00');
  assert.equal(
    grantLine(g({ group: 'attach', scope: 'always', expiresAt: '2026-12-03T10:00:00' }), NOW),
    'attach screenshots · this site · until 3 Dec',
  );
  assert.equal(untilText('2026-11-03T23:05:00', NOW), 'until 23:05');
});
