// Chat sessions and the authorization layer (docs/prd/authorization.md, multi-user PRD §14). A session is read through ONE resolver, so `can()`
// decides who may view or operate it before any handler touches it, and the chat socket is declared once. Today the portal has one person, so the
// resolver says every session is the founding user's (until `chat_sessions` records an owner); the seam already refuses another user (`u_a`) on a
// session that exists, which is how the tests run the abuse cases across users.

import { CHAT_SOCKET_PATH, FOUNDING_USER_ID, sessionRef, workspaceRef } from '@portal/contracts';
import { declarePolicies, registerResolver, type ObjectResolver } from '../authz/seam.js';

/** What the resolver needs of a session; the controller answers it. */
export interface SessionFacts {
  /** The session's current id (an alias of a folded session followed). */
  id: string;
  workspaceId: string;
  /** The user who created it, or null before sessions record one: the founding user. */
  ownerId: string | null;
}

/**
 * The `session` resolver: the creator owns it (private unless shared), its parent is its workspace (operating a session also needs `operate`
 * on that workspace: the guard in OBJECT_TYPES). Cheap and synchronous, and never reads a message.
 */
export function sessionResolver(facts: (id: string) => SessionFacts | null): ObjectResolver {
  return {
    type: 'session',
    resolve(id) {
      const f = facts(id);
      if (!f) return null;
      return { ref: sessionRef(f.id), owner: { kind: 'user', id: f.ownerId ?? FOUNDING_USER_ID }, parent: workspaceRef(f.workspaceId), attrs: { workspaceId: f.workspaceId } };
    },
  };
}

/**
 * Registers the resolver and declares the chat socket (the handshake needs a signed-in person; each message that names a session checks it itself:
 * `requireCan(actor, 'operate', sessionRef(id))`, as the side question messages do). One call at start-up (index.ts).
 */
export function registerChatAuthz(facts: (id: string) => SessionFacts | null): void {
  registerResolver(sessionResolver(facts));
  declarePolicies('chat', {
    'ALL /api/chat/live': { kind: 'signed-in' },
    // A sub-agent's own transcript: whoever may view the session (the Agents panel's detail view).
    'GET /api/chat/sessions/:id/tasks/:taskId/events': { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }] },
  });
}

/** The key the socket is declared under: the contract's path, so a test can pin them together. */
export const CHAT_SOCKET_POLICY_KEY = `ALL ${CHAT_SOCKET_PATH}`;
