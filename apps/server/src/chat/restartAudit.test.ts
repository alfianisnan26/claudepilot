// T-971 H2: every restart recovery line also goes to the platform audit as `chat.restart_recovery` (the General Manager reads it later).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restartRecoveryAudit, type RestartAuditEntry, type RestartRecoveryInfo } from './restartAudit.js';

const info = (over: Partial<RestartRecoveryInfo> = {}): RestartRecoveryInfo => ({
  sessionId: 'abc-123',
  workspaceId: 'docker/ws1',
  result: 'resumed',
  needsBypass: false,
  line: 'Restart recovery: (abc-123, docker/ws1) resumed.',
  ...over,
});

test('T-971 H2: a recovery writes one platform audit row: kind, subject, the line and the facts, no user', () => {
  const rows: RestartAuditEntry[] = [];
  restartRecoveryAudit((e) => rows.push(e))(info({ needsBypass: true, line: 'the line' }));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    severity: 'info',
    kind: 'chat.restart_recovery',
    actor: 'portal',
    userId: null,
    subject: 'session:abc-123',
    detail: { result: 'resumed', needsBypass: true, workspace: 'docker/ws1', line: 'the line' },
  });
});

test('T-971 H2: only a failed resume is medium severity', () => {
  const rows: RestartAuditEntry[] = [];
  const hook = restartRecoveryAudit((e) => rows.push(e));
  for (const result of ['resumed', 'over_limit', 'looping', 'skipped', 'failed'] as const) hook(info({ result }));
  assert.deepEqual(rows.map((r) => r.severity), ['info', 'info', 'info', 'info', 'medium']);
});
