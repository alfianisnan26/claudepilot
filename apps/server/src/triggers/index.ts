// Triggers and schedules (docs/prd/triggers.md): the platform module. Registered with ONE line in platform/index.ts; it reads its seams from
// `platform.deps` (the store, the settings, the chat controller, CI, tickets) and the platform itself (bus, audit, owner, `/hooks`, the
// live topic `triggers`). Routes: `/api/triggers` behind the session guard; the receiver: `POST /hooks/<token>`, its own door.

import type { Context } from 'hono';
import { config } from '../config.js';
import type { Platform, PlatformModule } from '../platform/index.js';
import type { Tickets } from '../tickets/service.js';
import { declareTriggerPolicies, registerTriggerAuthz } from './authz.js';
import { ciSource, type CiReader } from './ci.js';
import { registerTriggerTools } from './portalTools.js';
import { mountReceiver } from './receiver.js';
import { createTriggerRoutes } from './routes.js';
import { TriggerRunner, type TriggerChat, type TriggerTickets } from './runner.js';
import { TriggerScheduler } from './scheduler.js';
import { TriggerService } from './service.js';
import { triggerSettings } from './settings.js';
import { TriggerStore } from './store.js';

export { nextRuns, parseCron, cronProblem, CronError } from './cron.js';

/** The chat controller as the module finds it in `platform.deps` (the notify view of it is narrower). */
type ChatLike = TriggerChat & {
  workspaceExists?: (id: string) => Promise<boolean>;
  eligibility?: (id: string) => { ok: boolean };
};

const clientAddress = (c: Context): string => {
  const forwarded = config.trustProxy ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
  return forwarded || ((c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? 'unknown');
};

export interface TriggersModule extends PlatformModule {
  service: TriggerService;
  runner: TriggerRunner;
  scheduler: TriggerScheduler;
}

export function createTriggersModule(platform: Platform, opts: { now?: () => Date; tools?: boolean } = {}): TriggersModule {
  const deps = platform.deps;
  const chat = deps.chat as unknown as ChatLike;
  const settings = triggerSettings(deps.settings);
  const store = new TriggerStore(deps.store, opts.now);
  const tickets = (deps.tickets as unknown as Tickets | null | undefined) ?? null;
  const publish = () => platform.publish('triggers');
  const runner = new TriggerRunner({
    store,
    chat,
    tickets: tickets as unknown as TriggerTickets | null,
    owner: platform.owner,
    audit: platform.audit,
    bus: platform.bus,
    settings,
    async workspaceState(id) {
      if (chat.workspaceExists && !(await chat.workspaceExists(id))) return 'gone';
      try {
        if (chat.eligibility && !chat.eligibility(id).ok) return 'stopped';
      } catch {
        return 'stopped';
      }
      return 'ok';
    },
    publish,
    now: opts.now,
  });
  const service = new TriggerService({ store, timezone: settings.timezone, now: opts.now });
  const scheduler = new TriggerScheduler({ store, runner, masterOn: settings.enabled, now: opts.now });

  registerTriggerAuthz(store);
  declareTriggerPolicies();
  mountReceiver(platform.hooks, { store, runner, clientAddress, now: opts.now });
  // Cron-started sessions read no outside text: notifications may offer Allow for them; webhook and CI ones never (O1).
  platform.notify.trustedTrigger = (id) => store.get(id)?.source === 'cron';
  if (opts.tools ?? deps.tools !== false) registerTriggerTools({ service, owner: platform.owner });

  let offCi: (() => void) | null = null;
  const routes = createTriggerRoutes({ owner: platform.owner, service, runner, audit: platform.audit, reauthFresh: (t) => platform.reauthFresh(t), publish, now: opts.now });
  return {
    name: 'triggers',
    routes: [{ path: '/api/triggers', app: routes }],
    service,
    runner,
    scheduler,
    start() {
      runner.start();
      scheduler.start();
      offCi ??= platform.bus.on('ci_failed', ciSource({ ci: (deps.ci as unknown as CiReader | null | undefined) ?? null, store, runner, chat, timezone: settings.timezone, now: opts.now }));
    },
    stop() {
      offCi?.();
      offCi = null;
      scheduler.stop();
      runner.stop();
    },
  };
}
