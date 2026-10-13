import { CI_BUMP_MODE_LABEL, type BumpMode, type CiRun, type CiRunSummary } from '@portal/contracts';
import { BumpDialog } from '@/components/BumpDialog';
import { ciApi } from './api';

/** The two ways, in the dialog's one ⓘ (local-git-ci PRD FR37a). */
const HELP: Record<BumpMode, string> = {
  prioritise: 'the session gets CI’s report of the run and acts on it now.',
  ask: 'a question about the run. The session answers in its chat, then carries on.',
};

/** Bump (FR37a): the shared Bump dialog over a run's sessions; the one that started it (or owns its branch) comes first. */
export function RunBumpDialog({ run, onClose, onBumped }: { run: Pick<CiRunSummary, 'id' | 'number' | 'pipeline'> | null; onClose: () => void; onBumped: (r: CiRun) => void }) {
  const id = run?.id ?? '';
  return (
    <BumpDialog
      open={!!run}
      onClose={onClose}
      subject={run ? `${run.pipeline} #${run.number}` : undefined}
      preferredLabel="Its session"
      modeLabels={CI_BUMP_MODE_LABEL}
      modeHelp={HELP}
      load={() => ciApi.bumpTargets(id)}
      onBump={async (req) => onBumped(await ciApi.bump(id, req))}
    />
  );
}
