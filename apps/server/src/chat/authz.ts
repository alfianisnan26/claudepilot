// Chat sessions and the authorization layer (docs/prd/authorization.md, multi-user PRD §14). A session is read through ONE resolver, so `can()`
// decides who may view or operate it before any handler touches it, and the chat socket is declared once. Today the portal has one person, so the
// resolver says every session is the founding user's (until `chat_sessions` records an owner); the seam already refuses another user (`u_a`) on a
// session that exists, which is how the tests run the abuse cases across users.

import { CHAT_SOCKET_PATH, FOUNDING_USER_ID, sessionRef, workspaceRef, type RoutePolicies, type RoutePolicy, type ToolPolicies } from '@portal/contracts';
import { declarePolicies, declareToolPolicies, registerResolver, type ObjectResolver } from '../authz/seam.js';
import type { SocketPolicies } from '../authz/socketGuard.js';

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
  declareChatPolicies();
  declareToolPolicies('chat', CHAT_RECOVER_TOOL_POLICIES);
}

/** The chat routes' declarations alone (T-1043 S0a: the route guard needs them whichever way the app was built). */
export function declareChatPolicies(): void {
  declarePolicies('chat', CHAT_POLICIES);
}

export const CHAT_POLICIES: RoutePolicies = {
  'ALL /api/chat/live': { kind: 'signed-in' },
  // The stored transcript (whole after a seq, or a page; T-376) and one event of it whole: whoever may view the session.
  'GET /api/chat/sessions/:id/events': { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }] },
  'GET /api/chat/sessions/:id/events/:seq': { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }] },
  // A sub-agent's own transcript: whoever may view the session (the Agents panel's detail view).
  'GET /api/chat/sessions/:id/tasks/:taskId/events': { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }] },
  // T-102: a restart (now, queued, or interrupting the turn), cancelling a queued one and the restart hint's memory operate the session.
  'POST /api/chat/sessions/:id/restart': { kind: 'objects', checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }] },
  'DELETE /api/chat/sessions/:id/restart': { kind: 'objects', checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }] },
  'PATCH /api/chat/sessions/:id/restart-hint': { kind: 'objects', checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }] },
  // T-294: a session's limits (workers at once, sub-agents) widen or narrow what it may start: `manage` (a person, an admin's token), audited.
  'PATCH /api/chat/sessions/:id/limits': { kind: 'objects', checks: [{ type: 'session', verb: 'manage', from: 'path', param: 'id' }], audit: 'session.limits' },
  // T-136: recover in place (an ended-for-integrity session comes back as the same row): operates the session; audited by the controller.
  'POST /api/chat/sessions/:id/recover': { kind: 'objects', checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }], audit: 'session.recover' },
  // T-284: clearing a request no process can answer any more operates the session; the controller audits what it resolved (session.request_stale).
  'POST /api/chat/sessions/:id/requests/:requestId/clear': {
    kind: 'objects',
    checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }],
    audit: 'session.request_clear',
  },
};

/**
 * T-136: `session_recover` reaches an ended session of the agent's own workspace (another workspace's: not found); always confirmed; audited.
 * T-284: `session_request_clear` reaches a chat of the agent's own workspace the same way (another workspace's: not found); no confirmation
 * (it never touches a request of the live process, which is answered instead); audited.
 */
export const CHAT_RECOVER_TOOL_POLICIES = {
  session_recover: { kind: 'agent', reach: 'workspace', confirm: true, audit: 'session.recover' },
  session_request_clear: { kind: 'agent', reach: 'workspace', audit: 'session.request_clear' },
} satisfies ToolPolicies;

/** The key the socket is declared under: the contract's path, so a test can pin them together. */
export const CHAT_SOCKET_POLICY_KEY = `ALL ${CHAT_SOCKET_PATH}`;

const onSession = (verb: 'view' | 'operate'): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'session', verb, from: 'body', param: 'session' }] });

/**
 * T-1043 S0b: the chat socket (socket.ts). The handshake needs someone signed in; each message names its session in `session`: watching it is
 * `view`, anything that acts on it (a message, an answer, a control, a side question) `operate`, as its HTTP routes are.
 */
export const CHAT_SOCKET_POLICIES: SocketPolicies = {
  [CHAT_SOCKET_PATH]: {
    connect: { kind: 'signed-in' },
    messages: {
      subscribe: onSession('view'),
      unsubscribe: { kind: 'signed-in' },
      send: onSession('operate'),
      respond: onSession('operate'),
      control: onSession('operate'),
      btw_ask: onSession('operate'),
      btw_cancel: onSession('operate'),
      btw_close: onSession('operate'),
      btw_pin: onSession('operate'),
    },
  },
};
