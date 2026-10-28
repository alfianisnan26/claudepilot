// Test helpers for Keep going: a chat controller that records what the sweep sends, answers and wakes (on a fake clock), and a ticket queue
// in memory. Nothing here runs a workspace or contacts anyone.

import { AppError } from '@isnanme/core';
import type { ChatRequest, ChatSession, CreateChatSessionRequest, NotifyEvent } from '@portal/contracts';
import { fakeClock } from '../autotransfer/testkit.js';
import { FakeChat, fakeOwner, freshStore, session } from '../notify/testkit.js';
import { PlatformAudit } from '../platform/audit.js';
import { KeepGoingEngine, type KeepGoingChatPort, type KeepGoingTicketPort } from './engine.js';
import { KeepGoingStore } from './store.js';
import type { Store } from '../store/store.js';

export { T0, at, fakeClock } from '../autotransfer/testkit.js';

type Clock = ReturnType<typeof fakeClock>;

/** The chat controller's observable effects, on the fake clock. */
export class KgChat extends FakeChat implements KeepGoingChatPort {
  readonly sent: { id: string; text: string; priority: string; actor: string }[] = [];
  readonly resumed: string[] = [];
  failSend: string | null = null;
  failResume: string | null = null;
  /** A nudge starts a turn (true) or the chat stays idle (false: a message that did not start one). */
  sendStartsTurn = true;
  constructor(readonly clock: Clock) {
    super();
  }
  #now() {
    return new Date(this.clock.now()).toISOString();
  }
  put(id: string, over: Partial<ChatSession> = {}): ChatSession {
    const s = session(id, { state: 'idle', waiting: 0, title: 'CANARY-TITLE chat', lastActivityAt: this.#now(), ...over });
    this.sessions.set(id, s);
    return s;
  }
  patch(id: string, over: Partial<ChatSession>): void {
    this.sessions.set(id, { ...this.sessions.get(id)!, ...over });
  }
  async send(id: string, _uuid: string, text: string, opts: { priority: 'later'; actor: string }): Promise<void> {
    if (this.failSend) throw new AppError('SERVICE_UNAVAILABLE', this.failSend);
    this.sent.push({ id, text, priority: opts.priority, actor: opts.actor });
    this.patch(id, { lastActivityAt: this.#now(), ...(this.sendStartsTurn ? { state: 'working' as const } : {}) });
  }
  async resume(id: string): Promise<void> {
    this.resumed.push(id);
    if (this.failResume) throw new AppError('SERVICE_UNAVAILABLE', this.failResume);
    this.patch(id, { state: 'idle', process: 'live', endedReason: null });
  }
  /** Slice 2: recover in place. `recoverError` makes it refuse (or fail) instead. */
  readonly recovered: string[] = [];
  recoverError: Error | null = null;
  async recover(id: string, _opts?: unknown): Promise<void> {
    this.recovered.push(id);
    if (this.recoverError) throw this.recoverError;
    this.patch(id, { state: 'interrupted', process: 'gone', endedReason: null, endedFor: null });
  }
  /** Slice 2: the chats started to continue an ended one, and what each was made from. `failCreate`: the start is refused with that code. */
  readonly started: { id: string; from: string }[] = [];
  failCreate: string | null = null;
  async continueChat(old: ChatSession): Promise<ChatSession> {
    if (this.failCreate) throw new AppError(this.failCreate as never, 'refused');
    const id = `${old.id}-n${this.started.length + 1}`;
    this.started.push({ id, from: old.id });
    return this.put(id, { state: 'idle', process: 'live', continuedFrom: old.id, workspaceId: old.workspaceId, cwd: old.cwd, title: old.title, ticketId: old.ticketId, claudeId: old.claudeId, bypassCapable: false, mode: 'default', endedReason: null, endedFor: null });
  }
  /** The controller's create, as the module wires it (only to continue an ended chat). */
  readonly created: { req: Partial<CreateChatSessionRequest>; actor: string }[] = [];
  async create(req: Partial<CreateChatSessionRequest>, opts: { actor: string }): Promise<ChatSession> {
    this.created.push({ req, actor: opts.actor });
    return this.continueChat(this.get(req.continuedFrom!)!);
  }
  /** The controller's control, as the module wires it (`resume` only). */
  async control(id: string, op: 'resume'): Promise<void> {
    if (op === 'resume') return this.resume(id);
  }
  /** PILOT-996: the controller's Bypass put-back, when a test installs it (absent: Keep going only reports). */
  bypassSeenAt?: (id: string) => string | null;
  restoreBypass?: (id: string) => Promise<boolean>;
  /** The controller's hooks the module installs. */
  keepGoingOf?: (id: string) => unknown;
  readonly emittedFor: string[] = [];
  keepGoingChanged(id: string): void {
    this.emittedFor.push(id);
  }
  /** The turn ends: the chat is idle from now. */
  turnEnds(id: string): void {
    this.patch(id, { state: 'idle', lastActivityAt: this.#now() });
  }
  /** A request waits from now. */
  waitFor(id: string, r: Partial<ChatRequest> & { requestId: string }): void {
    const req: ChatRequest = { kind: 'tool', toolName: 'Bash', agentLabel: null, title: 'Run a command', detail: 'CANARY-COMMAND', full: 'CANARY-COMMAND', fullCut: false, createdAt: this.#now(), ...r };
    this.open.set(id, [...(this.open.get(id) ?? []), req]);
    this.patch(id, { state: 'waiting', waiting: (this.open.get(id) ?? []).length });
  }
  override async respond(id: string, requestId: string, decision: string, opts: { note?: string; actor?: string } = {}) {
    await super.respond(id, requestId, decision, opts);
    if (!(this.open.get(id) ?? []).length) this.patch(id, { state: 'working', waiting: 0 });
  }
}

/** Tickets in memory: what was made and commented, and which are open. */
export function fakeTickets(): KeepGoingTicketPort & { made: { id: string; summary: string; description: string; tags: string[]; priority: string; type: string }[]; comments: { id: string; text: string }[]; close(id: string): void; isClosed(id: string): boolean } {
  const made: { id: string; summary: string; description: string; tags: string[]; priority: string; type: string }[] = [];
  const comments: { id: string; text: string }[] = [];
  const closed = new Set<string>();
  return {
    made,
    comments,
    create(req) {
      const id = `T-${made.length + 1}`;
      made.push({ id, summary: req.summary, description: req.description, tags: req.tags, priority: req.priority, type: req.type });
      return { id };
    },
    comment: (id, text) => void comments.push({ id, text }),
    isOpen: (id) => made.some((t) => t.id === id) && !closed.has(id),
    isClosed: (id) => closed.has(id),
    close: (id) => void closed.add(id),
  };
}

export function settingsMap(values: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(values));
  return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => void m.set(k, v) };
}

/** An engine over a fresh store (or the given one: a portal restart), a fake chat, a fake clock, two fake users. */
export async function rig(opts: { store?: Store; clock?: Clock; chat?: KgChat; settings?: ReturnType<typeof settingsMap>; tickets?: ReturnType<typeof fakeTickets>; owner?: ReturnType<typeof fakeOwner> } = {}) {
  const store = opts.store ?? (await freshStore()).store;
  const clock = opts.clock ?? fakeClock();
  const chat = opts.chat ?? new KgChat(clock);
  const owner = opts.owner ?? fakeOwner({}, { fallback: 'u_a' });
  const kg = new KeepGoingStore(store, () => new Date(clock.now()));
  const audit = new PlatformAudit(store, () => new Date(clock.now()));
  const emitted: NotifyEvent[] = [];
  const bus = { emit: (e: Omit<NotifyEvent, 'id' | 'at'>) => (emitted.push({ ...e, id: `evt_${emitted.length}`, at: new Date(clock.now()).toISOString() } as NotifyEvent), null) };
  const settings = opts.settings ?? settingsMap();
  const tickets = opts.tickets ?? fakeTickets();
  const changed: string[] = [];
  const published: number[] = [];
  const engine = new KeepGoingEngine({ chat, owner, clock, store: kg, settings, bus, audit, tickets, random: () => 0, changed: (id) => void changed.push(id), publish: () => void published.push(clock.now()) });
  /** Moves the clock on by `min` minutes and runs one round. */
  const after = async (min: number) => {
    clock.set(clock.now() + min * 60_000);
    return engine.round();
  };
  const on = (id: string, patch: Record<string, unknown> = {}) => engine.set(id, 'u_a', 'user:u_a', { enabled: true, ...patch });
  return { store, clock, chat, owner, kg, audit, auditRows: (kind?: string) => audit.list({ kind }, null), emitted, settings, tickets, engine, after, on, changed, published };
}
