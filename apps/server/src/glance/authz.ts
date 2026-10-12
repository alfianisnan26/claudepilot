// Who sees what in the glance (docs/prd/glance-widgets.md §13, docs/prd/multi-user.md): the glance owns no object type, it READS sessions,
// requests, tasks, tickets and CI runs, so this file is where each of those reads is made on behalf of an actor and kept to what that
// actor may see. One function per kind of object (`GlanceSources`); nothing else in the glance reads an object. Today the portal has one
// person and the seam lets the owner see everything, so nothing is filtered; the real layer narrows it here and nowhere else.
//
// Answering is not here: the widgets answer an approval and stop an agent with the chat socket's own messages, the same door as the
// session page, so the one `can(actor, 'operate', session)` that guards that door guards the widget too, and so does the controller's
// refusal to allow what was not shown whole (`requestReview`).

import { sessionRef, type Actor, type ChatRequest, type ChatSession, type ChatTask, type CiRunSummary, type TicketItem } from '@portal/contracts';
import { GLANCE_CI_WINDOW_MS, GLANCE_LIMITS } from '@portal/contracts';
import { can, declarePolicies, visible } from '../authz/seam.js';
import type { CiService } from '../ci/service.js';
import type { ChatController } from '../chat/controller.js';
import type { Tickets } from '../tickets/service.js';
import { failedRuns, type GlanceSources } from './build.js';

export interface GlanceReads {
  chat: Pick<ChatController, 'list' | 'openRequests' | 'tasks'>;
  tickets: Pick<Tickets, 'list'>;
  ci: Pick<CiService, 'list'>;
}

/** Declares the glance's route (the route table's default deny is enforced once the real layer lands; declaring now costs nothing). */
export function declareGlancePolicies(): void {
  declarePolicies('glance', {
    // One request, every kind of thing the actor may see: sessions and their requests and agents, tickets assigned to them, CI runs of what they may see.
    'GET /api/glance': { kind: 'signed-in', filter: 'session' },
  });
}

/**
 * The glance's reads, one per kind of object, each for an actor:
 * - sessions: the ones the actor may view;
 * - requests: the open requests of a session the actor may OPERATE (to answer one is to operate it: viewing is not enough, and a request
 *   the actor cannot answer is not an item waiting on them);
 * - tasks: those of a session the actor may view;
 * - tickets: the tickets waiting on a person, the ones the actor may view;
 * - failed runs: from the CI runs the actor may view, so what supersedes a failure is also only what they can see.
 */
export function glanceSources(reads: GlanceReads): GlanceSources {
  return {
    sessions: (actor) => visible(actor, 'session', reads.chat.list(), (s: ChatSession) => s.id),
    requests: (actor, id): ChatRequest[] => (can(actor, 'operate', sessionRef(id)).allow ? reads.chat.openRequests(id) : []),
    // A session deleted between the listing and this call has no tasks to show.
    tasks: (actor, id): ChatTask[] => {
      if (!can(actor, 'view', sessionRef(id)).allow) return [];
      try {
        return reads.chat.tasks(id);
      } catch {
        return [];
      }
    },
    tickets: (actor) => {
      const { items, total } = reads.tickets.list({ kind: 'ui' }, { assignee: 'user', limit: GLANCE_LIMITS.tickets });
      const mine: TicketItem[] = visible(actor, 'ticket', items, (t) => t.id);
      // Nothing hidden: the portal's own count is whole. Something hidden from this actor: only what they can see is counted.
      return { count: mine.length === items.length ? total : mine.length, items: mine };
    },
    failedRuns: (actor, now) =>
      failedRuns(
        {
          list: (f) => {
            const found = reads.ci.list(f);
            return { items: visible(actor, 'ci_run', found.items as CiRunSummary[], (r) => r.id) };
          },
        },
        now,
        GLANCE_CI_WINDOW_MS,
        GLANCE_LIMITS.ci,
      ),
  };
}
