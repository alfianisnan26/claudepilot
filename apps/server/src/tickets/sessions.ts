import { randomUUID } from 'node:crypto';
import type { ChatSession, TicketSession, TicketSessionState } from '@portal/contracts';
import type { ChatController } from '../chat/controller.js';

// The one place the tickets module touches chat sessions (interface I1 with the chat area). Everything else in
// the module talks to `TicketSessions`, so a fake stands in for it in tests and nothing imports the controller.

/** A session as tickets need it. */
export interface TicketSessionInfo extends TicketSession {
  ticketId: string | null;
}

/** Creating the session a ticket starts (tickets PRD FR15). */
export interface CreateSession {
  /** `T-12`: recorded on the session, and the actor the opening message carries is `ticket:T-12`. */
  ticketId: string;
  workspaceId: string;
  claudeId?: string;
  cwd?: string;
  title: string;
  worktree?: { repo?: string; branch?: string; base?: string };
  /** Who starts it, when not the ticket itself: a trigger's `portal:trigger-<id>` (its session then counts as started from outside). */
  actor?: string;
}

export interface TicketSessions {
  get(id: string): TicketSessionInfo | null;
  list(filter?: { workspaceId?: string; ticketId?: string }): TicketSessionInfo[];
  /** Creates the session, its ticket recorded on it. Nothing is sent yet. */
  create(req: CreateSession): Promise<TicketSessionInfo>;
  /** Sends the ticket as a message to the session, as the actor `ticket:<id>`; `label` is what the transcript calls the sender. */
  send(sessionId: string, ticketId: string, text: string, label: string): Promise<void>;
  /** Calls `cb` whenever a session changes (created, a new state, ended). Returns an unsubscribe. */
  onSession(cb: (session: TicketSessionInfo) => void): () => void;
}

function info(s: ChatSession): TicketSessionInfo {
  return {
    id: s.id,
    title: s.title,
    state: s.state as TicketSessionState,
    workspaceId: s.workspaceId,
    lastActivityAt: s.lastActivityAt,
    endedReason: s.endedReason,
    worktree: s.worktree ? { branch: s.worktree.branch, path: s.worktree.path } : null,
    ticketId: s.ticketId ?? null,
  };
}

/** The real adapter, over the chat controller. */
export class ChatTicketSessions implements TicketSessions {
  constructor(private readonly chat: ChatController) {}

  get(id: string): TicketSessionInfo | null {
    const s = this.chat.get(id);
    return s ? info(s) : null;
  }

  list(filter: { workspaceId?: string; ticketId?: string } = {}): TicketSessionInfo[] {
    return this.chat.list(filter).map(info);
  }

  async create(req: CreateSession): Promise<TicketSessionInfo> {
    const session = await this.chat.create(
      { workspaceId: req.workspaceId, title: req.title, cwd: req.cwd, claudeId: req.claudeId, ticketId: req.ticketId, ...(req.worktree ? { worktree: req.worktree } : {}) },
      { actor: req.actor ?? `ticket:${req.ticketId}` },
    );
    return info(session);
  }

  async send(sessionId: string, ticketId: string, text: string, label: string): Promise<void> {
    await this.chat.send(sessionId, randomUUID(), text, { actor: `ticket:${ticketId}`, actorLabel: label });
  }

  onSession(cb: (session: TicketSessionInfo) => void): () => void {
    return this.chat.onEvent((_id, msg) => {
      if (msg.type === 'session') cb(info(msg.session));
    });
  }
}
