import { randomUUID } from 'node:crypto';
import type { Workspaces } from '../workspaces/manager.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { CP_SESSION, CP_SESSION_PATH } from './host.js';

/** Why a workspace without delivery (a target that switched it off) can't run chat yet: its image predates the current session host. */
export const IMAGE_HOST_OUTDATED =
  "This workspace's image doesn't have the current chat host yet. It ships with the next workspace image (images/workspace): once that's published, stop and start the workspace to pull it (your home folder stays).";

/**
 * Makes sure a workspace has the current session host (`/etc/claudepilot/bin/cp-session`, root-owned
 * so the agent can't change it) before a chat session starts. The chat controller does this itself,
 * right before each start, rather than leaving it to pool delivery: a start needs the current host
 * then, not whenever the next delivery runs.
 *
 * Runtimes with delivery (Docker, This machine, Kubernetes through `sudo -n`: workspaces/kubernetesDelivery.ts): installs it when missing or
 * out of date. The file is staged under a temp name and renamed as root, so a concurrent call never runs half a script.
 *
 * No delivery (an enrolled target with delivery switched off): the workspace image ships it (images/workspace/cp-session, generated from
 * CP_SESSION), so this only checks that the workspace has the current one.
 */
export function hostInstaller(workspaces: Workspaces) {
  // One install per workspace at a time: sessions started together share it (two concurrent installs
  // once raced on the temp file and failed the second session's start). No cache beyond that: a
  // workspace removed and recreated under the same name starts without the host.
  const inFlight = new Map<string, Promise<void>>();
  return (workspaceId: string): Promise<void> => {
    const running = inFlight.get(workspaceId);
    if (running) return running;
    const p = install(workspaces, workspaceId).finally(() => inFlight.delete(workspaceId));
    inFlight.set(workspaceId, p);
    return p;
  };
}

async function install(workspaces: Workspaces, workspaceId: string): Promise<void> {
  {
    const slash = workspaceId.indexOf('/');
    const target = workspaceId.slice(0, slash);
    const name = workspaceId.slice(slash + 1);
    const access = workspaces.runtimeFor(target)?.delivery;
    if (!access) return checkImageHost(workspaces, target, name);
    const current = await access.read(name, CP_SESSION_PATH).catch(() => null);
    if (current !== CP_SESSION) {
      // A temp name of its own, so even an install from another portal process can't take it.
      const tmp = `/etc/claudepilot/bin/.cp-session.${randomUUID()}.cp-tmp`;
      await access.put(name, [
        { path: '/etc/claudepilot', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
        { path: '/etc/claudepilot/bin', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
        { path: tmp, type: 'file', content: CP_SESSION, mode: 0o755, uid: 0, gid: 0 },
      ]);
      const r = await access.run(name, `mv -f '${tmp}' '${CP_SESSION_PATH}'`, { user: 'root' });
      if (r.code !== 0) throw new Error(`Installing the session host failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
  }
}

/** Reads the image's copy with `cat` (stdout and stderr come merged); anything but CP_SESSION is refused. */
async function checkImageHost(workspaces: Workspaces, target: string, name: string): Promise<void> {
  let exec: ExecSession;
  try {
    exec = await workspaces.exec(target, name, ['cat', CP_SESSION_PATH]);
  } catch {
    // Unreachable (stopped, say): the `start` that follows fails the same way and leaves the session
    // interrupted, so a later send can resume it. Failing here would end the session for good.
    return;
  }
  const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const chunks: Buffer[] = [];
    exec.onData((b) => chunks.push(b));
    exec.onExit((code) => resolve({ code, out: Buffer.concat(chunks).toString('utf8') }));
  });
  if (out === CP_SESSION) return;
  // No exit status means the connection dropped mid-read: that says nothing about the file.
  if (code === null) throw new Error("Couldn't check this workspace's chat host: the connection dropped.");
  throw new Error(IMAGE_HOST_OUTDATED);
}
