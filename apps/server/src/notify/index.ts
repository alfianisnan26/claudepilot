// Notifications (docs/prd/web-app-pwa.md §11): wires the destinations, the history, the keys, the answers, the pipeline, the adapters over
// the existing seams and the routes. Built by the platform (platform/index.ts); nothing else constructs it.

import type { ChatRequest, ChatServerMessage, ChatSession, ClaudeUsageAlert, SpendAlert } from '@portal/contracts';
import type { PlatformAudit } from '../platform/audit.js';
import type { PlatformOwner } from '../platform/owner.js';
import type { Store } from '../store/store.js';
import { NotifyActions } from './actions.js';
import { adaptChat } from './adapters/chat.js';
import type { CiHooks } from '../ci/service.js';
import { adaptCi } from './adapters/ci.js';
import { adaptSpend } from './adapters/spend.js';
import { adaptTickets, type TicketEventLike } from './adapters/tickets.js';
import { adaptUsage } from './adapters/usage.js';
import type { NotifyBus } from './bus.js';
import { Destinations } from './destinations.js';
import { createEgress, type Egress } from './egress.js';
import { NotifyHistory } from './history.js';
import { NotifyPipeline } from './pipeline.js';
import { registerNotifyTools } from './portalTools.js';
import { createNotifyRoutes } from './routes.js';
import { actionsCeiling, baseUrlOf, contactOf, type NotifySettingsReader } from './settings.js';
import { NotifyKeys } from './vapid.js';

export { createBus, type NotifyBus, type NotifyEmit } from './bus.js';
export type { Presence } from './pipeline.js';

/** The chat controller, as notifications use it. */
export interface NotifyChat {
  onEvent(cb: (sessionId: string, msg: ChatServerMessage) => void): () => void;
  get(id: string): ChatSession | null;
  openRequests(id: string): ChatRequest[];
  respond(id: string, requestId: string, decision: 'allow' | 'allow_session' | 'deny', opts?: { note?: string; actor?: string }): Promise<void>;
}

export interface NotifyDeps {
  store: Store;
  bus: NotifyBus;
  owner: PlatformOwner;
  audit: PlatformAudit;
  chat: NotifyChat;
  settings: NotifySettingsReader | null;
  ci?: { hooks: CiHooks } | null;
  claudeUsage?: { onAlert(fn: (a: ClaudeUsageAlert) => void): () => void } | null;
  usageSpend?: { onAlert(fn: (a: SpendAlert) => void): () => void } | null;
  tickets?: { onEvent?: (e: TicketEventLike) => void } | null;
  /** A ticket's type, workspace and whether it is open (never its summary). */
  ticketInfo?: (id: string) => { type: string; workspaceId: string | null; open: boolean } | null;
  /** `PORTAL_UI_URL`. */
  uiUrl: string | null;
  /** `PORTAL_PUSH_CONTACT`. */
  pushContact: string | null;
  /** This portal on its own port, when no link address is set. */
  selfOrigin: string;
  publish: () => void;
  /** Tests: a client with injected resolution, plain http, private addresses. Never set from a request. */
  egress?: Egress;
  /** Whether a sign-in checked the server code recently. */
  reauthFresh?: (signIn: string | undefined) => boolean;
  now?: () => Date;
  schedule?: (ms: number, fn: () => void) => () => void;
  sleep?: (ms: number) => Promise<void>;
  /** Registers `notify_status` on the Portal MCP (once per process: tests pass false). */
  tools?: boolean;
}

/**
 * A session a webhook or CI trigger started, or whose parent chain leads to one: its prompt held text from outside, so Allow is never offered
 * (Review and Deny only). Cron-started sessions are not restricted; the triggers module says which trigger ids are cron (`trusted`).
 */
export function untrustedOrigin(get: (id: string) => ChatSession | null, trustedTrigger: (triggerId: string) => boolean = () => false) {
  return (sessionId: string): boolean => {
    let s = get(sessionId);
    for (let depth = 0; s && depth < 12; depth++) {
      const by = s.startedBy ?? '';
      const trigger = /^portal:trigger-(.+)$/.exec(by);
      if (trigger && !trustedTrigger(trigger[1]!)) return true;
      if (/^ci:/.test(by)) return true;
      if (!s.parentId) return false;
      s = get(s.parentId);
    }
    return !!s; // a chain deeper than this is treated as untrusted
  };
}

export function createNotify(d: NotifyDeps) {
  const now = d.now ?? (() => new Date());
  const egress = d.egress ?? createEgress();
  const destinations = new Destinations(d.store, egress, now);
  const history = new NotifyHistory(d.store, now);
  const keys = new NotifyKeys(d.store, now);
  const ceiling = () => actionsCeiling(d.settings);
  const baseUrl = () => baseUrlOf(d.settings, d.uiUrl);
  let trustedTrigger: (id: string) => boolean = () => false;
  const untrusted = untrustedOrigin((id) => d.chat.get(id), (id) => trustedTrigger(id));
  let pipeline: NotifyPipeline;
  const actions = new NotifyActions({
    store: d.store,
    destinations,
    owner: d.owner,
    audit: d.audit,
    chat: { get: (id) => d.chat.get(id), openRequests: (id) => d.chat.openRequests(id), respond: (id, r, dec, o) => d.chat.respond(id, r, dec, o) },
    ceiling,
    untrusted,
    answered: (s, r, outcome) => pipeline.resolveRequest(s, r, outcome),
    now,
  });
  pipeline = new NotifyPipeline({
    store: d.store,
    bus: d.bus,
    owner: d.owner,
    destinations,
    history,
    actions,
    egress,
    keys,
    chat: { get: (id) => d.chat.get(id), openRequests: (id) => d.chat.openRequests(id) },
    ceiling,
    untrusted,
    baseUrl,
    origin: () => baseUrl() ?? d.selfOrigin,
    contact: () => contactOf(d.settings, d.pushContact, baseUrl()),
    publish: d.publish,
    now,
    schedule: d.schedule,
    sleep: d.sleep,
  });
  const routes = createNotifyRoutes({
    owner: d.owner,
    destinations,
    history,
    pipeline,
    actions,
    keys,
    audit: d.audit,
    ceiling,
    baseUrl,
    session: (id) => d.chat.get(id),
    reauthFresh: (t) => d.reauthFresh?.(t) ?? false,
    publish: d.publish,
  });
  if (d.tools !== false) registerNotifyTools({ destinations, history, pipeline, ceiling });

  const stops: (() => void)[] = [];
  let sweep: NodeJS.Timeout | null = null;
  return {
    destinations,
    history,
    keys,
    actions,
    pipeline,
    routes,
    egress,
    /** Triggers say which of their ids are cron (whose sessions may be allowed from a notification). */
    set trustedTrigger(fn: (triggerId: string) => boolean) {
      trustedTrigger = fn;
    },
    untrusted,
    start() {
      if (stops.length) return;
      pipeline.start();
      stops.push(
        adaptChat({
          chat: d.chat,
          bus: d.bus,
          untrusted,
          doneWanted: (id) => !!d.store.db?.prepare('SELECT 1 FROM notify_session_flags WHERE session_id = ? AND done = 1 LIMIT 1').get(id),
          resolved: (s, r, outcome) => pipeline.resolveRequest(s, r, outcome),
        }),
      );
      if (d.ci) stops.push(adaptCi(d.ci, d.bus));
      if (d.claudeUsage) stops.push(adaptUsage(d.claudeUsage, d.bus));
      if (d.usageSpend) stops.push(adaptSpend(d.usageSpend, d.bus));
      if (d.tickets) stops.push(adaptTickets(d.tickets, d.bus, { info: (id) => d.ticketInfo?.(id) ?? null, closed: (id) => pipeline.resolveTag(`ticket:${id}`, 'closed') }));
      try {
        history.sweep();
      } catch {
        // a database that cannot be written: nothing to sweep
      }
      sweep = setInterval(() => {
        try {
          history.sweep();
        } catch {
          // as above
        }
      }, 3600_000);
      sweep.unref();
    },
    stop() {
      for (const s of stops.splice(0)) s();
      pipeline.stop();
      if (sweep) clearInterval(sweep);
    },
  };
}

export type Notify = ReturnType<typeof createNotify>;
