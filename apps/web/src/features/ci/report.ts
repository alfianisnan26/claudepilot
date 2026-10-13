import { CI_BUMP_MODE_LABEL, type CiRunBump, type CiRunReport } from '@portal/contracts';

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

/** The run page's line about the latest bump into a session (FR37a), or null: "Bumped to a session (Fix)", linking to it. */
export function bumpLine(bumps: CiRunBump[] | undefined): { text: string; sessionId: string | null } | null {
  const last = bumps?.at(-1);
  if (!last) return null;
  const how = CI_BUMP_MODE_LABEL[last.mode] ?? last.mode;
  const more = bumps!.length > 1 ? ` · ${bumps!.length} bumps` : '';
  return last.outcome === 'sent'
    ? { text: `Bumped to a session (${how})${more}`, sessionId: last.sessionId }
    : { text: `Bump not taken (${how})${last.note ? `: ${last.note}` : ''}${more}`, sessionId: null };
}
