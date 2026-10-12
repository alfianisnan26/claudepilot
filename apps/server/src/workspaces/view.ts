import type { Workspace, WorkspaceClaudeBrief, WorkspaceDeliveryState } from '@portal/contracts';
import type { AccountPools } from '../accounts/pools.js';
import type { Reconciler } from '../delivery/reconciler.js';

/** What was last delivered into a workspace (foundation PRD §5), as the UI shows it. */
export function deliveryState(reconciler: Reconciler, workspaceId: string): WorkspaceDeliveryState | null {
  const row = reconciler.row(workspaceId);
  return row ? { status: row.status, reason: row.reason, appliedAt: row.applied_at, claudeVersion: row.claude_version } : null;
}

/**
 * A workspace as the UI sees it: with its account pool state and delivery status, and its Claude Code version (pinned, running, what looks wrong)
 * when the version module is wired in (claude-version-pinning PRD).
 */
export const workspaceView =
  (pools: AccountPools, reconciler: Reconciler, claude?: (w: Workspace) => WorkspaceClaudeBrief) =>
  (w: Workspace): Workspace => ({ ...w, account: pools.stateFor(w.id), delivery: deliveryState(reconciler, w.id), ...(claude ? { claude: claude(w) } : {}) });
