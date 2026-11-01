// Fine-grained org access (docs/prd/access.md; owner request 2026-11-01: "refine access management on the org level and delegation, ensure we
// can do properly fine grained access level"). One model on the grants of Authorization §13 and the org shares of organizations §6.4: a share
// gives the whole org, a team or one person view, operate or manage on one object (a workspace, a ticket bucket, a vault; CI remotes, runs and
// terminals follow their workspace), with an optional end and a note. Who may grant, the level ceiling, access requests, and the
// "who can reach this and why" answers are here; the routes hang under the org (`/api/orgs/:id/access/...`, declared `org` view, the service
// decides the rest). Sessions keep their own share (chat: read/send/approve/stop per session, `SESSION_SHARE_CAPS`).

import type { Level, OrgId, UserId } from './authz.js';
import type { OrgRole, OrgShare, OrgTransferKind } from './orgs.js';

export type AccessLevel = Exclude<Level, 'none'>;
export const ACCESS_LEVELS: readonly AccessLevel[] = ['view', 'operate', 'manage'];
export type AccessObjectType = OrgTransferKind;

export interface AccessLevelInfo {
  /** One word. */
  label: string;
  /** What it allows, in one short line (the level card). */
  short: string;
  /** Exactly what it allows, item by item (the InfoTip). */
  allows: readonly string[];
}

/**
 * What each level allows on each object type, in plain words (the level cards of the Access sheet). A level includes everything below it.
 * Kept here so the web and the PRD say the same thing the seam decides (each object module's declared routes).
 */
export const ACCESS_LEVEL_INFO: Record<AccessObjectType, Record<AccessLevel, AccessLevelInfo>> = {
  workspace: {
    view: { label: 'View', short: 'See it and read its sessions', allows: ['See the workspace and its status', 'Read sessions and transcripts, read-only', 'See its CI runs'] },
    operate: {
      label: 'Operate',
      short: 'Run sessions and terminals',
      allows: ['Everything in View', 'Start, send to and stop sessions', 'Open terminals', 'Run CI', 'Read the credential sets delivered into it'],
    },
    manage: { label: 'Manage', short: 'Change, share and delete it', allows: ['Everything in Operate', 'Change its settings and sets', 'Grant and revoke access', 'Move or delete it'] },
  },
  ticket_bucket: {
    view: { label: 'View', short: 'Read its tickets', allows: ['See the bucket and its tickets', 'Read comments and history'] },
    operate: { label: 'Operate', short: 'Create and work tickets', allows: ['Everything in View', 'Create, edit, move and comment on tickets'] },
    manage: { label: 'Manage', short: 'Change, share and delete it', allows: ['Everything in Operate', 'Change the bucket’s settings', 'Grant and revoke access', 'Move or delete it'] },
  },
  vault: {
    view: { label: 'View', short: 'Read its notes', allows: ['Read notes, links and the graph'] },
    operate: { label: 'Operate', short: 'Write notes', allows: ['Everything in View', 'Create, edit and delete notes'] },
    manage: { label: 'Manage', short: 'Change, share and delete it', allows: ['Everything in Operate', 'Change the vault’s settings', 'Grant and revoke access', 'Move or delete it'] },
  },
};

/** The end presets of the "Until" step; `date` is a picked day. */
export const ACCESS_UNTIL_PRESETS = [
  { key: 'none', label: 'No end', days: 0 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
] as const;

export const ACCESS_LIMITS = {
  noteMax: 200,
  /** The latest end a grant may have, in days from now. */
  maxDays: 365,
  /** The earliest end, in milliseconds from now (a grant that ends at once is a revoke). */
  minAheadMs: 60_000,
} as const;

/** Why a person reaches an object: one line of the effective-access answer. */
export type AccessReason =
  | { kind: 'owner'; level: AccessLevel }
  | { kind: 'org_role'; level: AccessLevel; role: OrgRole }
  | { kind: 'creator'; level: AccessLevel }
  | { kind: 'share'; level: AccessLevel; share: OrgShare; revocable: boolean };

/** One subject that can reach an object, and why (the object's side). */
export interface ObjectAccessEntry {
  subject: { kind: 'org'; id: OrgId; name: string } | { kind: 'team'; id: string; name: string } | { kind: 'user'; id: UserId; name: string } | { kind: 'org_managers'; id: OrgId; name: string };
  level: AccessLevel;
  reason: AccessReason;
}

/** `GET ACCESS_API.object(org, type, id)`: who can reach one object and why, and what the caller may grant on it. */
export interface ObjectAccess {
  target: { type: AccessObjectType; id: string };
  name: string;
  owner: { kind: 'org'; id: OrgId; name: string } | { kind: 'user'; id: UserId; name: string };
  myLevel: Level;
  /** The levels the caller may grant here (empty: they may not grant). */
  mayGrant: AccessLevel[];
  /** The latest end the caller may give (their own access ends then); null: no limit. */
  maxUntil: string | null;
  /** Everyone who can reach it, highest first. Only for a caller who may grant or an org owner or admin; else just the caller's own reasons. */
  entries: ObjectAccessEntry[];
  /** The caller's own reasons. */
  mine: AccessReason[];
  /** A workspace's credential sets (operate exposes them); only for a caller who may grant. */
  credentials: { poolId: string; name: string }[];
  /** The caller's open request on it, if any. */
  openRequest: AccessRequest | null;
}

/** One object a person reaches, and why (the person's side). */
export interface PersonAccessItem {
  target: { type: AccessObjectType; id: string };
  name: string;
  /** What the seam answers now (the reasons' highest, after every rule: a suspended org, SSO, a guest). */
  level: Level;
  reasons: AccessReason[];
}

/** `GET ACCESS_API.person(org, userId)`: what one member reaches in the org and why (org owners and admins; anyone for themselves). */
export interface PersonAccess {
  userId: UserId;
  name: string;
  role: OrgRole;
  items: PersonAccessItem[];
}

/** `GET ACCESS_API.catalog(org)`: the org's objects a member may ask for (members and up), with what they hold now. */
export interface AccessCatalogItem {
  target: { type: AccessObjectType; id: string };
  name: string;
  myLevel: Level;
  openRequest: string | null;
}

export type AccessRequestState = 'open' | 'approved' | 'denied' | 'cancelled';

export interface AccessRequest {
  id: string;
  orgId: OrgId;
  target: { type: AccessObjectType; id: string };
  name: string;
  requester: UserId;
  requesterName: string;
  level: AccessLevel;
  note: string | null;
  state: AccessRequestState;
  createdAt: string;
  decidedBy: UserId | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** On approval: the level and the end given (may differ from what was asked). */
  grantedLevel: AccessLevel | null;
  expiresAt: string | null;
  /** The caller may approve or deny it. */
  mayDecide: boolean;
}

export interface CreateAccessRequest {
  target: { type: AccessObjectType; id: string };
  level: AccessLevel;
  note?: string | null;
}

export interface DecideAccessRequest {
  /** Approve only: the level to give (default: what was asked), never above the decider's own. */
  level?: AccessLevel;
  expiresAt?: string | null;
  note?: string | null;
  /** Approve only: the decider saw that operate on a workspace exposes its credential sets (409 SHARE_EXPOSES_CREDENTIALS otherwise). */
  acknowledgeExposure?: boolean;
}

export const ACCESS_API = {
  /** GET -> AccessCatalogItem[] (members and up). */
  catalog: (org: OrgId) => `/api/orgs/${org}/access/catalog`,
  /** GET -> ObjectAccess (view on the object; else the same 404). */
  object: (org: OrgId, type: AccessObjectType, id: string) => `/api/orgs/${org}/access/object?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`,
  /** GET -> PersonAccess (org owners and admins; anyone for themselves). */
  person: (org: OrgId, userId: UserId) => `/api/orgs/${org}/access/people/${encodeURIComponent(userId)}`,
  /** GET -> AccessRequest[] (deciders: every open one and the last decided; others: their own); POST CreateAccessRequest -> AccessRequest. */
  requests: (org: OrgId) => `/api/orgs/${org}/access/requests`,
  /** DELETE: the requester cancels an open request. */
  request: (org: OrgId, id: string) => `/api/orgs/${org}/access/requests/${encodeURIComponent(id)}`,
  /** POST DecideAccessRequest -> AccessRequest. */
  approve: (org: OrgId, id: string) => `/api/orgs/${org}/access/requests/${encodeURIComponent(id)}/approve`,
  /** POST { note? } -> AccessRequest. */
  deny: (org: OrgId, id: string) => `/api/orgs/${org}/access/requests/${encodeURIComponent(id)}/deny`,
} as const;

/** The end of a preset from `now` (ISO), or null for no end. */
export function accessUntil(days: number, now: Date = new Date()): string | null {
  return days > 0 ? new Date(now.getTime() + days * 86_400_000).toISOString() : null;
}
