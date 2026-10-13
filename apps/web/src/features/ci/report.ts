import type { CiRunReport } from '@portal/contracts';

const STATE: Record<CiRunReport['state'], string> = { failed: 'Failure', passed: 'Pass', cancelled: 'Cancel', waiting: 'Wait' };
const WHY: Record<CiRunReport['outcome'], string> = {
  sent: 'reported to the session',
  ended: 'not reported, the session has ended',
  refused: 'not reported, the session refused it',
  capped: 'not reported, over the message cap',
  paused: 'not reported, paused after repeated failures',
};

/** The run page's one line about the latest report to the run's session (PRD FR36, FR37), or null when there was none. */
export function reportLine(reports: CiRunReport[] | undefined): { text: string; sessionId: string | null } | null {
  const last = reports?.at(-1);
  if (!last) return null;
  return { text: `${STATE[last.state] ?? 'Run'} ${WHY[last.outcome] ?? last.outcome}`, sessionId: last.outcome === 'sent' ? last.sessionId : null };
}
