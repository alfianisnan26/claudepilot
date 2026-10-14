// Tickets and the authorization seam (apps/server/src/authz/seam.ts). The bump (FR28) reaches into a session, so its route and its tool
// declare both objects: operate on the ticket AND on the session it is pushed into (a session's parent is its workspace, so that is
// checked too). The handlers ask `requireCan` for each before the service runs; the service then applies the ticket rules (who may
// bump, which sessions can take it, the limits).

import type { RoutePolicies, ToolPolicies } from '@portal/contracts';
import { declarePolicies, declareToolPolicies } from '../authz/seam.js';

const ticket = (verb: 'view' | 'operate') => ({ type: 'ticket' as const, verb, from: 'path' as const, param: 'id' });

export const TICKET_BUMP_POLICIES = {
  'GET /api/tickets/bumped': { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'query', param: 'session' }] },
  'GET /api/tickets/:id/bump': { kind: 'objects', checks: [ticket('operate')], filter: 'session' },
  'POST /api/tickets/:id/bump': { kind: 'objects', checks: [ticket('operate'), { type: 'session', verb: 'operate', from: 'body', param: 'sessionId' }], audit: 'ticket.bumped' },
} satisfies RoutePolicies;

export const TICKET_BUMP_TOOL_POLICIES = {
  ticket_bump: {
    kind: 'objects',
    checks: [
      { type: 'ticket', verb: 'operate', arg: 'id' },
      { type: 'session', verb: 'operate', arg: 'session_id' },
    ],
    confirm: true,
    audit: 'ticket.bumped',
  },
} satisfies ToolPolicies;

/** `ticket_adopt` (T-270): within the agent's own workspace; the service applies the ended-session rule below. Confirmed and audited. */
export const TICKET_ADOPT_TOOL_POLICIES = {
  ticket_adopt: { kind: 'agent', reach: 'workspace', confirm: true, audit: 'ticket.adopted' },
} satisfies ToolPolicies;

export function declareTicketPolicies(): void {
  declarePolicies('tickets', TICKET_BUMP_POLICIES);
  declareToolPolicies('tickets', { ...TICKET_BUMP_TOOL_POLICIES, ...TICKET_ADOPT_TOOL_POLICIES });
}

/* ---------- Acting for an ended session (T-270) ---------- */

/** A session as the rule needs it. */
export interface RuleSession {
  id: string;
  workspaceId: string;
  state: string;
}

/** Why a live session may act on a ticket another session holds: it continues that session, or that session ended with nobody after it. */
export type EndedGrantReason = 'lineage' | 'orphan';
export type EndedDecision = { allow: true; why: EndedGrantReason } | { allow: false; why: 'not_a_session' | 'missing' | 'other_workspace' | 'live' | 'live_successor' | 'actor_ended' };

/**
 * THE rule for a ticket held by ANOTHER session (FR9a, T-270), the tickets module's `can()` for it: the acting session (live) may comment
 * on, change and close it only when the holder is an ENDED session of the SAME workspace and either is in the actor's lineage (`continued_from`
 * back from the actor: `lineage`) or has no live successor (`orphan`). A live holder, a person, a missing session or another workspace: refused,
 * and the caller keeps today's refusal. Pure: the service gathers the facts and writes the audit row with `why`.
 */
export function canActForEnded(facts: {
  actor: RuleSession;
  holder: RuleSession | null;
  holderKind: 'session' | 'user' | null;
  /** The actor's predecessors, nearest first (`continued_from` back). */
  actorAncestors: readonly string[];
  /** Whether any session continuing the holder (down its chain) is live. */
  holderHasLiveSuccessor: boolean;
}): EndedDecision {
  if (facts.holderKind !== 'session') return { allow: false, why: 'not_a_session' };
  if (facts.actor.state === 'ended') return { allow: false, why: 'actor_ended' };
  const h = facts.holder;
  if (!h) return { allow: false, why: 'missing' };
  if (h.workspaceId !== facts.actor.workspaceId) return { allow: false, why: 'other_workspace' };
  if (h.state !== 'ended') return { allow: false, why: 'live' };
  if (facts.actorAncestors.includes(h.id)) return { allow: true, why: 'lineage' };
  if (!facts.holderHasLiveSuccessor) return { allow: true, why: 'orphan' };
  return { allow: false, why: 'live_successor' };
}
