// The CI adapter: `ci_failed` when a run ends `failed` (not `cancelled`) and its previous status was not failed. CI has ONE hook slot
// (`CiService.hooks.changed`): the adapter keeps any hook already set (chain-wrap) and triggers read the bus, not the slot.

import type { CiHooks } from '../../ci/service.js';
import type { NotifyBus } from '../bus.js';

export interface CiRunLike {
  id: string;
  number: number;
  workspace_id: string;
  repo: string;
  pipeline: string;
  status: string;
}

export function adaptCi(ci: { hooks: CiHooks }, bus: NotifyBus, passed?: (runId: string) => void): () => void {
  const was = ci.hooks.changed;
  const mine: NonNullable<CiHooks['changed']> = (run, previous) => {
    try {
      was?.(run, previous);
    } finally {
      if (run.status === 'failed' && previous !== 'failed')
        bus.emit({ kind: 'ci_failed', subject: { type: 'ci_run', id: run.id, workspaceId: run.workspace_id }, facts: { workspace: run.workspace_id, repo: run.repo, number: run.number, pipeline: run.pipeline } });
      else if (run.status === 'passed') passed?.(run.id);
    }
  };
  ci.hooks.changed = mine;
  return () => {
    if (ci.hooks.changed === mine) ci.hooks.changed = was;
  };
}
