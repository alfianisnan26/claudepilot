// Workspace git: how the portal runs the session host's commands for a workspace (docs/prd/workspace-git.md §12). The same hardened
// script as the chat's Files and Diff and its worktrees (chat/host.ts), reached through the runtime's exec like they are; this module
// only gathers one command's output and makes sure the workspace has the current script first.

import { CP_SESSION_PATH } from '../chat/host.js';
import type { HostRun } from '../chat/worktrees.js';
import type { Workspaces } from '../workspaces/manager.js';

/** A command that outlives this is closed and reads as failed (`code: null`). A scan's own budget is far below it. */
export const HOST_CALL_MS = 170_000;

export interface RepoHost {
  /** The workspace has the current session host (installed when it is out of date). Throws when the workspace can't be reached. */
  ensure(workspaceId: string): Promise<void>;
  run: HostRun;
}

/** A host over the workspaces' runtimes: `install` is the chat's installer (chat/install.ts). */
export function workspacesHost(workspaces: Pick<Workspaces, 'exec'>, install: (workspaceId: string) => Promise<void>, timeoutMs = HOST_CALL_MS): RepoHost {
  return {
    ensure: install,
    async run(workspaceId, args) {
      const slash = workspaceId.indexOf('/');
      // Reading is the workspace's background: at a low priority, so a scan never slows a build or a chat that is running there.
      const command = args[0] === 'repo-find' || args[0] === 'repo-state' ? ['nice', '-n', '10', 'sh', CP_SESSION_PATH, ...args] : ['sh', CP_SESSION_PATH, ...args];
      const exec = await workspaces.exec(workspaceId.slice(0, slash), workspaceId.slice(slash + 1), command);
      const chunks: Buffer[] = [];
      return await new Promise((resolve) => {
        let done = false;
        const finish = (code: number | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          exec.close();
          resolve({ code, out: Buffer.concat(chunks).toString('utf8') });
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        exec.onData((b) => chunks.push(b));
        exec.onExit((code) => finish(code));
      });
    },
  };
}
