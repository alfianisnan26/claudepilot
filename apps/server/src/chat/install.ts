import type { Workspaces } from '../workspaces/manager.js';
import { CP_SESSION, CP_SESSION_PATH } from './host.js';

const TMP_PATH = '/etc/claudepilot/bin/.cp-session.cp-tmp';

/**
 * Installs the session host (`/etc/claudepilot/bin/cp-session`, root-owned so the agent can't change
 * it) into a workspace before a chat session starts. Pool delivery only reaches workspaces with a
 * pool, and chat also runs in workspaces signed in with a person's own Claude account, so the chat
 * controller installs it itself. The file is staged under a temp name and renamed as root, so a
 * concurrent call never runs half a script. Docker only for now (Kubernetes delivery is F3).
 */
export function hostInstaller(workspaces: Workspaces) {
  // No cache: a workspace removed and recreated under the same name starts without it.
  return async (workspaceId: string): Promise<void> => {
    const slash = workspaceId.indexOf('/');
    const target = workspaceId.slice(0, slash);
    const name = workspaceId.slice(slash + 1);
    const access = workspaces.runtimeFor(target)?.delivery;
    if (!access) throw new Error('Chat sessions run on Docker workspaces for now; Kubernetes comes with its delivery.');
    const current = await access.read(name, CP_SESSION_PATH).catch(() => null);
    if (current !== CP_SESSION) {
      await access.put(name, [
        { path: '/etc/claudepilot', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
        { path: '/etc/claudepilot/bin', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
        { path: TMP_PATH, type: 'file', content: CP_SESSION, mode: 0o755, uid: 0, gid: 0 },
      ]);
      const r = await access.run(name, `mv -f '${TMP_PATH}' '${CP_SESSION_PATH}'`, { user: 'root' });
      if (r.code !== 0) throw new Error(`Installing the session host failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
  };
}
