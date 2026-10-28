// Needs you (T-146): every pending approval is one item for a person, so it shows in the app's list, the phone deck and (attention/notify.ts)
// a Web Push. The item links the request's own page, where the card shows the exact payload and Allow and Deny (POST .../allow).

import { APPROVAL_KIND_LABEL, APPROVALS_API, approvalPath, type AttentionItem } from '@portal/contracts';
import { clip, present, readsPersonOnly, sessionWho, type AttentionSource } from '../attention/registry.js';
import { APPROVAL_KIND_DEFS } from './kinds.js';
import type { Approvals } from './service.js';

export function approvalAttentionSource(approvals: Pick<Approvals, 'pendingRows' | 'chat'>): AttentionSource {
  return {
    kind: 'approval',
    list(actor, now, scope) {
      // Deciding is a person's; `see` (the coordinator's view) lists them too, with nothing a person's card would not show.
      if (!readsPersonOnly(actor, scope)) return [];
      return approvals.pendingRows(now).map((a): AttentionItem => {
        const def = APPROVAL_KIND_DEFS[a.kind];
        return {
          kind: 'approval',
          id: a.id,
          title: clip(def.title(a.payload, approvals.chat), 120),
          who: present([sessionWho(a.requesterSession, a.requesterTitle) ?? { label: 'Portal', link: null }]),
          why: def.why,
          risk: `${APPROVAL_KIND_LABEL[a.kind]} (${a.tier}), expires ${a.expiresAt}`,
          since: a.createdAt,
          link: approvalPath(a.id),
          action: { label: 'Review', method: 'POST', path: APPROVALS_API.allow(a.id) },
        };
      });
    },
  };
}
