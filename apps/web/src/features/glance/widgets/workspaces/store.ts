import type { Workspace, WorkspaceUsage } from '@portal/contracts';
import { api } from '@/lib/api';
import { createLiveStore } from '../shared/liveStore';

export interface WorkspacesData {
  list: Workspace[];
  /** CPU and memory as the portal last pushed them (live topic `usage`, sent while something runs); empty until then. */
  usage: WorkspaceUsage[];
}

/** The workspaces list, kept fresh by the live topic `workspaces` (it carries the list) and `usage` (it carries the measurements). */
export const workspacesStore = createLiveStore<WorkspacesData>({
  load: async (prev) => ({ list: await api.workspaces.list(), usage: prev?.usage ?? [] }),
  topics: ['workspaces', 'usage'],
  apply: (msg, prev) => {
    if (msg.type === 'workspaces') return { list: msg.data, usage: prev?.usage ?? [] };
    if (msg.type === 'usage' && prev) return { ...prev, usage: msg.data };
    return null;
  },
});
