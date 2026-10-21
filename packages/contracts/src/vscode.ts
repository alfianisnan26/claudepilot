// The VS Code extension's API (docs/prd/vscode-extension.md, T-1974). Self-contained on purpose: the extension (tools/vscode, outside the
// npm workspaces) bundles this file as it is, so it imports nothing and holds no Node-only code.
//
// Three doors:
//   - public: the version check and the device flow's two client calls (no cookie, no token: the device code is the door);
//   - the signed-in person's: look up a code and approve or deny it (the session cookie and the Origin rule, like every /api route);
//   - bearer: everything the extension reads and does, with the token the device flow issued (`Authorization: Bearer`, never a cookie).

/** The API the extension and the portal speak. Bumped on a change an older extension can't read; the extension refuses a portal outside its range. */
export const VSCODE_API_VERSION = 1;
/** Every answer under /api/vscode carries the portal's API version in this header, so a client can warn on any response. */
export const VSCODE_API_HEADER = 'X-Pilot-Vscode-Api';

export const VSCODE_API = {
  version: '/api/vscode/version',
  device: '/api/vscode/device',
  token: '/api/vscode/token',
  /** Cookie: what a code asks for (GET ?code=), and the person's answer (POST). */
  pending: '/api/vscode/pending',
  approve: '/api/vscode/approve',
  /** Bearer. */
  me: '/api/vscode/me',
  logout: '/api/vscode/logout',
  agents: '/api/vscode/agents',
  tickets: '/api/vscode/tickets',
  workspaces: '/api/vscode/workspaces',
  status: '/api/vscode/status',
  approvals: '/api/vscode/approvals',
  events: (sessionId: string) => `/api/vscode/sessions/${encodeURIComponent(sessionId)}/events`,
  send: (sessionId: string) => `/api/vscode/sessions/${encodeURIComponent(sessionId)}/send`,
  respond: (sessionId: string) => `/api/vscode/sessions/${encodeURIComponent(sessionId)}/respond`,
} as const;

/** Where the person approves a code in the portal (the web app's page). */
export const VSCODE_VERIFY_PATH = '/admin/vscode';

/** The label every token the device flow issues starts with; the rest is the client's name. Only such tokens open the bearer routes. */
export const VSCODE_TOKEN_LABEL_PREFIX = 'VS Code · ';
/** How long a device code lives before it must be started again (RFC 8628 `expires_in`), and the least wait between two polls. */
export const VSCODE_DEVICE_TTL_S = 600;
export const VSCODE_POLL_INTERVAL_S = 5;
/** The issued token's lifetime (one of PORTAL_TOKEN_LIFETIMES): sign in again after it. */
export const VSCODE_TOKEN_LIFETIME = '30d';
/** The longest client name kept (one line, plain text). */
export const VSCODE_CLIENT_NAME_MAX = 40;

/**
 * User codes: 8 letters from an alphabet without vowels or look-alikes (RFC 8628 §6.1 suggests one: no words, nothing to confuse), shown
 * as `BCDF-GHJK`. 20^8 is about 2.6e10 codes for at most a few live ones, and only a signed-in person can try one.
 */
export const VSCODE_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const formatUserCode = (raw: string): string => `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
/** What a person typed, as the code it may be: upper case, without spaces or dashes; null when it can't be one. */
export function normalizeUserCode(typed: string): string | null {
  const s = typed.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== 8) return null;
  for (const ch of s) if (!VSCODE_USER_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/* ---------- Public ---------- */

export interface VscodeVersion {
  /** The API version this portal speaks. */
  api: number;
  /** The oldest extension API it still serves. */
  minApi: number;
  /** The portal's name for itself, for the extension's messages. */
  name: string;
}

export interface VscodeDeviceStartRequest {
  /** What to call this client in the portal (the machine or window name), one line; the token's label is built from it. */
  client?: string;
}

/** RFC 8628 §3.2, in the portal's casing. `deviceCode` is the client's secret for polling: never shown, never logged. */
export interface VscodeDeviceStart {
  deviceCode: string;
  /** `BCDF-GHJK`: the person types or checks it in the portal. */
  userCode: string;
  /** The portal page to open. */
  verifyUrl: string;
  /** The same page with the code filled in (the person still approves it there). */
  verifyUrlComplete: string;
  expiresIn: number;
  interval: number;
}

export interface VscodeTokenRequest {
  deviceCode: string;
}

/** A poll's answer. `ok` comes exactly once: the token exists nowhere else and the code is gone after it. */
export type VscodeTokenPoll =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'ok'; token: string; tokenId: string; expiresAt: string; label: string };

/* ---------- The signed-in person's ---------- */

/** What a code asks for, as the approval page shows it. */
export interface VscodePending {
  userCode: string;
  client: string;
  /** The address the client started from, as the portal saw it. */
  ip: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface VscodeApproveRequest {
  userCode: string;
  decision: 'approve' | 'deny';
}

/* ---------- Bearer ---------- */

export interface VscodeMe {
  tokenId: string;
  label: string;
  scope: 'read' | 'operate' | 'admin';
  expiresAt: string;
  api: number;
}

export type VscodeSessionState = 'starting' | 'idle' | 'working' | 'waiting' | 'interrupted' | 'ended';

/** One agent (a chat session) as the Agents tree shows it. Title text was written by an agent: untrusted, shown as plain text. */
export interface VscodeAgent {
  id: string;
  title: string;
  state: VscodeSessionState;
  /** Open requests waiting for an answer. */
  waiting: number;
  workspaceId: string;
  parentId: string | null;
  /** Marked a crew lead by whoever started it. */
  lead: boolean;
  /** `T-12`, and its bucket key (`KONF-12`) when the portal has one. */
  ticketId: string | null;
  ticketKey: string | null;
  model: string | null;
  claudeName: string | null;
  /** The role it runs as (`implementer`), or null. */
  agent: string | null;
  /** What it cost so far in USD (list price), and how that is known (see sessionCost). */
  costUsd: number;
  costBasis: 'reported' | 'estimate' | 'unavailable';
  lastActivityAt: string;
  /** Its page in the portal. */
  url: string;
}

export interface VscodeTicket {
  id: string;
  key: string;
  bucket: string;
  status: 'open' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'wont_do';
  priority: 'urgent' | 'high' | 'normal' | 'low';
  type: string;
  summary: string;
  assigneeSessionId: string | null;
  updatedAt: string;
  url: string;
}

export interface VscodeWorkspace {
  id: string;
  name: string;
  target: string;
  status: string;
  url: string;
}

/** The status bar: the active Claude's tightest window and what waits on the person. */
export interface VscodeStatus {
  quota: {
    claudeId: string;
    claudeName: string;
    /** The window shown ("Session", "Week"). */
    label: string;
    /** Percent used, or null: the portal has no number (shown as unavailable, never as 0). */
    usedPct: number | null;
    resetsAt: string | null;
  } | null;
  /** Every Claude's windows, for the tooltip. */
  claudes: { claudeId: string; claudeName: string; windows: { label: string; usedPct: number | null; resetsAt: string | null }[] }[];
  /** What waits on a person (approvals, tickets, CI, deploys), the same count as the portal's badge; null when it could not be read. */
  attention: number | null;
  approvals: number;
  at: string;
}

/** One open approval, with the WHOLE text that is approved on (the same `full` the web's card shows). */
export interface VscodeApproval {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  requestId: string;
  kind: string;
  toolName: string | null;
  title: string;
  /** Exactly what is allowed, up to the portal's cap; null when the portal has nothing to show. */
  full: string | null;
  /** More was asked than can be shown: deny only. */
  fullCut: boolean;
  /** Whether Allow may be offered at all (requestReview): false for a cut or empty request. */
  allowable: boolean;
  /** Why not, in a few words. */
  note: string | null;
  /** SHA-256 (hex) of `full` as sent: an Allow must echo it, so what is allowed is what was shown. */
  fullSha256: string | null;
  createdAt: string;
  url: string;
}

export interface VscodeRespondRequest {
  requestId: string;
  decision: 'allow' | 'deny';
  /** Required for allow: the `fullSha256` of the approval the person saw. */
  fullSha256?: string;
  note?: string;
}

export interface VscodeSendRequest {
  text: string;
  /** A client id for the message (8 to 64 of `A-Za-z0-9-`), so a retry is not sent twice. */
  uuid?: string;
}

/** One transcript line for the Chat view. Text from the agent and the workspace: untrusted, rendered as plain text only. */
export interface VscodeEvent {
  seq: number;
  at: string;
  kind: 'user' | 'assistant' | 'tool_use' | 'request' | 'resolved' | 'error' | 'result';
  text: string | null;
  toolName: string | null;
  requestId: string | null;
}

export interface VscodeEvents {
  events: VscodeEvent[];
  /** The last sequence number the portal has: poll with `after=` this. */
  lastSeq: number;
  state: VscodeSessionState;
  title: string;
}

/** The most of a message the extension may send (the web's composer has the same cap on the delegate door). */
export const VSCODE_SEND_MAX = 50_000;
/** The most transcript events one call returns. */
export const VSCODE_EVENTS_MAX = 200;
