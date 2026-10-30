// Needs you (T-146): every pending approval is one item for a person, so it shows in the app's list, the phone deck and (attention/notify.ts)
// a Web Push. The item links the request's own page, where the card shows the exact payload and Allow and Deny (POST .../allow).

import { APPROVAL_KIND_LABEL, APPROVALS_API, approvalPath, isRefusalKind, type AttentionItem } from '@portal/contracts';
import { clip, isPerson, present, readsPersonOnly, sessionWho, type AttentionSource } from '../attention/registry.js';
import { APPROVAL_KIND_DEFS } from './kinds.js';
import type { Approvals } from './service.js';

export function approvalAttentionSource(approvals: Pick<Approvals, 'pendingRows' | 'deps'>): AttentionSource {
  return {
    kind: 'approval',
    list(actor, now, scope) {
      // Deciding is a person's; `see` (the coordinator's view) lists them too, with nothing a person's card would not show.
      if (!readsPersonOnly(actor, scope)) return [];
      // A title quotes names an agent wrote (a session title, a secret name): a person sees them quoted; an agent reading with `see` gets
      // the kind's label only, so no agent's words reach another agent through this list (review nit 1, T-2867).
      const person = isPerson(actor);
      return approvals.pendingRows(now).map((a): AttentionItem => {
        const def = APPROVAL_KIND_DEFS[a.kind];
        const count = a.count ?? 1;
        return {
          kind: 'approval',
          id: a.id,
          title: person ? clip(def.title(a.payload, approvals.deps), 120) : `${APPROVAL_KIND_LABEL[a.kind]} request`,
          who: present([sessionWho(a.requesterSession, a.requesterTitle) ?? { label: 'Portal', link: null }]),
          why: def.why,
          risk: `${APPROVAL_KIND_LABEL[a.kind]} (${a.tier})${count > 1 ? `, refused ${count} times` : ''}, expires ${a.expiresAt}`,
          since: a.createdAt,
          link: approvalPath(a.id),
          action: { label: 'Review', method: 'POST', path: APPROVALS_API.allow(a.id) },
          // T-3114: a refused call is the guard working; it sorts after the real asks and the page folds it into one group.
          ...(isRefusalKind(a.kind) ? { group: 'refusal' as const } : {}),
          ...(count > 1 ? { count } : {}),
        };
      });
    },
  };
}
