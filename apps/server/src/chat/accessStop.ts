// Organizations slice 7 (docs/prd/organizations.md §13.2 row 7, Sharing "revoking ends access at once, running sessions included"): when a
// share of a WORKSPACE ends for a person (`share_ended`), their running sessions in that workspace stop if they may no longer operate it.
// Deliberately narrow, so it can never stop sessions by mistake: only a `share_ended` change that names a workspace, only when the workspace
// still resolves (a missing one or a database that cannot be read decides nothing), only sessions that person started, and only after the
// one `can()` says they lost `operate` there. Sockets re-check on their own (chat/socket.ts, live.ts).

import { FOUNDING_USER_ID, workspaceRef, type UserId } from '@portal/contracts';
import { canUser, onAccessChange, resolve, type AccessChange } from '../authz/seam.js';

export interface AccessStopDeps {
  /** Sessions in a workspace that are not ended: id and the account that started it (null: the founding user / server code). */
  running(workspaceId: string): { id: string; startedBy: string | null }[];
  end(sessionId: string): Promise<void>;
}

export function stopSessionsOnAccessLoss(deps: AccessStopDeps): () => void {
  return onAccessChange((c: AccessChange) => {
    if (c.why !== 'share_ended' || c.ref?.type !== 'workspace') return;
    const ws = resolve(workspaceRef(c.ref.id));
    if (!ws) return;
    if (canUser(c.userId, 'operate', ws.ref)) return;
    for (const s of deps.running(ws.ref.id)) {
      const starter = (s.startedBy ?? FOUNDING_USER_ID) as UserId;
      if (starter !== c.userId) continue;
      void deps.end(s.id).catch((e: unknown) => console.error(`[chat] a session could not be stopped after a share ended: ${(e as Error).message}`));
    }
  });
}
