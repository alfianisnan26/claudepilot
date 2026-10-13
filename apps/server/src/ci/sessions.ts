// The one place CI touches chat sessions (interface I10 with the chat area): find the session that owns a branch, and tell it how
// a run went as a portal message. CI talks to `CiSessionsPort`; a fake stands in for it in tests and nothing else imports the controller.
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
  /**
   * The session as it is now, resolved at the time of asking: a chat that moved to another Claude is found under the id it goes by now
   * (an id folded by a Move, or the end of a legacy successor chain), so `id` may differ from the one asked for.
   */
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
    // A folded id resolves to the chat that took it in; a legacy pair not folded yet is followed to its end (a few hops at most).
    let s = this.chat.get(this.chat.resolve(sessionId));
    const seen = new Set<string>();
    while (s?.successorId && !seen.has(s.id) && seen.size < 8) {
      seen.add(s.id);
      const next = this.chat.get(this.chat.resolve(s.successorId));
      if (!next) break;
      s = next;
    }
    return this.#view(s);
  }

  async send(sessionId: string, runId: string, text: string): Promise<void> {
    await this.chat.send(sessionId, randomUUID(), text, { actor: ciActor(runId), actorLabel: 'CI', priority: 'later' });
  }
}

/** For tests: sessions by branch, and a record of what was sent. */
export class FakeSessions implements CiSessionsPort {
  readonly sessions = new Map<string, CiSession & { workspaceId: string }>();
  readonly sent: { sessionId: string; runId: string; text: string }[] = [];
  /** Old id -> the id the chat goes by now (a Move folded it). */
  readonly moved = new Map<string, string>();
  failSend: Error | null = null;

  add(s: Partial<CiSession> & { id: string; workspaceId: string; branch: string | null }): void {
    this.sessions.set(s.id, { title: `Session ${s.id}`, ticketId: null, live: true, ...s });
  }

  byBranch(workspaceId: string, branch: string): CiSession | null {
    return [...this.sessions.values()].find((s) => s.workspaceId === workspaceId && s.branch === branch) ?? null;
  }

  get(sessionId: string): CiSession | null {
    let id = sessionId;
    for (let i = 0; i < 8 && this.moved.has(id); i++) id = this.moved.get(id)!;
    return this.sessions.get(id) ?? null;
  }

  async send(sessionId: string, runId: string, text: string): Promise<void> {
    if (this.failSend) throw this.failSend;
    if (!this.sessions.has(sessionId)) throw new Error(`No session ${sessionId}: send to the id it goes by now.`);
    this.sent.push({ sessionId, runId, text });
  }
}
