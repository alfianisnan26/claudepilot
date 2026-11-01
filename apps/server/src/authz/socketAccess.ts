// D-82 S1a (member access): the terminal and the browser's live view are a shell and a screen INSIDE a workspace, so their sockets need
// `operate` on that workspace, asked for the person the handshake's cookie signed in as (the same `can()` as the routes). Until members could
// sign in, a full session (an admin) was enough and nothing asked. The refusal is the same 404 a missing workspace gets. An open socket is cut
// when an access change leaves its person without `operate` there (a share ended, a membership ended, the user disabled).

import type { IncomingMessage } from 'node:http';
import { actorUserId, workspaceRef, type Actor } from '@portal/contracts';
import { actorOfSocket, can, onAccessChange } from './seam.js';

/** The socket's person when they may operate the workspace, else null (not signed in, or no right: the caller answers 401 or 404). */
export function workspaceSocketActor(req: IncomingMessage, authorized: (req: IncomingMessage) => boolean, workspaceId: string): Actor | null {
  const actor = actorOfSocket(req, authorized);
  if (actor.kind === 'anonymous') return null;
  return can(actor, 'operate', workspaceRef(workspaceId)).allow ? actor : null;
}

/** Calls `close` once an access change for this person leaves them without `operate` on the workspace; returns the unsubscribe. */
export function cutOnLostOperate(actor: Actor, workspaceId: string, close: () => void): () => void {
  const userId = actorUserId(actor);
  let done = false;
  const off = onAccessChange((change) => {
    if (done || change.userId !== userId) return;
    if (can(actor, 'operate', workspaceRef(workspaceId)).allow) return;
    done = true;
    close();
  });
  return () => {
    done = true;
    off();
  };
}
