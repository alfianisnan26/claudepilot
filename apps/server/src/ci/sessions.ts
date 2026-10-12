// The one place CI touches chat sessions (interface I10 with the chat area): find the session that owns a branch, and tell it a
// run failed as a portal message. CI talks to `CiSessionsPort`; a fake stands in for it in tests and nothing else imports the controller.
import { randomUUID } from 'node:crypto';
import { isChatActor } from '@portal/contracts';
import type { ChatController } from '../chat/controller.js';

export interface CiSession {
  id: string;
  title: string;
  ticketId: string | null;
  /** The branch of its git worktree, when it has one. */
  branch: string | null;
  /** Not ended: a message can reach it. */
  live: boolean;
}

export interface CiSessionsPort {
  /** The session whose worktree is on `branch` in a workspace: a live one if there is one, else the latest. */
  byBranch(workspaceId: string, branch: string): CiSession | null;
  get(sessionId: string): CiSession | null;
  /** Sends the text to the session as a portal message from the run (it queues behind the turn in progress). Throws when the session refuses. */
  send(sessionId: string, runId: string, text: string): Promise<void>;
}

/** `ci:<run id>` once the chat area allows that actor; until then `portal:ci-<run id>`, which its pattern already does. */
export const ciActor = (runId: string): string => (isChatActor(`ci:${runId}`) ? `ci:${runId}` : `portal:ci-${runId}`);

/** The real thing, over the chat controller. */
export class ChatSessionsAdapter implements CiSessionsPort {
  constructor(private readonly chat: ChatController) {}

  #view(s: ReturnType<ChatController['get']>): CiSession | null {
    return s ? { id: s.id, title: s.title, ticketId: s.ticketId ?? null, branch: s.worktree?.branch ?? null, live: s.state !== 'ended' } : null;
  }

  byBranch(workspaceId: string, branch: string): CiSession | null {
    const mine = this.chat.list({ workspaceId }).filter((s) => s.worktree?.branch === branch);
    // `list` is newest activity first.
    return this.#view(mine.find((s) => s.state !== 'ended') ?? mine[0] ?? null);
  }

  get(sessionId: string): CiSession | null {
    return this.#view(this.chat.get(sessionId));
  }

  async send(sessionId: string, runId: string, text: string): Promise<void> {
    await this.chat.send(sessionId, randomUUID(), text, { actor: ciActor(runId), actorLabel: 'CI', priority: 'later' });
  }
}

/** For tests: sessions by branch, and a record of what was sent. */
export class FakeSessions implements CiSessionsPort {
  readonly sessions = new Map<string, CiSession & { workspaceId: string }>();
  readonly sent: { sessionId: string; runId: string; text: string }[] = [];
  failSend: Error | null = null;

  add(s: Partial<CiSession> & { id: string; workspaceId: string; branch: string | null }): void {
    this.sessions.set(s.id, { title: `Session ${s.id}`, ticketId: null, live: true, ...s });
  }

  byBranch(workspaceId: string, branch: string): CiSession | null {
    return [...this.sessions.values()].find((s) => s.workspaceId === workspaceId && s.branch === branch) ?? null;
  }

  get(sessionId: string): CiSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async send(sessionId: string, runId: string, text: string): Promise<void> {
    if (this.failSend) throw this.failSend;
    this.sent.push({ sessionId, runId, text });
  }
}
