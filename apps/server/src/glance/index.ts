// Glance (docs/prd/glance-widgets.md): index.ts builds one aggregator, chains tickets and CI changes into it, and app.ts mounts its
// route. The chat side is fed by the controller's own events (`onEvent`), so no new socket, timer or poll is involved.

import type { ChatServerMessage } from '@portal/contracts';
import type { CiService } from '../ci/service.js';
import type { ChatController } from '../chat/controller.js';
import type { Tickets } from '../tickets/service.js';
import { declareGlancePolicies, glanceSources } from './authz.js';
import { Glance } from './service.js';

export { createGlanceRoutes } from './routes.js';
export { Glance } from './service.js';
export { glanceSources } from './authz.js';

export interface GlanceDeps {
  chat: Pick<ChatController, 'list' | 'openRequests' | 'tasks' | 'onEvent'>;
  tickets: Pick<Tickets, 'list'>;
  ci: Pick<CiService, 'list'>;
  /** Tells open pages to load the snapshot again (the `glance` live topic). */
  notify: () => void;
  /** Whether some page watches that topic (the hub's `watching`). */
  watching?: () => boolean;
  /** How long a burst of changes is gathered into one build (tests shorten it). */
  debounceMs?: number;
}

/** What a session's controller says that a glance widget shows: a state change, a request asked or answered, a task, a deletion. Deltas and the rest are not it. */
export const changesGlance = (msg: ChatServerMessage): boolean =>
  msg.type === 'session' || msg.type === 'removed' || msg.type === 'tasks' || (msg.type === 'events' && msg.items.some((e) => e.kind === 'request' || e.kind === 'resolved'));

export function createGlance(deps: GlanceDeps): Glance {
  declareGlancePolicies();
  const glance = new Glance(glanceSources(deps), {
    notify: deps.notify,
    watching: deps.watching,
    debounceMs: deps.debounceMs,
    log: (what, e) => console.error(`[glance] reading ${what} failed: ${(e as Error).message}`),
  });
  glance.onStop(deps.chat.onEvent((_id, msg) => changesGlance(msg) && glance.changed()));
  return glance;
}
