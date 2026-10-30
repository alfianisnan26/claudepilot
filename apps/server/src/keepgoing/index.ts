// Keep going as a platform module (T-259 slices 1 and 2; docs/prd/chat-sessions.md "Keep going (the watchdog)"): the sweep on a 60-second
// timer, the routes `GET`/`PUT /api/chat/sessions/:id/keep-going` and `GET /api/keepgoing` (the Home card), the Portal MCP tool
// `session_keepgoing_set`, the kill switch `keepgoing.enabled`, the live topic `keepgoing`, and the session payload's `keepGoing` (a hook on
// the chat controller). platform/index.ts registers it with ONE line. Nothing happens until a person turns it on for a chat.

import type { ChatKeepGoing, ChatRequest, ChatSession, CreateChatSessionRequest } from '@portal/contracts';
import { isTicketClosed, KEEPGOING_ACTOR } from '@portal/contracts';
import { realClock, type ClockPort } from '../autotransfer/ports.js';
import type { Platform, PlatformModule } from '../platform/index.js';
import { declareKeepGoingPolicies } from './authz.js';
import { KeepGoingEngine, type KeepGoingChatPort, type KeepGoingTicketPort } from './engine.js';
import { registerKeepGoingTools } from './portalTools.js';
import { createKeepGoingListRoutes, createKeepGoingRoutes } from './routes.js';
import './settings.js';
import { KeepGoingStore } from './store.js';

export { KeepGoingEngine } from './engine.js';
export { KeepGoingStore } from './store.js';

interface ControllerLike {
  get(id: string): ChatSession | null;
  openRequests(id: string): ChatRequest[];
  send(id: string, uuid: string, text: string, opts: { priority?: 'next' | 'later'; actor?: string; actorLabel?: string }): Promise<void>;
  respond(id: string, requestId: string, decision: 'deny', opts: { note?: string; actor?: string }): Promise<void>;
  control(id: string, op: 'resume', args: undefined, opts: { actor: string }): Promise<void>;
  /** T-136 recover in place (slice 2). */
  recover(id: string, opts: { by: 'agent'; actor: string }): Promise<unknown>;
  /** A new chat (slice 2: one that continues an ended one). */
  create(req: Partial<CreateChatSessionRequest>, opts: { actor: string }): Promise<ChatSession>;
  keepGoingOf?: (sessionId: string) => ChatKeepGoing | null;
  keepGoingChanged?: (sessionId: string) => void;
  /** PILOT-996: when it was last in Bypass, and the gated put-back (the controller's `bypassSeenAt`, `restoreBypass`). */
  bypassSeenAt?: (id: string) => string | null;
  restoreBypass?: (id: string) => Promise<boolean>;
}

interface TicketsLike {
  create(caller: { kind: 'system' }, req: Record<string, unknown>): { id: string };
  comment(caller: { kind: 'system' }, id: string, text: string): unknown;
  brief(caller: { kind: 'system' }, id: string): { status: string } | null;
}

/** The chat controller as the sweep needs it; null when what was handed over lacks it (some tests). */
export function keepGoingChatPort(raw: unknown): (KeepGoingChatPort & { controller: ControllerLike }) | null {
  const c = raw as Partial<ControllerLike> | null;
  if (!c || typeof c.get !== 'function' || typeof c.openRequests !== 'function' || typeof c.send !== 'function' || typeof c.respond !== 'function' || typeof c.control !== 'function' || typeof c.recover !== 'function' || typeof c.create !== 'function') return null;
  const ctl = c as ControllerLike;
  return {
    controller: ctl,
    get: (id) => ctl.get(id),
    openRequests: (id) => ctl.openRequests(id),
    send: (id, uuid, text, o) => ctl.send(id, uuid, text, o),
    respond: (id, requestId, decision, o) => ctl.respond(id, requestId, decision, o),
    resume: (id) => ctl.control(id, 'resume', undefined, { actor: KEEPGOING_ACTOR }), // T-723: it was `ui` by the resume default
    recover: async (id) => void (await ctl.recover(id, { by: 'agent', actor: KEEPGOING_ACTOR })),
    // The same workspace, folder, Claude, title and ticket; no `allowBypass` (and a portal actor could not set it: FR20).
    continueChat: (s) =>
      ctl.create(
        { workspaceId: s.workspaceId, cwd: s.cwd, title: s.title, ...(s.claudeId ? { claudeId: s.claudeId } : {}), ...(s.ticketId ? { ticketId: s.ticketId } : {}), continuedFrom: s.id },
        { actor: KEEPGOING_ACTOR },
      ),
    ...(typeof ctl.bypassSeenAt === 'function' && typeof ctl.restoreBypass === 'function'
      ? { bypassSeenAt: (id: string) => ctl.bypassSeenAt!(id), restoreBypass: (id: string) => ctl.restoreBypass!(id) }
      : {}),
  };
}

function ticketPort(raw: unknown): KeepGoingTicketPort | null {
  const t = raw as Partial<TicketsLike> | null;
  if (!t || typeof t.create !== 'function' || typeof t.comment !== 'function' || typeof t.brief !== 'function') return null;
  const tickets = t as TicketsLike;
  const system = { kind: 'system' as const };
  return {
    create: (req) => tickets.create(system, req),
    comment: (id, text) => void tickets.comment(system, id, text),
    isOpen: (id) => {
      const b = tickets.brief(system, id);
      return !!b && !isTicketClosed(b.status as never);
    },
    isClosed: (id) => {
      const b = tickets.brief(system, id);
      return !!b && isTicketClosed(b.status as never);
    },
  };
}

export function createKeepGoingModule(platform: Platform, opts: { clock?: ClockPort; random?: () => number } = {}): PlatformModule & { engine: KeepGoingEngine | null } {
  declareKeepGoingPolicies();
  const chat = keepGoingChatPort(platform.deps.chat);
  if (!chat) return { name: 'keepgoing', engine: null };
  const clock = opts.clock ?? realClock;
  const store = new KeepGoingStore(platform.deps.store, () => new Date(clock.now()));
  const engine = new KeepGoingEngine({
    chat,
    owner: platform.owner,
    clock,
    store,
    settings: platform.deps.settings,
    bus: platform.bus,
    audit: platform.audit,
    tickets: ticketPort(platform.deps.tickets),
    random: opts.random,
    changed: (id) => chat.controller.keepGoingChanged?.(id),
    publish: () => platform.publish('keepgoing'),
  });
  if (platform.deps.tools !== false) registerKeepGoingTools({ engine, chat, owner: platform.owner });
  return {
    name: 'keepgoing',
    engine,
    routes: [
      { path: '/api/chat/sessions', app: createKeepGoingRoutes({ owner: platform.owner, engine, chat }) },
      { path: '/api/keepgoing', app: createKeepGoingListRoutes({ owner: platform.owner, engine }) },
    ],
    start: () => {
      chat.controller.keepGoingOf = (id) => engine.view(id);
      engine.start();
    },
    stop: () => {
      engine.stop();
      chat.controller.keepGoingOf = undefined;
    },
  };
}
