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

export function declareTicketPolicies(): void {
  declarePolicies('tickets', TICKET_BUMP_POLICIES);
  declareToolPolicies('tickets', TICKET_BUMP_TOOL_POLICIES);
}
