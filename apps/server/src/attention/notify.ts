// Needs you to notifications (docs/prd/attention.md, T-146 slice 2): a NEW item tells each person who may decide it, once.
//
// - Once per item and person: the registry's event names only what appeared since its last read (its first read is the baseline, so a
//   restart announces nothing again), and the bridge remembers what it sent, so an item that leaves and comes back is not sent twice.
// - Nothing twice across kinds: a stuck tool approval, a deploy that waits and a ticket for a person already have their own notification
//   (`approval`, `ci_waiting`, `human_request`), so only the kinds nobody else announces go out here (an MCP or a skill version).
// - Each person's own view: an item is sent to a person only if their own read of the registry (their module's `can()`) lists it.
// - Quiet hours, mutes, the per-destination kinds (the matrix's `Needs you` row), collapse and the cap are the pipeline's, as for any event.
// - What goes out: the kind and the reason in fixed words; the item's title is agent text, so it is only the untrusted `detail`.

import { ATTENTION_KIND_LABEL, ATTENTION_WHY_LABEL, attentionItemKey, type Actor, type AttentionKind } from '@portal/contracts';
import { cleanDetail, type NotifyBus } from '../notify/bus.js';
import type { AttentionRegistry } from './registry.js';

/** The kinds another notification already announces (the bridge stays quiet for them). */
export const ATTENTION_NOTIFIED_ELSEWHERE: ReadonlySet<AttentionKind> = new Set<AttentionKind>(['tool_approval', 'ci_deploy', 'ticket_approval', 'keepgoing_down']);

/** How many sent items are remembered (oldest forgotten first); far more than ever wait at once. */
const REMEMBER = 5_000;

export function bridgeAttentionNotify(registry: AttentionRegistry, bus: Pick<NotifyBus, 'emit'>, people: () => string[]): () => void {
  const sent = new Set<string>();
  return registry.onChange((e) => {
    const fresh = e.added.filter((r) => !ATTENTION_NOTIFIED_ELSEWHERE.has(r.kind));
    if (fresh.length === 0) return;
    const wanted = new Set(fresh.map(attentionItemKey));
    for (const userId of people()) {
      const actor: Actor = { kind: 'user', userId, loginSessionId: 'attention-notify', via: 'ui' };
      for (const item of registry.list(actor, { limit: 200 }).items) {
        const key = attentionItemKey(item);
        const mark = `${userId}\u0000${key}`;
        if (!wanted.has(key) || sent.has(mark)) continue;
        sent.add(mark);
        if (sent.size > REMEMBER) sent.delete(sent.values().next().value!);
        bus.emit({
          kind: 'attention',
          subject: { type: 'portal', id: `attention:${key}` },
          facts: { what: ATTENTION_KIND_LABEL[item.kind], why: ATTENTION_WHY_LABEL[item.why] },
          detail: cleanDetail(item.title, 120),
          audience: [userId],
        });
      }
    }
  });
}
