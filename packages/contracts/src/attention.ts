// Needs you (docs/prd/attention.md, T-146): one list of everything that waits for a person. Each module that owns a waiting thing
// registers a SOURCE on the server (`<module>/attention.ts`); the registry is read only: deciding stays on each module's own route with its
// own checks. Only REQUIRED items appear (D-10, D-34): an optional check never does.

/** What waits. One per source. */
export const ATTENTION_KINDS = ['mcp_version', 'skill_version', 'ci_deploy', 'ticket_approval', 'tool_approval'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** Why a person is required (D-10's classes). The order is the page's group order. */
export const ATTENTION_WHY = ['production_uat', 'secrets_permissions', 'third_party_code', 'gate', 'question'] as const;
export type AttentionWhy = (typeof ATTENTION_WHY)[number];

/** One or two words per class (text diet); the page's InfoTip says the rest. */
export const ATTENTION_WHY_LABEL: Record<AttentionWhy, string> = {
  production_uat: 'Production',
  secrets_permissions: 'Secrets',
  third_party_code: 'Outside code',
  gate: 'Approval',
  question: 'Question',
};

export const ATTENTION_KIND_LABEL: Record<AttentionKind, string> = {
  mcp_version: 'MCP',
  skill_version: 'Skills',
  ci_deploy: 'Deploys',
  ticket_approval: 'Tickets',
  tool_approval: 'Sessions',
};

/** A session's tool approval is listed once it has waited this long (T-256 item 4); a fresh one is the session's own card. */
export const ATTENTION_TOOL_WAIT_MS = 10 * 60_000;

/** Who asked: an agent's session, a token, a ticket. `link` is a page of the portal, or null when there is none to open. */
export interface AttentionWho {
  label: string;
  link: string | null;
}

/**
 * The module's own route that decides the item (slice 2's deck calls it; the page only links). `SOCKET`: answered on the chat socket
 * (`path` is the socket's), never by a plain request.
 */
export interface AttentionAction {
  label: string;
  method: 'POST' | 'SOCKET';
  path: string;
}

export interface AttentionItem {
  kind: AttentionKind;
  /** Unique within its kind (a version id, a run's deployment, a ticket id, `<session>/<request>`). */
  id: string;
  /** What (one line, untrusted text clipped). */
  title: string;
  who: AttentionWho[];
  why: AttentionWhy;
  /** The risk in one line: names and facts only, never a secret value. */
  risk: string;
  /** Since when it waits (ISO). */
  since: string;
  /** The exact item's page (the version preselected), never a list. */
  link: string;
  action: AttentionAction;
  /** Put off by the asking person until then (ISO): still waiting and counted, out of the deck until that time. Absent: not snoozed. */
  snoozedUntil?: string;
}

/** `GET /api/attention`. `counts` is every item per kind, whatever the page; null: that source could not be read ("unavailable", never 0). */
export interface AttentionList {
  total: number;
  counts: Record<AttentionKind, number | null>;
  unavailable: AttentionKind[];
  items: AttentionItem[];
  offset: number;
  limit: number;
  /** When the list was read (ISO). */
  at: string;
}

/** `POST /api/attention/snooze`: put one item off for the person (the deck's swipe left). `minutes` 0 brings it back now. */
export interface AttentionSnoozeRequest {
  kind: AttentionKind;
  id: string;
  minutes?: number;
}

/** Later: an hour unless the person says otherwise; never longer than a day (an item never vanishes). */
export const ATTENTION_SNOOZE_DEFAULT_MIN = 60;
export const ATTENTION_SNOOZE_MAX_MIN = 24 * 60;

/** The deck (or a push) opens at one item: `?item=<kind>:<id>`. */
export const attentionItemKey = (i: { kind: AttentionKind; id: string }): string => `${i.kind}:${i.id}`;
export const attentionDeckPath = (i: { kind: AttentionKind; id: string }): string => `/admin/attention?item=${encodeURIComponent(attentionItemKey(i))}`;

export const ATTENTION_PAGE_MAX = 200;
export const ATTENTION_PAGE_DEFAULT = 100;

export const isAttentionKind = (v: unknown): v is AttentionKind => typeof v === 'string' && (ATTENTION_KINDS as readonly string[]).includes(v);
