// The one place CI touches chat sessions (interface I10 with the chat area): find the session that owns a branch, and tell it how
// a run went as a portal message. CI talks to `CiSessionsPort`; a fake stands in for it in tests and nothing else imports the controller.
import { randomUUID } from 'node:crypto';
import { isChatActor, type ChatSessionState } from '@portal/contracts';
import type { ChatController } from '../chat/controller.js';

export interface CiSession {
  id: string;
  title: string;
  ticketId: string | null;
  /** The branch of its git worktree, when it has one; else, for a worker, its folder's branch when it started (T-476). */
  branch: string | null;
  /** T-476: `branch` is the folder's branch at the worker's start, not a git worktree of its own (CI limits such a branch, ci/authz.ts). */
  branchFromFolder?: boolean;
  /** T-476: the folder it runs in, and whether it leads a crew (no parent, and it started at least one worker). Set by `get`. */
  cwd?: string;
  lead?: boolean;
  /** Not ended: a message can reach it. */
  live: boolean;
  /** For the Bump picker (T-32): its state, workspace and last activity. */
  state: ChatSessionState;
  workspaceId: string;
  lastActivityAt: string;
}

/** How a message from a run goes in: `later` (the default) queues behind the turn, `next` steers it; `label` names the sender ("#12"). */
export interface CiSendOptions {
  priority?: 'next' | 'later';
  label?: string;
}

export interface CiSessionsPort {
  /** The session whose worktree is on `branch` in a workspace: a live one if there is one, else the latest. */
  byBranch(workspaceId: string, branch: string): CiSession | null;
  /**
   * The session as it is now, resolved at the time of asking: a chat that moved to another Claude is found under the id it goes by now
   * (an id folded by a Move, or the end of a legacy successor chain), so `id` may differ from the one asked for.
   */
  get(sessionId: string): CiSession | null;
  /** The sessions of a workspace, or of a ticket, newest activity first (the Bump picker). */
  list(filter: { workspaceId?: string; ticketId?: string }): CiSession[];
  /** Sends the text to the session as a portal message from the run (by default it queues behind the turn in progress). Throws when the session refuses. */
  send(sessionId: string, runId: string, text: string, opts?: CiSendOptions): Promise<void>;
  /** T-277 layer 4: the chats attached to a live process right now, in every workspace (read only; the deploy pipeline's record). */
  attached?(): CiAttachedChat[];
}

/** A chat attached to a live Claude Code process, as a deploy records it: ids and facts only, never its title or text. */
export interface CiAttachedChat {
  id: string;
  workspaceId: string;
  claudeId: string;
  /** The permission mode the portal holds for it. */
  mode: string;
  /** The key its `cp-session tail` follower runs with (Claude Code's session id), to count followers in the workspace. */
  tail: string;
  /** The portal's control requests it has not answered yet; null when the portal can not tell. */
  pending: number | null;
}

/** `ci:<run id>` once the chat area allows that actor; until then `portal:ci-<run id>`, which its pattern already does. */
export const ciActor = (runId: string): string => (isChatActor(`ci:${runId}`) ? `ci:${runId}` : `portal:ci-${runId}`);

/** The real thing, over the chat controller. */
export class ChatSessionsAdapter implements CiSessionsPort {
  /** `pending` counts the open control requests per session (chat/liveControls.ts); without it the count is unknown. */
  constructor(
    private readonly chat: ChatController,
    private readonly pending?: (sessionIds: string[]) => Map<string, number> | null,
  ) {}

  attached(): CiAttachedChat[] {
    const live = this.chat.list({}).filter((s) => s.state !== 'ended' && s.process === 'live');
    const open = this.pending ? this.pending(live.map((s) => s.id)) : null;
    return live.map((s) => ({ id: s.id, workspaceId: s.workspaceId, claudeId: s.claudeId, mode: s.mode, tail: s.claudeSessionId, pending: open ? (open.get(s.id) ?? 0) : null }));
  }

  #view(s: ReturnType<ChatController['get']>): CiSession | null {
    return s
      ? { id: s.id, title: s.title, ticketId: s.ticketId ?? null, branch: s.worktree?.branch ?? s.folderBranch ?? null, branchFromFolder: !s.worktree?.branch && !!s.folderBranch, live: s.state !== 'ended', state: s.state, workspaceId: s.workspaceId, lastActivityAt: s.lastActivityAt }
      : null;
  }

  list(filter: { workspaceId?: string; ticketId?: string }): CiSession[] {
    return this.chat.list(filter).map((s) => this.#view(s)!);
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
    const view = this.#view(s);
    return view && s ? { ...view, cwd: s.cwd, lead: !s.parentId && this.chat.list({ parentId: s.id }).length > 0 } : view;
  }

  async send(sessionId: string, runId: string, text: string, opts: CiSendOptions = {}): Promise<void> {
    await this.chat.send(sessionId, randomUUID(), text, { actor: ciActor(runId), actorLabel: opts.label ?? 'CI', priority: opts.priority ?? 'later' });
  }
}

/** For tests: sessions by branch, and a record of what was sent. */
export class FakeSessions implements CiSessionsPort {
  readonly sessions = new Map<string, CiSession & { workspaceId: string }>();
  readonly sent: { sessionId: string; runId: string; text: string; priority: 'next' | 'later'; label: string }[] = [];
  /** Old id -> the id the chat goes by now (a Move folded it). */
  readonly moved = new Map<string, string>();
  failSend: Error | null = null;

  add(s: Partial<CiSession> & { id: string; workspaceId: string; branch: string | null }): void {
    const state = s.state ?? (s.live === false ? 'ended' : 'idle');
    this.sessions.set(s.id, { title: `Session ${s.id}`, ticketId: null, lastActivityAt: new Date(Date.now() - this.sessions.size).toISOString(), ...s, state, live: state !== 'ended' });
  }

  list(filter: { workspaceId?: string; ticketId?: string }): CiSession[] {
    return [...this.sessions.values()].filter((s) => (!filter.workspaceId || s.workspaceId === filter.workspaceId) && (!filter.ticketId || s.ticketId === filter.ticketId));
  }

  byBranch(workspaceId: string, branch: string): CiSession | null {
    return [...this.sessions.values()].find((s) => s.workspaceId === workspaceId && s.branch === branch) ?? null;
  }

  get(sessionId: string): CiSession | null {
    let id = sessionId;
    for (let i = 0; i < 8 && this.moved.has(id); i++) id = this.moved.get(id)!;
    return this.sessions.get(id) ?? null;
  }

  async send(sessionId: string, runId: string, text: string, opts: CiSendOptions = {}): Promise<void> {
    if (this.failSend) throw this.failSend;
    if (!this.sessions.has(sessionId)) throw new Error(`No session ${sessionId}: send to the id it goes by now.`);
    this.sent.push({ sessionId, runId, text, priority: opts.priority ?? 'later', label: opts.label ?? 'CI' });
  }
}
