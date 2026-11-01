import type { Workspace, WorkspaceUsage } from '@portal/contracts';
import { api } from '@/lib/api';
import { scopedPush } from '@/lib/orgContext';
import { createLiveStore } from '../shared/liveStore';

export interface WorkspacesData {
  list: Workspace[];
  /** CPU and memory as the portal last pushed them (live topic `usage`, sent while something runs); empty until then. */
  usage: WorkspaceUsage[];
}

let pushedIds = '';

/**
 * The workspaces list of the context (lib/orgContext), kept fresh by the live topic `workspaces` (it carries every workspace the person may
 * see, so it only updates the context's own rows, `scopedPush`) and `usage` (it carries the measurements).
 */
export const workspacesStore = createLiveStore<WorkspacesData>({
  load: async (prev) => ({ list: await api.workspaces.list(), usage: prev?.usage ?? [] }),
  topics: ['workspaces', 'usage'],
  scoped: true,
  apply: (msg, prev) => {
    if (msg.type === 'workspaces') {
      const { next, ids } = scopedPush(msg.data, prev?.list ?? null, pushedIds);
      pushedIds = ids;
      return next && prev ? { ...prev, list: next } : null;
    }
    if (msg.type === 'usage' && prev) return { ...prev, usage: msg.data };
    return null;
  },
});
