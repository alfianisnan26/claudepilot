// Test helpers for tickets (not used by the portal): a fake of the chat side (`TicketSessions`) and a harness
// with a fresh store and the service around it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TicketSessionState } from '@portal/contracts';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { Tickets, type Caller, type TicketsOptions } from './service.js';
import type { CreateSession, TicketSessionInfo, TicketSessions } from './sessions.js';

/** The chat sessions as the tickets module sees them, in memory. */
export class FakeSessions implements TicketSessions {
  readonly sessions = new Map<string, TicketSessionInfo>();
  readonly created: CreateSession[] = [];
  readonly sent: { sessionId: string; ticketId: string; text: string; label: string; priority?: 'next' | 'later' }[] = [];
  /** Runs when a message is sent, before it is recorded (a test can look at the ticket at that moment). */
  onSend?: (sessionId: string) => void;
  failSend: Error | null = null;
  failCreate: Error | null = null;
  #listeners = new Set<(s: TicketSessionInfo) => void>();
  #n = 0;

  add(over: Partial<TicketSessionInfo> & { workspaceId: string }): TicketSessionInfo {
    const id = over.id ?? `s${++this.#n}`;
    const s: TicketSessionInfo = {
      id,
      title: `Session ${id}`,
      state: 'idle',
      lastActivityAt: new Date().toISOString(),
      endedReason: null,
      worktree: null,
      ticketId: null,
      continuedFrom: null,
      ...over,
    };
    this.sessions.set(id, s);
    return s;
  }

  setState(id: string, state: TicketSessionState, endedReason: string | null = null) {
    const s = this.sessions.get(id)!;
    s.state = state;
    s.endedReason = endedReason;
    for (const cb of this.#listeners) cb({ ...s });
  }

  get(id: string) {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }

  list(filter: { workspaceId?: string; ticketId?: string } = {}) {
    return [...this.sessions.values()].filter((s) => (!filter.workspaceId || s.workspaceId === filter.workspaceId) && (!filter.ticketId || s.ticketId === filter.ticketId)).map((s) => ({ ...s }));
  }

  async create(req: CreateSession) {
    if (this.failCreate) throw this.failCreate;
    this.created.push(req);
    return this.add({ workspaceId: req.workspaceId, title: req.title, ticketId: req.ticketId, worktree: req.worktree ? { branch: req.worktree.branch ?? 'ticket-branch', path: `/home/node/work.worktrees/${req.worktree.branch ?? 'ticket-branch'}` } : null });
  }

  async send(sessionId: string, ticketId: string, text: string, label: string, opts: { priority?: 'next' | 'later' } = {}) {
    this.onSend?.(sessionId);
    if (this.failSend) throw this.failSend;
    this.sent.push({ sessionId, ticketId, text, label, ...(opts.priority ? { priority: opts.priority } : {}) });
  }

  onSession(cb: (s: TicketSessionInfo) => void) {
    this.#listeners.add(cb);
    return () => void this.#listeners.delete(cb);
  }
}

export const UI: Caller = { kind: 'ui' };

/** An admin's token (a script, Claude Code on someone's machine). */
export const token = (id: string, scope: 'read' | 'operate' | 'admin'): Caller => ({ kind: 'token', tokenId: id, label: `${id}-label`, scope });

/** An agent's per-session token: the session and workspace it was minted for. */
export const agent = (workspaceId: string, sessionId: string, tokenId = `agt_${sessionId}`): Caller => ({ kind: 'agent', tokenId, label: `session ${sessionId} in ${workspaceId}`, workspaceId, sessionId });

export async function ticketsHarness(
  opts: {
    now?: () => Date;
    workspaceRefs?: TicketsOptions['workspaceRefs'];
    orphanAfterMin?: () => number;
    agentOpenPerWorkspace?: () => number;
    agentAssignUserTags?: () => string;
    mergeGates?: TicketsOptions['mergeGates'];
  } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-tickets-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const sessions = new FakeSessions();
  const tickets = new Tickets(store, sessions, {
    now: opts.now,
    workspaceRefs: opts.workspaceRefs,
    orphanAfterMin: opts.orphanAfterMin,
    agentOpenPerWorkspace: opts.agentOpenPerWorkspace,
    agentAssignUserTags: opts.agentAssignUserTags,
    mergeGates: opts.mergeGates,
  });
  tickets.start();
  let changes = 0;
  tickets.onChange = () => void changes++;
  const done = () => {
    tickets.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, sessions, tickets, done, changes: () => changes, dataDir };
}
