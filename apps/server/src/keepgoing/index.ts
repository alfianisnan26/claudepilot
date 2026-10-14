// Keep going as a platform module (T-259 slice 1; docs/prd/chat-sessions.md "Keep going (the watchdog)"): the sweep on a 60-second timer,
// the routes `GET`/`PUT /api/chat/sessions/:id/keep-going`, the kill switch `keepgoing.enabled`, and the session payload's `keepGoing`
// (a hook on the chat controller). platform/index.ts registers it with ONE line. Nothing happens until a person turns it on for a chat.

import type { ChatKeepGoing, ChatRequest, ChatSession } from '@portal/contracts';
import { isTicketClosed } from '@portal/contracts';
import { realClock, type ClockPort } from '../autotransfer/ports.js';
import type { Platform, PlatformModule } from '../platform/index.js';
import { declareKeepGoingPolicies } from './authz.js';
import { KeepGoingEngine, type KeepGoingChatPort, type KeepGoingTicketPort } from './engine.js';
import { createKeepGoingRoutes } from './routes.js';
import './settings.js';
import { KeepGoingStore } from './store.js';

export { KeepGoingEngine } from './engine.js';
export { KeepGoingStore } from './store.js';

interface ControllerLike {
  get(id: string): ChatSession | null;
  openRequests(id: string): ChatRequest[];
  send(id: string, uuid: string, text: string, opts: { priority?: 'next' | 'later'; actor?: string; actorLabel?: string }): Promise<void>;
  respond(id: string, requestId: string, decision: 'deny', opts: { note?: string; actor?: string }): Promise<void>;
  control(id: string, op: 'resume'): Promise<void>;
  keepGoingOf?: (sessionId: string) => ChatKeepGoing | null;
  keepGoingChanged?: (sessionId: string) => void;
}

interface TicketsLike {
  create(caller: { kind: 'system' }, req: Record<string, unknown>): { id: string };
  comment(caller: { kind: 'system' }, id: string, text: string): unknown;
  brief(id: string): { status: string } | null;
}

/** The chat controller as the sweep needs it; null when what was handed over lacks it (some tests). */
function chatPort(raw: unknown): (KeepGoingChatPort & { controller: ControllerLike }) | null {
  const c = raw as Partial<ControllerLike> | null;
  if (!c || typeof c.get !== 'function' || typeof c.openRequests !== 'function' || typeof c.send !== 'function' || typeof c.respond !== 'function' || typeof c.control !== 'function') return null;
  const ctl = c as ControllerLike;
  return {
    controller: ctl,
    get: (id) => ctl.get(id),
    openRequests: (id) => ctl.openRequests(id),
    send: (id, uuid, text, o) => ctl.send(id, uuid, text, o),
    respond: (id, requestId, decision, o) => ctl.respond(id, requestId, decision, o),
    resume: (id) => ctl.control(id, 'resume'),
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
      const b = tickets.brief(id);
      return !!b && !isTicketClosed(b.status as never);
    },
  };
}

export function createKeepGoingModule(platform: Platform, opts: { clock?: ClockPort; random?: () => number } = {}): PlatformModule & { engine: KeepGoingEngine | null } {
  declareKeepGoingPolicies();
  const chat = chatPort(platform.deps.chat);
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
  });
  return {
    name: 'keepgoing',
    engine,
    routes: [{ path: '/api/chat/sessions', app: createKeepGoingRoutes({ owner: platform.owner, engine, chat }) }],
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
