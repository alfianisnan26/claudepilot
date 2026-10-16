// Auto transfer as a platform module (docs/prd/auto-transfer.md): the engine on the chat controller's events, the routes under
// `/api/autotransfer`, the settings (group "Auto move"), the read tool. platform/index.ts registers it with ONE line. Off by default:
// with `automove.enabled` off the engine reads one setting per turn boundary and does nothing else.

import { randomUUID } from 'node:crypto';
import type { ChatSession } from '@portal/contracts';
import { recommendMove } from '../claudeusage/recommend.js';
import type { Platform, PlatformModule } from '../platform/index.js';
import { declareAutoTransferPolicies } from './authz.js';
import { AutoTransferEngine, ENGINE_ACTOR } from './engine.js';
import { realClock, type ChatPort, type ClockPort, type UsagePort } from './ports.js';
import { createAutoTransferRoutes } from './routes.js';
import { registerAutoTransferTools } from './portalTools.js';
import './settings.js';
import { AutoStore } from './store.js';

export { AutoTransferEngine } from './engine.js';
export { AutoStore } from './store.js';

/** The chat controller and the usage monitor as the engine needs them; null when what was handed over lacks them (some tests). */
function ports(deps: Platform['deps']): { chat: ChatPort; usage: UsagePort } | null {
  const chat = deps.chat as unknown as Partial<ChatPort> | null;
  const usage = deps.claudeUsage as unknown as Partial<Pick<UsagePort, 'report' | 'onReading'>> | null;
  if (!chat || typeof chat.switchClaude !== 'function' || typeof chat.switchOptions !== 'function' || typeof chat.onEvent !== 'function' || typeof chat.history !== 'function' || typeof chat.list !== 'function' || typeof (chat as { send?: unknown }).send !== 'function') return null;
  if (!usage || typeof usage.report !== 'function') return null;
  const c = chat as ChatPort;
  const u = usage as Pick<UsagePort, 'report' | 'onReading'>;
  return {
    chat: {
      get: (id) => c.get(id),
      list: (f) => c.list(f) as ChatSession[],
      switchOptions: (id) => c.switchOptions(id),
      switchClaude: (id, to, o) => c.switchClaude(id, to, o),
      ...(typeof (chat as { modelFamilies?: unknown }).modelFamilies === 'function' ? { modelFamilies: (claudeId: string) => (chat as unknown as { modelFamilies(id: string): string[] | null }).modelFamilies(claudeId) } : {}),
      setModel: (id, model) => (chat as unknown as { control(id: string, op: 'model', args: { model: string }, opts: { actor: string }): Promise<void> }).control(id, 'model', { model }, { actor: ENGINE_ACTOR }),
      onEvent: (cb) => c.onEvent(cb),
      history: (id, after) => c.history(id, after),
      send: (id, text, o) => (chat as unknown as { send(id: string, uuid: string, text: string, opts: object): Promise<void> }).send(id, randomUUID(), text, o),
    },
    usage: { report: (o) => u.report(o), recommend: recommendMove, ...(typeof u.onReading === 'function' ? { onReading: (fn: () => void) => u.onReading!(fn) } : {}) },
  };
}

export function createAutoTransferModule(platform: Platform, opts: { clock?: ClockPort; ports?: { chat: ChatPort; usage: UsagePort } } = {}): PlatformModule & { engine: AutoTransferEngine | null } {
  declareAutoTransferPolicies();
  const p = opts.ports ?? ports(platform.deps);
  if (!p) return { name: 'autotransfer', engine: null };
  const now = opts.clock ? () => new Date(opts.clock!.now()) : platform.deps.now;
  const store = new AutoStore(platform.deps.store, now);
  const settings = platform.deps.settings;
  const publish = () => platform.publish('autotransfer');
  const engine = new AutoTransferEngine({ chat: p.chat, usage: p.usage, owner: platform.owner, clock: opts.clock ?? realClock, store, settings, bus: platform.bus, audit: platform.audit, publish });
  if (platform.deps.tools !== false) registerAutoTransferTools({ engine, store, owner: platform.owner });
  return {
    name: 'autotransfer',
    engine,
    routes: [{ path: '/api/autotransfer', app: createAutoTransferRoutes({ owner: platform.owner, engine, store, chat: p.chat, usage: p.usage, settings, audit: platform.audit, publish }) }],
    start: () => engine.start(),
    stop: () => engine.stop(),
  };
}
