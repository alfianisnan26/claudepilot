// Approvals (docs/prd/approvals.md, PILOT-1000 / T-2867): the T2 tier of PILOT-996. An agent (or the portal, for one of its own
// refusals) asks; a PERSON allows or denies; on Allow the portal runs the exact stored payload itself, through one executor per kind, and
// tells the asking session what happened. A payload is never edited after it is made and never holds a secret value (a kind that needs
// one names it). Deciding is never an MCP tool: an agent's token can ask, list and read its own requests, nothing else.

/**
 * What can be asked. `test.echo` exists for the tests and a dry run of the flow; `session.bypass` puts a bypass-capable session in Bypass;
 * `pool.secret_set` sets one secret in a secrets pool an agent may not write itself (a protected one): the payload names the pool and the
 * secret, and the VALUE is typed by the person on Allow (write-only, never stored with the request).
 */
export const APPROVAL_KINDS = ['test.echo', 'session.bypass', 'pool.secret_set'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export const isApprovalKind = (v: unknown): v is ApprovalKind => typeof v === 'string' && (APPROVAL_KINDS as readonly string[]).includes(v);

/** One or two words per kind (text diet). */
export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  'test.echo': 'Test',
  'session.bypass': 'Bypass',
  'pool.secret_set': 'Secret',
};

/** The kinds whose Allow takes a value the person types (write-only: sent once with Allow, never stored, shown or returned). */
export const approvalNeedsValue = (kind: ApprovalKind): boolean => kind === 'pool.secret_set';

export const APPROVAL_STATUSES = ['pending', 'allowed', 'denied', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** PILOT-996's tiers. A request is always T2 today (a one-click card); T3 (owner only, never run by the portal) is not built. */
export const APPROVAL_TIERS = ['T2'] as const;
export type ApprovalTier = (typeof APPROVAL_TIERS)[number];

/** How long a request waits for a person by default, and at most. */
export const APPROVAL_TTL_DEFAULT_MIN = 24 * 60;
export const APPROVAL_TTL_MAX_MIN = 7 * 24 * 60;
/** The reason an agent gives, and a person's reason for a Deny, at most this long. */
export const APPROVAL_REASON_MAX = 500;
/** A payload's JSON, at most this many bytes. */
export const APPROVAL_PAYLOAD_MAX_BYTES = 4_000;

/** What Allow did: the executor's output (facts, never a secret), or why it failed. */
export interface ApprovalResult {
  ok: boolean;
  /** One line for the person and the agent. */
  message: string;
  /** Small facts the executor returns (`{ mode: 'bypassPermissions' }`). */
  output?: Record<string, string | number | boolean | null>;
}

export interface Approval {
  id: string;
  kind: ApprovalKind;
  /** The exact thing the portal runs on Allow, as stored (never edited). Secret-shaped strings never get in. */
  payload: Record<string, unknown>;
  /** Who asked: the asking chat session, or null when the portal asked for one of its own refusals. */
  requesterSession: string | null;
  /** The asking session's title when it is known (agent text: show it as such). */
  requesterTitle: string | null;
  workspace: string | null;
  tier: ApprovalTier;
  /** Why the agent asks (its own words: untrusted text). */
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  /** Who decided (`ui` for the signed-in person), or null. */
  decidedBy: string | null;
  decidedAt: string | null;
  /** Allow: what the run did. Deny: `{ ok: false, message: <the person's reason> }`. */
  result: ApprovalResult | null;
}

/**
 * `POST /api/approvals/:id/allow`. `value`: only for a kind that needs one ({@link approvalNeedsValue}): the secret the person types. It goes
 * to the kind's executor in memory and is never stored in the request, its result, an audit row or a message.
 */
export interface AllowApprovalRequest {
  value?: string;
}
/** `POST /api/approvals/:id/deny`. */
export interface DenyApprovalRequest {
  reason?: string;
}

export interface ApprovalList {
  items: Approval[];
}

export const APPROVALS_API = {
  list: '/api/approvals',
  one: (id: string) => `/api/approvals/${encodeURIComponent(id)}`,
  allow: (id: string) => `/api/approvals/${encodeURIComponent(id)}/allow`,
  deny: (id: string) => `/api/approvals/${encodeURIComponent(id)}/deny`,
} as const;

/** The page of one request (the deck's card and a push open it). */
export const approvalPath = (id: string): string => `/admin/approvals/${encodeURIComponent(id)}`;
