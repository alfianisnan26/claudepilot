// Needs you and the authorization seam (apps/server/src/authz/seam.ts). The registry owns no object type: each source keeps the items the
// actor may DECIDE through its own module's `can()` (an MCP version: manage on the entry; a skill version: manage on it; a deploy: manage on
// the run, as its approve route; a ticket: operate; a tool approval: operate on the session). So the route is only "signed in", and what it
// returns is already filtered. Nothing here decides anything.

import type { RoutePolicies } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

export const ATTENTION_POLICIES = {
  // Counts by kind and one page of items: each source filters by the actor's rights, so a denial is the same absence as a missing item.
  'GET /api/attention': { kind: 'signed-in' },
  // Later (the deck's swipe left): a person's own snooze of an item they see now; anything else is the same 404 as a missing item.
  'POST /api/attention/snooze': { kind: 'signed-in' },
} satisfies RoutePolicies;

export function declareAttentionPolicies(): void {
  declarePolicies('attention', ATTENTION_POLICIES);
}
