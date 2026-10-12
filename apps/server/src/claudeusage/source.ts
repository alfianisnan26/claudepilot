// Claude usage: how the service sees the rest of the portal (docs/prd/claude-usage.md §7). Two narrow reads of other
// areas, so none of their code is touched: the workspaces (are they running, run a command in one) and the Claudes the
// chat controller keeps per workspace (id, name, directory; and which Claude a live session runs in).

import type { WorkspaceClaude } from '@portal/contracts';
import type { Workspaces } from '../workspaces/manager.js';
import type { UsageSource } from './service.js';

/** The part of the chat controller this module reads. */
export interface ClaudeDirectory {
  listClaudes(workspaceId: string): WorkspaceClaude[];
  get(sessionId: string): { workspaceId: string; claudeId: string } | null;
}

export function usageSource(workspaces: Pick<Workspaces, 'list' | 'exec'>, chat: ClaudeDirectory, pooled: (workspaceId: string) => boolean): UsageSource {
  const nameOf = (workspaceId: string) => workspaceId.split('/').pop() ?? workspaceId;
  return {
    async claudes() {
      const out = [];
      for (const w of await workspaces.list()) {
        let claudes: WorkspaceClaude[];
        try {
          claudes = chat.listClaudes(w.id);
        } catch {
          continue; // a workspace the chat side doesn't know (yet)
        }
        for (const c of claudes) {
          if (c.removedAt) continue;
          out.push({ id: c.id, name: c.name, directory: c.directory, workspaceId: w.id, workspaceName: w.name, target: w.target, running: w.status === 'running' });
        }
      }
      return out;
    },
    pooled,
    exec: (target, name, command) => workspaces.exec(target, name, command),
    sessionClaude(sessionId, claudeId) {
      const session = chat.get(sessionId);
      if (!session) return null;
      const claudes = chat.listClaudes(session.workspaceId).filter((c) => !c.removedAt);
      const id = claudeId || session.claudeId;
      // A session from before Claudes (no id) ran in Default (Workspace Claudes FR2).
      const claude = id ? claudes.find((c) => c.id === id) : claudes.find((c) => c.directory === '');
      return claude ? { workspaceId: session.workspaceId, claudeId: claude.id, name: claude.name, workspaceName: nameOf(session.workspaceId) } : null;
    },
  };
}
