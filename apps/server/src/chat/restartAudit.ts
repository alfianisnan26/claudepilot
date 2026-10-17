// T-971 H2: the platform audit line for a restart recovery (one per session a portal start cut off), for the General Manager to read later.
// Kept out of index.ts so a test can see it written (and catch its removal).

export interface RestartRecoveryInfo {
  sessionId: string;
  workspaceId: string;
  result: 'resumed' | 'failed' | 'over_limit' | 'looping' | 'skipped';
  needsBypass: boolean;
  line: string;
}

export interface RestartAuditEntry {
  severity: 'info' | 'medium';
  kind: 'chat.restart_recovery';
  actor: 'portal';
  userId: null;
  subject: string;
  detail: { result: string; needsBypass: boolean; workspace: string; line: string };
}

/** The controller's `onRestartRecovery` hook, writing each line with `record` (the platform audit's). */
export const restartRecoveryAudit =
  (record: (entry: RestartAuditEntry) => unknown) =>
  (i: RestartRecoveryInfo): void => {
    record({
      severity: i.result === 'failed' ? 'medium' : 'info',
      kind: 'chat.restart_recovery',
      actor: 'portal',
      userId: null,
      subject: `session:${i.sessionId}`,
      detail: { result: i.result, needsBypass: i.needsBypass, workspace: i.workspaceId, line: i.line },
    });
  };
