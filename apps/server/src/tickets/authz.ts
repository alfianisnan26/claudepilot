// Tickets and the authorization seam (apps/server/src/authz/seam.ts). The bump (FR28) reaches into a session, so its route and its tool
// declare both objects: operate on the ticket AND on the session it is pushed into (a session's parent is its workspace, so that is
// checked too). The handlers ask `requireCan` for each before the service runs; the service then applies the ticket rules (who may
// bump, which sessions can take it, the limits).

import { objectRef, type RoutePolicies, type ToolPolicies } from '@portal/contracts';
import { declarePolicies, declareToolPolicies, registerResolver } from '../authz/seam.js';

const ticket = (verb: 'view' | 'operate') => ({ type: 'ticket' as const, verb, from: 'path' as const, param: 'id' });

export const TICKET_BUMP_POLICIES = {
  'GET /api/tickets/bumped': { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'query', param: 'session' }] },
  'GET /api/tickets/:id/bump': { kind: 'objects', checks: [ticket('operate')], filter: 'session' },
  'POST /api/tickets/:id/bump': { kind: 'objects', checks: [ticket('operate'), { type: 'session', verb: 'operate', from: 'body', param: 'sessionId' }], audit: 'ticket.bumped' },
} satisfies RoutePolicies;

/** Attachments (owner, 2026-10-17): seeing them needs view on the ticket, adding or removing one needs operate. */
export const TICKET_ATTACHMENT_POLICIES = {
  'GET /api/tickets/:id/attachments': { kind: 'objects', checks: [ticket('view')] },
  'POST /api/tickets/:id/attachments': { kind: 'objects', checks: [ticket('operate')], audit: 'ticket.attached' },
  'GET /api/tickets/:id/attachments/:attachmentId': { kind: 'objects', checks: [ticket('view')] },
  'DELETE /api/tickets/:id/attachments/:attachmentId': { kind: 'objects', checks: [ticket('operate')], audit: 'ticket.attachment_removed' },
} satisfies RoutePolicies;

export const TICKET_BUMP_TOOL_POLICIES = {
  ticket_bump: {
    kind: 'objects',
    checks: [
      { type: 'ticket', verb: 'operate', arg: 'id' },
      { type: 'session', verb: 'operate', arg: 'session_id', optional: true },
    ],
    confirm: true,
    audit: 'ticket.bumped',
  },
} satisfies ToolPolicies;

/** `ticket_adopt` (T-270): within the agent's own workspace; the service applies the ended-session rule below. Confirmed and audited. */
export const TICKET_ADOPT_TOOL_POLICIES = {
  ticket_adopt: { kind: 'agent', reach: 'workspace', confirm: true, audit: 'ticket.adopted' },
} satisfies ToolPolicies;

/**
 * `ticket_verdict` (T-325, FR36): a QA or review session of the agent's own workspace records a verdict on one commit. The rule (`canRecordVerdict`
 * in `verdicts.ts`) refuses the author, the lead, any session an author started (S1b) and any non-verifier; a ticket the caller cannot see is the same not found. Audited.
 */
export const TICKET_VERDICT_TOOL_POLICIES = {
  ticket_verdict: { kind: 'agent', reach: 'workspace', audit: 'ticket.verdict' },
} satisfies ToolPolicies;

/* ---------- Buckets (T-1098): an object of the seam ---------- */

const bucket = (verb: 'view' | 'operate' | 'manage') => ({ type: 'ticket_bucket' as const, verb, from: 'path' as const, param: 'key' });

/**
 * A bucket is its owner's (`owner_id`, the founding user for the seeded ones): view = see it and its tickets, operate = file a ticket in it,
 * manage = change it. A refusal is the same 404 as a missing bucket. The ticket routes also check the ticket's bucket (routes.ts).
 */
export const TICKET_BUCKET_POLICIES = {
  'GET /api/tickets/buckets': { kind: 'signed-in', filter: 'ticket_bucket' },
  'POST /api/tickets/buckets': { kind: 'signed-in', creates: 'ticket_bucket', audit: 'ticket.bucket_created' },
  'GET /api/tickets/buckets/:key': { kind: 'objects', checks: [bucket('view')] },
  'PATCH /api/tickets/buckets/:key': { kind: 'objects', checks: [bucket('manage')], audit: 'ticket.bucket_updated' },
  // T-1967: owner only (the handler also asks manage on the platform's settings) and manage on both buckets; every ticket moves with its old key kept as an alias.
  'POST /api/tickets/buckets/:key/merge': {
    kind: 'objects',
    checks: [bucket('manage'), { type: 'ticket_bucket', verb: 'manage', from: 'body', param: 'into' }],
    audit: 'ticket.bucket_merged',
  },
  'POST /api/tickets/bucket-moves': { kind: 'platform', area: 'settings', verb: 'manage', audit: 'ticket.bucket_moved' },
} satisfies RoutePolicies;

/** The tools name a bucket in `bucket`: filing needs operate, listing by it needs view; refused at dispatch as "No such bucket.". */
export const TICKET_BUCKET_TOOL_POLICIES = {
  ticket_create: { kind: 'objects', checks: [{ type: 'ticket_bucket', verb: 'operate', arg: 'bucket', optional: true, notFound: 'No such bucket.' }] },
  ticket_list: { kind: 'objects', checks: [{ type: 'ticket_bucket', verb: 'view', arg: 'bucket', optional: true, notFound: 'No such bucket.' }] },
  // T-1967: moving a ticket needs operate on the bucket it goes to (the service applies who may change the ticket).
  ticket_update: { kind: 'objects', checks: [{ type: 'ticket_bucket', verb: 'operate', arg: 'bucket', optional: true, notFound: 'No such bucket.' }] },
  ticket_buckets: { kind: 'signed-in', filter: 'ticket_bucket' },
} satisfies ToolPolicies;

/** The seam's resolver for `ticket_bucket`: its owner, read now (a removed bucket is not found). */
export function registerTicketBucketAuthz(tickets: { bucketOwner(key: string): string | null }): void {
  registerResolver({
    type: 'ticket_bucket',
    resolve(id) {
      const key = id.trim().toUpperCase();
      let owner: string | null;
      try {
        owner = tickets.bucketOwner(key);
      } catch {
        return null; // no database: nothing to decide on, the same not found
      }
      return owner ? { ref: objectRef('ticket_bucket', key), owner: { kind: 'user', id: owner } } : null;
    },
  });
}

export function declareTicketPolicies(): void {
  declarePolicies('tickets', { ...TICKET_BUMP_POLICIES, ...TICKET_ATTACHMENT_POLICIES, ...TICKET_BUCKET_POLICIES });
  declareToolPolicies('tickets', { ...TICKET_BUMP_TOOL_POLICIES, ...TICKET_ADOPT_TOOL_POLICIES, ...TICKET_VERDICT_TOOL_POLICIES, ...TICKET_BUCKET_TOOL_POLICIES });
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

/* ---------- An agent puts a ticket on a person (D-62, T-483) ---------- */

/** The refusal an agent reads: the D-62 path instead of a person. */
export const D62_ASSIGN_REFUSAL =
  'D-62: agents do not assign tickets to a person. Decide by the written default and note it on the ticket; a production step goes on the owner checklist (tag production); a rule change goes through a blind reviewer and the coordinator.';

/** The tags that let an agent's ticket wait for a person when the setting is absent or unreadable. */
export const AGENT_ASSIGN_USER_TAGS_DEFAULT = 'production';

/** `tickets.agentAssignUserTags` as a list: comma or space separated, lowercase. Not a string: the default. Empty: no tag allows it. */
export function allowedAssignTags(raw: unknown): string[] {
  const s = typeof raw === 'string' ? raw : AGENT_ASSIGN_USER_TAGS_DEFAULT;
  return [...new Set(s.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

export type AgentAssignDecision = { allow: true } | { allow: false; why: 'no_allowed_tag' };

/**
 * THE rule for an agent putting a ticket on a person (FR9c, D-62, T-483), the tickets module's `can()` for it. Only an agent's own token
 * (a chat session or a crew worker) is judged: a person, the portal, an admin's token and a trigger a person made are never refused. The
 * agent is refused when, after its change, the ticket is on a person (`user`, `user:<name>`) without a tag the owner allows
 * (`allowedTags`), and its change is what puts it there: it creates it so, moves it to a person (or another person), or removes the
 * last allowed tag from a ticket a person holds. A ticket already on a person that the change leaves so is not judged again.
 * Pure: the service gathers the facts, refuses with {@link D62_ASSIGN_REFUSAL} and writes the audit row.
 */
export function canAgentAssignUser(facts: {
  callerKind: 'ui' | 'system' | 'token' | 'agent' | 'trigger';
  /** The holder after the change. */
  assigneeAfter: 'session' | 'user' | null;
  /** The change sets the assignee to a person (a new ticket, or a different holder than before). */
  assignsUser: boolean;
  tagsBefore: readonly string[];
  tagsAfter: readonly string[];
  allowedTags: readonly string[];
}): AgentAssignDecision {
  if (facts.callerKind !== 'agent' || facts.assigneeAfter !== 'user') return { allow: true };
  const allowed = (tags: readonly string[]) => tags.some((t) => facts.allowedTags.includes(t));
  if (allowed(facts.tagsAfter)) return { allow: true };
  if (facts.assignsUser || allowed(facts.tagsBefore)) return { allow: false, why: 'no_allowed_tag' };
  return { allow: true };
}

/* ---------- An agent puts a ticket on the owner checklist (D-62, T-527) ---------- */

/** The owner's checklist tag (T-509): a ticket carrying it is listed on Needs you whatever its assignee. */
export const OWNER_CHECKLIST_TAG = 'owner-checklist';

/** The refusal an agent reads when it tags a ticket owner-checklist without an allowed tag: the same D-62 path as {@link D62_ASSIGN_REFUSAL}. */
export const D62_CHECKLIST_REFUSAL =
  'D-62: agents do not put a ticket on the owner checklist (tag owner-checklist) on their own. Decide by the written default and note it on the ticket; a production step goes on the owner checklist with the tag production as well; a rule change goes through a blind reviewer and the coordinator.';

export type AgentChecklistDecision = { allow: true } | { allow: false; why: 'checklist_without_allowed_tag' };

/**
 * THE rule for an agent adding `owner-checklist` (FR9d, D-62, T-527), the tickets module's `can()` for it, next to {@link canAgentAssignUser}:
 * the tag puts a ticket in the owner's Needs you without an assignee, so it needs the same allowed tag (`tickets.agentAssignUserTags`,
 * default `production`). Only an agent's own token is judged; a person, the portal, an admin's token and a trigger are never refused.
 * Only ADDING the tag is judged: removing it is always allowed, and a ticket that already carries it is not judged again.
 * Pure: the service gathers the facts, refuses with {@link D62_CHECKLIST_REFUSAL} and writes the audit row.
 */
export function canAgentTagChecklist(facts: {
  callerKind: 'ui' | 'system' | 'token' | 'agent' | 'trigger';
  tagsBefore: readonly string[];
  tagsAfter: readonly string[];
  allowedTags: readonly string[];
}): AgentChecklistDecision {
  if (facts.callerKind !== 'agent') return { allow: true };
  if (!facts.tagsAfter.includes(OWNER_CHECKLIST_TAG) || facts.tagsBefore.includes(OWNER_CHECKLIST_TAG)) return { allow: true };
  if (facts.tagsAfter.some((t) => facts.allowedTags.includes(t))) return { allow: true };
  return { allow: false, why: 'checklist_without_allowed_tag' };
}

/* ---------- A crew worker reports on its work (T-294, T-397) ---------- */

/**
 * Why a worker may comment: the ticket its spawn named (`spawn_ticket`), a ticket its lead holds (`lead_ticket`), one a crew mate holds
 * (`crew_ticket`), or an unassigned ticket of its own workspace (`crew_queue`).
 */
export type WorkerCommentReason = 'spawn_ticket' | 'lead_ticket' | 'crew_ticket' | 'crew_queue' | 'lead_peer';
export type WorkerCommentDecision = { allow: true; why: WorkerCommentReason } | { allow: false };

/**
 * THE rule for a crew worker's COMMENT on a ticket it does not hold (FR9b, T-294 and T-397), the tickets module's `can()` for it. It grants a
 * comment only: never a change, a close, a claim or an adoption. The worker must be LIVE and have a lead (`parentId`). Then it may comment on:
 * - `lead_ticket`: a ticket a session holds that is its lead, or a session continuing its lead (`continued_from` back from the holder reaches
 *   the lead: a restarted lead's tickets move to its successor, FR18a). Its lead's own lead is not followed.
 * - `crew_ticket`: a ticket a CREW MATE holds: a session with the same lead (QA and review lanes verify the build lanes' tickets and post their
 *   evidence there; 2026-10-17 every Konfersi QA verdict comment was refused, T-969). A session outside the crew stays refused.
 * - `spawn_ticket`: the ticket its spawn named (the session's `ticketId`, set only by `session_spawn`) while NOBODY holds it (the lead started
 *   the worker before claiming). Held by a person or by another session, it is refused: a lead cannot open someone else's ticket by naming it.
 * - `crew_queue` (2026-10-18): a ticket NOBODY holds, in the worker's own workspace. Long-lived lanes (D-70) take ticket after ticket, so their
 *   spawn ticket is rarely the one they work, and every report on an unassigned ticket went to the coordinator to post (T-84 c11361, c11378,
 *   c11481). A comment only; another workspace's ticket, or one held by a person or by another crew, stays refused.
 * Pure: the service gathers the facts, keeps today's refusal on a deny, and writes the audit row with `why`.
 */
export function canWorkerComment(facts: {
  worker: RuleSession & { parentId?: string | null; ticketId?: string | null };
  /** The ticket, `T-<n>`. */
  ticketId: string;
  holderKind: 'session' | 'user' | null;
  holderId: string | null;
  /** The holder session's predecessors, nearest first (`continued_from` back); empty when it is not a session. */
  holderAncestors: readonly string[];
  /** The holder session's own lead (`parentId`), when it is a session with one. */
  holderLead?: string | null;
  /** The ticket's workspace (null: the shared queue). */
  ticketWorkspace?: string | null;
}): WorkerCommentDecision {
  const lead = facts.worker.parentId;
  if (!lead || facts.worker.state === 'ended') return { allow: false };
  if (facts.holderKind === 'session' && facts.holderId && (facts.holderId === lead || facts.holderAncestors.includes(lead))) return { allow: true, why: 'lead_ticket' };
  if (facts.holderKind === 'session' && facts.holderId && facts.holderId !== facts.worker.id && facts.holderLead === lead) return { allow: true, why: 'crew_ticket' };
  if (facts.holderKind === null && facts.worker.ticketId === facts.ticketId) return { allow: true, why: 'spawn_ticket' };
  if (facts.holderKind === null && facts.ticketWorkspace && facts.ticketWorkspace === facts.worker.workspaceId) return { allow: true, why: 'crew_queue' };
  return { allow: false };
}

/**
 * D-85 (2026-10-18): the leads of ONE program talk on each other's tickets. T-1839 (2026-10-20): and close them, also when a WORKER of a peer
 * lead holds it (the general lead merged and deployed T-993, T-1162, T-1506 and T-1617 but its close was refused; its comments on tickets its
 * peers' lanes held were refused too). A live top-level session may COMMENT on and CLOSE a ticket held by a session of its workspace whose
 * crew root (the top of its `parentId` chain: the holder itself when it is a lead) is in one group of `tickets.leadPeerGroups` with it (an
 * owner-only setting: ids, never a title an agent could rename; review 2026-10-18). `actorLineage` is the actor's id plus its predecessors
 * (continued_from back), so a continuation of a listed lead counts as it; `rootLineage` is the root's id with its predecessors AND its
 * continuations, so a worker started by a lead that was continued still belongs to the listed successor (as T-1603). The holder may have
 * ended (a lane that delivered and stopped). The service passes a null root when the chain is broken (a missing session, a cycle, too deep):
 * refused (fail closed). Nothing else is granted (no change, claim or attachment); a worker (an actor with a lead) never.
 */
export function canPeerLeadAct(facts: {
  actor: RuleSession & { parentId?: string | null };
  holder: RuleSession | null;
  /** The top of the holder's `parentId` chain (a session without a lead), or null when the chain cannot be followed. */
  root: (RuleSession & { parentId?: string | null }) | null;
  actorLineage: readonly string[];
  rootLineage: readonly string[];
  groups: readonly (readonly string[])[];
}): boolean {
  const { actor, holder, root } = facts;
  if (!holder || !root || actor.id === holder.id || actor.parentId || root.parentId) return false;
  if (actor.state === 'ended' || actor.workspaceId !== holder.workspaceId || actor.workspaceId !== root.workspaceId) return false;
  return facts.groups.some((g) => facts.actorLineage.some((id) => g.includes(id)) && facts.rootLineage.some((id) => g.includes(id)));
}

/** `tickets.leadPeerGroups` parsed: groups by ";", ids by ","; anything not a plain id is dropped (fail closed). */
export function parseLeadPeerGroups(raw: unknown): string[][] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(';')
    .map((g) => g.split(',').map((x) => x.trim()).filter((x) => /^[0-9a-f-]{8,64}$/.test(x)))
    .filter((g) => g.length > 1);
}
