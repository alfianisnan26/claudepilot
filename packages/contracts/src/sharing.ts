// Sharing (docs/prd/sharing.md): giving another user, or a team, a level on something you own or manage, with a CONSENT SCREEN that lists what
// comes along and lets the person tick each item. A share is a bundle of ordinary grants made in one consented act, so revoking it removes
// exactly what it gave, at once (open sockets, running sessions and terminals included), and the list of who has what is always visible.
//
// The rules this file encodes:
// - What a share carries is what the preview lists, nothing else: later additions (a new ticket, a set assigned afterwards) are not shared.
// - CREDENTIALS DEFAULT OFF. A secrets set, an account's API key and a Claude's sign-in are readable by anyone who can OPERATE the workspace
//   (they can open a terminal), so they start unticked, with one warning. Unticked credentials that are in the workspace are REMOVED from it
//   when the share starts (the safe unassign), and the screen says so; ticking them is the person's decision and is audited.
// - A share to another user waits for that user to accept it (at operate and manage; a view-only share may be set to start at once); a share
//   to a team starts at once, because joining the team was the consent. Declining or leaving ends it.
// - Only an owner gives `manage`; a manager gives `view` or `operate`. Nobody gives more than they hold.
// - Sessions in a shared workspace stay private to their creator until the creator shares them (the same consent screen, with the session).

import type { Level, ObjectRef, ObjectType, OwnerSummary, TeamId, Verb } from './authz.js';
import type { UserSummary } from './identity.js';

export type ShareState = 'pending' | 'active' | 'declined' | 'revoked' | 'expired';

/** Who it is shared with. A user is named by an exact username (the lookup); a team by its id. */
export type ShareSubject = { kind: 'user'; username: string } | { kind: 'team'; teamId: TeamId };
export type ResolvedSubject = { kind: 'user'; user: UserSummary } | { kind: 'team'; team: { id: TeamId; name: string; members: number } };

/** Where an item sits on the consent screen: the workspace itself, its sets, its work, knowledge the person adds, and its credentials. */
export type ShareGroup = 'workspace' | 'sets' | 'work' | 'knowledge' | 'credentials';

/** One line of the consent screen. */
export interface ShareItem {
  ref: ObjectRef;
  name: string;
  group: ShareGroup;
  /** The level the item is given: `levelFor(ref.type, shareLevel)`. */
  level: Verb;
  /** It carries a value or a login anyone who can operate the workspace can read. Starts unticked. */
  credential: boolean;
  /** In a preview: whether it starts ticked. In a Share: whether it came along. */
  ticked: boolean;
  /** The person may not untick it (the workspace itself). */
  locked?: boolean;
  /** One short line for the row: `3 open tickets`, `signed in`. Never a secret, never a title an outsider could have written. */
  detail?: string | null;
}

/** Short notes the screen shows as ⓘ text or as ONE terse warning line; codes so the copy lives in the page. */
export type ShareNote =
  | 'operate_reads_everything' // operate = a terminal: everything in the workspace is readable, including delivered values and sign-ins
  | 'credentials_default_off' // credentials start unticked
  | 'unticked_credentials_removed' // credentials left unticked are removed from the workspace while it is shared
  | 'sessions_stay_private' // sessions stay private to their creator
  | 'revoke_cannot_undo' // revoking ends access at once but cannot take back what was already read
  | 'needs_acceptance' // the person must accept before it applies
  | 'adds_not_included' // things added later are not shared
  | 'billed_to_owner'; // the workspace runs on the owner's GitHub Codespaces (or another billed target): starting it bills the owner

export interface SharePreview {
  target: ObjectRef;
  targetName: string;
  subject: ResolvedSubject;
  level: Verb;
  items: ShareItem[];
  notes: ShareNote[];
  needsAcceptance: boolean;
  /** A recent password check is needed to confirm (sharing at manage, or ticking a credential). */
  needsReauth: boolean;
  /** sha256 of the list the person is shown (target, subject, level, every item ref with its credential mark). Sent back with the share: if what would come along changed in between, the share is refused (`SHARE_CHANGED`) and previewed again. */
  consent: string;
}

export interface CreateShareRequest {
  target: ObjectRef;
  subject: ShareSubject;
  level: Verb;
  /** The ticked items other than the target itself. Anything not listed does not come along. */
  items: ObjectRef[];
  /** ISO time; the share ends then. null or absent: until revoked. */
  expiresAt?: string | null;
  /** The person saw the credential warning: ticked ones are readable, unticked ones are removed. Required when the workspace holds any. */
  acknowledgeExposure?: boolean;
  /** `SharePreview.consent` of the screen the person confirmed. */
  consent: string;
}

export interface UpdateShareRequest {
  level?: Verb;
  /** The full list of ticked items after the change; removing one revokes its grant at once. */
  items?: ObjectRef[];
  expiresAt?: string | null;
}

export interface Share {
  id: string;
  target: ObjectRef;
  targetName: string;
  subject: ResolvedSubject;
  level: Verb;
  /** What came along (the ticked items). */
  items: ShareItem[];
  state: ShareState;
  createdBy: UserSummary;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
  /** `revoked by <name>`, `declined`, `left`, `expired`; text, no markup. */
  endedNote: string | null;
}

/** `GET /api/shares?direction=`: shares I made, shares made to me (pending ones first), or the shares on one object I manage (`object=<type>:<id>`). */
export type ShareDirection = 'by-me' | 'with-me';

/** A line of "who has access" on one object: the owner, then everyone who holds a level, and through what. */
export interface AccessEntry {
  subject: ResolvedSubject | { kind: 'owner'; owner: OwnerSummary };
  level: Level;
  via: 'owner' | 'share' | 'team';
  shareId: string | null;
  since: string | null;
  expiresAt: string | null;
}
export interface AccessList {
  object: ObjectRef;
  name: string;
  owner: OwnerSummary;
  entries: AccessEntry[];
  /** Shares still waiting for the other person. */
  pending: Share[];
}

/** Moving ownership: to another user (who must accept) or to a team the person belongs to. Only the owner may; it is audited. */
export interface TransferRequest {
  target: ObjectRef;
  to: ShareSubject;
}

/* ---------- Rules as data (the server enforces, the screen explains) ---------- */

/** What a share of a workspace brings for each kind of thing, given the level of the share. Sets are seen, work is worked on, credentials are used. */
export function levelFor(type: ObjectType, shareLevel: Verb): Verb {
  switch (type) {
    case 'workspace':
      return shareLevel;
    case 'pool':
      return 'view';
    case 'claude':
    case 'account_pool':
    case 'account':
    case 'endpoint':
      return 'operate';
    default:
      return shareLevel === 'manage' ? 'operate' : shareLevel;
  }
}

/** Whether an item is a credential: readable by an operator of the workspace it is delivered into, so it starts unticked. */
export function isCredential(r: ObjectRef): boolean {
  return (r.type === 'pool' && r.poolType === 'secrets') || r.type === 'account_pool' || r.type === 'account' || r.type === 'endpoint' || r.type === 'claude';
}

export const SHARE_LIMITS = {
  /** Shares a person may create in an hour (a flood of unwanted shares is abuse). */
  perUserPerHour: 30,
  /** Pending shares one person may have waiting, in total. */
  pendingPerRecipient: 20,
  /** A pending share ends after this many days. */
  pendingDays: 14,
} as const;

/* ---------- Routes ---------- */

export const SHARING_API = {
  /** POST CreateShareRequest-like { target, subject, level } -> SharePreview. Writes nothing. */
  preview: '/api/shares/preview',
  /** GET ?direction=by-me|with-me or ?object=<type>:<id> -> Share[]; POST CreateShareRequest -> Share. */
  shares: '/api/shares',
  share: (id: string) => `/api/shares/${id}`,
  accept: (id: string) => `/api/shares/${id}/accept`,
  decline: (id: string) => `/api/shares/${id}/decline`,
  /** GET ?type=&id= -> AccessList (needs manage on the object). */
  access: '/api/access',
  /** POST TransferRequest -> Share-like pending transfer. */
  transfer: '/api/objects/transfer',
} as const;

export const SHARING_ERROR_CODES = {
  /** A workspace with credentials in it, shared without the acknowledgement (409): the body lists them. */
  SHARE_EXPOSES_CREDENTIALS: 'SHARE_EXPOSES_CREDENTIALS',
  /** The subject already holds this level or more, or has a pending share for the object (409). */
  SHARE_EXISTS: 'SHARE_EXISTS',
  /** What would come along changed since the person looked (a set assigned, a ticket added): preview again (409). */
  SHARE_CHANGED: 'SHARE_CHANGED',
  /** The person tried to give more than they hold, or `manage` without owning (403). */
  SHARE_LEVEL_TOO_HIGH: 'SHARE_LEVEL_TOO_HIGH',
  /** Sharing with oneself, with a disabled account, or with a team the person is not in (422). */
  SHARE_SUBJECT_INVALID: 'SHARE_SUBJECT_INVALID',
} as const;
export type SharingErrorCode = (typeof SHARING_ERROR_CODES)[keyof typeof SHARING_ERROR_CODES];
