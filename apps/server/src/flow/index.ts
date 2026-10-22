// The flow watchdog as a platform module (T-1966, docs/prd/flow-watchdog.md): the round every 5 minutes, the route `GET /api/flow` (the
// Home card), the Flow settings. platform/index.ts registers it with ONE line. Adapters below are the only place it touches the chat
// controller and the tickets service; both are read through their public methods (no edit in either).

import type { ChatAuditEntry, ChatSession, TicketCheck, TicketItem, TicketMergeStatus, TicketStatus } from '@portal/contracts';
import { TICKET_SETTING_KEYS } from '@portal/contracts';
import { realClock, type ClockPort } from '../autotransfer/ports.js';
import { effectiveMaxWorkers, type AgentCaps } from '../chat/agents.js';
import type { Platform, PlatformModule } from '../platform/index.js';
import type { StoredVerdict } from '../tickets/verdicts.js';
import { declareFlowPolicies } from './authz.js';
import { FlowEngine, type FlowBypassRecord, type FlowChatPort, type FlowTicketPort } from './engine.js';
import { createFlowRoutes } from './routes.js';
import './settings.js';
import { MetaFlowStore } from './store.js';
import { KeepGoingStore } from '../keepgoing/store.js';

export { FlowEngine } from './engine.js';

interface ControllerLike {
  get(id: string): ChatSession | null;
  list(filter?: { workspaceId?: string; ticketId?: string; parentId?: string }): ChatSession[];
  send(id: string, uuid: string, text: string, opts: { priority?: 'next' | 'later'; actor?: string; actorLabel?: string }): Promise<void>;
  audit(filter: { kind?: string; sessionId?: string; limit?: number }): ChatAuditEntry[];
  stoppedByPerson?(id: string): boolean;
  agentCaps?: () => AgentCaps;
}

interface TicketsLike {
  list(caller: { kind: 'system' }, filter: { tag?: string; status?: TicketStatus[]; limit?: number }): { items: TicketItem[] };
  verdicts(caller: { kind: 'system' }, id: string): StoredVerdict[];
  checks(id: string): TicketCheck[];
  liveBatchOf?(id: string): { branch: string; at: string } | null;
  mergeStatus?(caller: { kind: 'system' }, id: string): TicketMergeStatus[];
}

/** The chat controller as the watchdog needs it; null when what was handed over lacks it (some tests). */
export function flowChatPort(raw: unknown): FlowChatPort | null {
  const c = raw as Partial<ControllerLike> | null;
  if (!c || typeof c.get !== 'function' || typeof c.list !== 'function' || typeof c.send !== 'function' || typeof c.audit !== 'function') return null;
  const ctl = c as ControllerLike;
  return {
    get: (id) => ctl.get(id),
    list: (f) => ctl.list(f),
    continuationOf: (id) => {
      const s = ctl.get(id);
      if (!s) return null;
      const next = ctl
        .list({ workspaceId: s.workspaceId })
        .filter((x) => x.continuedFrom === id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return next?.id ?? null;
    },
    send: (id, uuid, text, o) => ctl.send(id, uuid, text, o),
    lastBypass: (id): FlowBypassRecord | null => {
      const r = ctl.audit({ kind: 'bypass', sessionId: id, limit: 20 }).find((a) => a.kind === 'bypass.entered' || a.kind === 'bypass.left');
      return r ? { sessionId: r.sessionId ?? id, kind: r.kind, actor: r.actor ?? '', at: r.at, detail: r.detail ?? {} } : null;
    },
    maxWorkers: (s) => effectiveMaxWorkers(ctl.agentCaps?.() ?? null, s.maxWorkers),
    // A controller without the hold (an older one, a test double) is read as held: fail closed, nothing is sent.
    stoppedByPerson: (id) => (typeof ctl.stoppedByPerson === 'function' ? ctl.stoppedByPerson(id) : true),
  };
}

function flowTicketPort(raw: unknown): FlowTicketPort | null {
  const t = raw as Partial<TicketsLike> | null;
  if (!t || typeof t.list !== 'function' || typeof t.verdicts !== 'function' || typeof t.checks !== 'function') return null;
  const tickets = t as TicketsLike;
  const system = { kind: 'system' as const };
  return {
    list: (tag, status) => tickets.list(system, { tag, status, limit: 500 }).items,
    verdicts: (id) => tickets.verdicts(system, id),
    checks: (id) => tickets.checks(id),
    // T-1987: an older tickets service without it reads as no batch (the ticket is asked as before).
    batchOf: (id) => (typeof tickets.liveBatchOf === 'function' ? tickets.liveBatchOf(id) : null),
    // T-2014: an older tickets service without it reads as no record (the newest-seen heuristic, labelled).
    mergeStatus: (id) => (typeof tickets.mergeStatus === 'function' ? tickets.mergeStatus(system, id) : []),
  };
}

export function createFlowModule(platform: Platform, opts: { clock?: ClockPort } = {}): PlatformModule & { engine: FlowEngine | null } {
  declareFlowPolicies();
  const chat = flowChatPort(platform.deps.chat);
  const tickets = flowTicketPort(platform.deps.tickets);
  if (!chat || !tickets) return { name: 'flow', engine: null };
  const settings = platform.deps.settings ?? null;
  const kgStore = new KeepGoingStore(platform.deps.store);
  const engine = new FlowEngine({
    chat,
    tickets,
    owner: platform.owner,
    clock: opts.clock ?? realClock,
    store: new MetaFlowStore(platform.deps.store),
    settings,
    leadGroups: () => {
      try {
        return settings?.get(TICKET_SETTING_KEYS.leadPeerGroups) ?? '';
      } catch {
        return '';
      }
    },
    bus: platform.bus,
    audit: platform.audit,
    // Keep going's pause switch, read from its own rows (no edit in Keep going): all, a program, or the program on a chat's policy.
    keepGoing: { pauses: () => kgStore.pauses(), programOf: (id) => kgStore.policy(id)?.program ?? null },
    // The Home card reloads on Keep going's topic (the same watchdog family), after each round.
    publish: () => platform.publish('keepgoing'),
  });
  return {
    name: 'flow',
    engine,
    routes: [{ path: '/api/flow', app: createFlowRoutes({ owner: platform.owner, engine }) }],
    start: () => engine.start(),
    stop: () => engine.stop(),
  };
}
