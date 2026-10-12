import type { Workspace, WorkspaceFact, WorkspaceTarget } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLive } from '@/lib/live';

/**
 * What the Sessions list needs to know about workspaces: is a session's workspace still there, and is
 * it running. A workspace counts as removed only when its target answered and doesn't list it, so a
 * Docker daemon or cluster that is down never makes every session look orphaned. Kept fresh by the
 * live socket's `workspaces` topic.
 */
export function useWorkspaceFacts(): { factOf: (id: string) => WorkspaceFact | undefined; workspaces: Workspace[] | null; loaded: boolean } {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [targets, setTargets] = useState<WorkspaceTarget[] | null>(null);

  useEffect(() => {
    let current = true;
    api.workspaces.list().then(
      (list) => current && setWorkspaces(list),
      () => undefined,
    );
    api.workspaces.targets().then(
      (list) => current && setTargets(list),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  useLive('workspaces', (msg) => setWorkspaces(msg.data));

  const factOf = useCallback(
    (id: string): WorkspaceFact | undefined => {
      if (!workspaces || !targets) return undefined;
      const known = workspaces.find((w) => w.id === id);
      if (known) return { gone: false, status: known.status };
      return targets.find((t) => t.id === id.slice(0, id.indexOf('/')))?.available ? { gone: true } : undefined;
    },
    [workspaces, targets],
  );

  return { factOf, workspaces, loaded: workspaces !== null && targets !== null };
}
