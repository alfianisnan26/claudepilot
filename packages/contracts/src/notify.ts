// Notifications (docs/prd/web-app-pwa.md section 11, docs/prd/platform-roadmap.md): one in-process event bus, a delivery pipeline with
// destinations (Web Push devices, a generic webhook, Discord, Slack), per-destination preferences and quiet hours, an in-app history, and
// answers (Deny, and Allow where the policy says so) that come back from a notification.
//
// MULTI-USER (PLAN-10): notification state belongs to a USER, and a device (a push destination) is under a user. Every per-person row
// carries `user_id TEXT NOT NULL DEFAULT 'u_owner'` (`u_owner` is the id the single-owner install uses, and the id existing data migrates
// to); the wire types below show `userId` where a client needs it. Events are routed to the OWNER of what they are about, resolved by the
// server from the subject (`NotifyEvent.audience` when an adapter already knows it). VAPID keys, the base URL, the contact and the
// ceiling on answers are platform-wide (admin). Today there is one user, so nothing changes for the person who runs the portal.
//
// Rules this file encodes (the PRD says why):
// - NO SECRET leaves the server in a response: a webhook URL, a push endpoint and its keys, a signing secret are sealed at rest. A
//   destination shows a `hint` (a host) and `signed`, never the value. A signing secret is shown once, when it is made.
// - Notification TEXT is a fixed template over names and categories (workspace, Claude, ticket number, tool class, numbers with their
//   basis). It never carries a prompt, a reply, a command, a path, a URL, error text, a secret name or a session title, unless a
//   destination opted in to `includeDetail`, and then the detail is clipped, redacted and UNTRUSTED.
// - An answer from a notification is authenticated twice (the signed-in session AND a single-use token that only travelled inside the
//   encrypted push payload of that device), bound to one request, one device and the decisions offered, and is re-checked against the
//   policy at the moment it arrives (section 11.7 of the PWA PRD).

/* ---------- Events ---------- */

/**
 * What can be notified. `phase: 1` kinds are built by the platform track; the rest are the PWA PRD's earlier kinds, kept so the
 * list stays one list, and are not emitted yet.
 */
export const NOTIFY_KINDS = [
  'approval', // a session waits for an answer to a tool request
  'human_request', // a ticket was assigned to a person by an agent, a trigger or the portal
  'session_failed', // a turn or the session failed
  'session_done', // a session finished (opt-in per session, or by length)
  'ci_failed', // a CI run failed
  'ci_waiting', // a deployment job waits for a person's approval (CI FR41)
  'quota_low', // a Claude's plan window is nearly used, or projected to run out before it resets
  'cost_spike', // a spend spike or a budget threshold (Usage)
  'trigger_approval', // a trigger run waits for approval
  'trigger_failed', // a trigger run failed, or a limit stopped it
  'auto_move', // a chat was moved to another Claude, or a move is suggested, because a quota is low
  'keepgoing_attention', // Keep going (T-259) found what it may not repair: an approval waits, out of Bypass, ended, down
  'attention', // a new item waits for a person on Needs you (T-146) that no other kind announces (an MCP or skill version)
  'test', // the Send test button
  // Later (PWA PRD 11.1); not emitted by the platform track.
  'workspace',
  'account',
  'portal',
  'security',
  'expiring',
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export type NotifySeverity = 'info' | 'attention' | 'urgent';

export interface NotifyKindInfo {
  kind: NotifyKind;
  /** One or two words (text diet). */
  label: string;
  severity: NotifySeverity;
  /** On for a new device, and for a new channel, until the person changes it. */
  defaultOn: boolean;
  /** Breaks through quiet hours by default (the person can change it per destination). */
  breakthrough: boolean;
  /** `1` is built by the platform track; `later` is the PWA PRD's, not emitted yet. */
  phase: 1 | 'later';
  /** Web Push urgency (RFC 8030): `high` wakes a sleeping phone, so only what needs a person soon. */
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  /** How long a push service may hold it for an offline device, in seconds. */
  ttlSeconds: number;
}

/** The kinds, with the defaults (PWA PRD 11.1). Edited here, read by the server (delivery rules) and the web (the matrix). */
export const NOTIFY_KIND_INFO: Record<NotifyKind, NotifyKindInfo> = {
  approval: { kind: 'approval', label: 'Approval', severity: 'urgent', defaultOn: true, breakthrough: false, phase: 1, urgency: 'high', ttlSeconds: 3600 },
  human_request: { kind: 'human_request', label: 'Request', severity: 'attention', defaultOn: true, breakthrough: false, phase: 1, urgency: 'normal', ttlSeconds: 6 * 3600 },
  session_failed: { kind: 'session_failed', label: 'Failed', severity: 'attention', defaultOn: true, breakthrough: false, phase: 1, urgency: 'normal', ttlSeconds: 6 * 3600 },
  session_done: { kind: 'session_done', label: 'Done', severity: 'info', defaultOn: false, breakthrough: false, phase: 1, urgency: 'low', ttlSeconds: 3600 },
  ci_failed: { kind: 'ci_failed', label: 'CI failed', severity: 'attention', defaultOn: true, breakthrough: false, phase: 1, urgency: 'normal', ttlSeconds: 6 * 3600 },
  ci_waiting: { kind: 'ci_waiting', label: 'Deploy waits', severity: 'attention', defaultOn: true, breakthrough: false, phase: 1, urgency: 'high', ttlSeconds: 6 * 3600 },
  quota_low: { kind: 'quota_low', label: 'Quota', severity: 'attention', defaultOn: true, breakthrough: false, phase: 1, urgency: 'normal', ttlSeconds: 6 * 3600 },
  cost_spike: { kind: 'cost_spike', label: 'Cost', severity: 'urgent', defaultOn: true, breakthrough: true, phase: 1, urgency: 'high', ttlSeconds: 6 * 3600 },
  trigger_approval: { kind: 'trigger_approval', label: 'Trigger run', severity: 'attention', defaultOn: true, breakthrough: false, phase: 1, urgency: 'normal', ttlSeconds: 6 * 3600 },
  trigger_failed: { kind: 'trigger_failed', label: 'Trigger', severity: 'attention', defaultOn: true, breakthrough: false, phase: 1, urgency: 'normal', ttlSeconds: 6 * 3600 },
  auto_move: { kind: 'auto_move', label: 'Moved', severity: 'info', defaultOn: true, breakthrough: false, phase: 1, urgency: 'normal', ttlSeconds: 6 * 3600 },
  attention: { kind: 'attention', label: 'Needs you', severity: 'attention', defaultOn: true, breakthrough: false, phase: 1, urgency: 'normal', ttlSeconds: 6 * 3600 },
  keepgoing_attention: { kind: 'keepgoing_attention', label: 'Keep going', severity: 'attention', defaultOn: true, breakthrough: false, phase: 1, urgency: 'high', ttlSeconds: 6 * 3600 },
  test: { kind: 'test', label: 'Test', severity: 'info', defaultOn: true, breakthrough: true, phase: 1, urgency: 'normal', ttlSeconds: 60 },
  workspace: { kind: 'workspace', label: 'Workspace', severity: 'attention', defaultOn: true, breakthrough: false, phase: 'later', urgency: 'normal', ttlSeconds: 6 * 3600 },
  account: { kind: 'account', label: 'Account', severity: 'attention', defaultOn: true, breakthrough: false, phase: 'later', urgency: 'normal', ttlSeconds: 6 * 3600 },
  portal: { kind: 'portal', label: 'Portal', severity: 'urgent', defaultOn: true, breakthrough: true, phase: 'later', urgency: 'high', ttlSeconds: 24 * 3600 },
  security: { kind: 'security', label: 'Security', severity: 'urgent', defaultOn: true, breakthrough: true, phase: 'later', urgency: 'high', ttlSeconds: 24 * 3600 },
  expiring: { kind: 'expiring', label: 'Expiring', severity: 'info', defaultOn: false, breakthrough: false, phase: 'later', urgency: 'low', ttlSeconds: 24 * 3600 },
};

/** The kinds the platform track emits, in the order the matrix lists them. */
export const NOTIFY_PHASE1_KINDS: readonly NotifyKind[] = NOTIFY_KINDS.filter((k) => NOTIFY_KIND_INFO[k].phase === 1 && k !== 'test');

/** What an event is about: for collapsing (one notification per tag), for the deep link and for the history row. */
export interface NotifySubject {
  type: 'session' | 'ticket' | 'ci_run' | 'claude' | 'workspace' | 'trigger' | 'trigger_run' | 'budget' | 'portal';
  id: string;
  workspaceId?: string | null;
}

/** The tool classes an action policy talks about (section 11.7). `other` is never answered from a notification (only Deny). */
export type NotifyToolClass = 'read' | 'edit' | 'command' | 'other';

/** The portal's own tool classes: Claude Code's tool names. Anything not listed is `other` (an MCP tool, a sub-agent, a question, a plan). */
export const NOTIFY_TOOL_CLASS: Record<string, NotifyToolClass> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  LS: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'command',
};
export const notifyToolClass = (toolName: string | null | undefined): NotifyToolClass => (toolName && Object.hasOwn(NOTIFY_TOOL_CLASS, toolName) ? NOTIFY_TOOL_CLASS[toolName]! : 'other');

/**
 * One thing that happened, on the in-process bus. Built by an adapter over an existing seam (the chat controller's events, a CI hook,
 * the usage alert sinks, the tickets hook) and consumed by the delivery pipeline and, for `ci_failed` and the like, by triggers.
 * `facts` are enums, names and numbers (a number that is an estimate says so in `basis`); free text from an agent, a workspace or a
 * webhook never goes in `facts`: it goes in `detail`, and only reaches a destination that asked for it.
 */
export interface NotifyEvent {
  /** `evt_` + 16 hex. */
  id: string;
  kind: NotifyKind;
  at: string;
  subject: NotifySubject;
  facts: Record<string, string | number | boolean | null>;
  /** Which facts are estimates (`est.` in the text); the others are measured or plain names. */
  estimates?: string[];
  /** UNTRUSTED text, clipped (at most 160 characters for a push, 600 for a channel) and redacted. Delivered only where `includeDetail` is on. */
  detail?: { text: string; truncated: boolean };
  /** What an answer would need; set only for an `approval` that can be answered from a notification. Never sent to a client as is. */
  answer?: NotifyAnswerOffer;
  /**
   * The user ids that should hear of it, when the adapter already knows them (a trigger run: its owner). Absent: the pipeline asks the
   * owner resolver for the subject (a session: its creator; a ticket: its assignee, else its creator; a CI run: the linked session's
   * owner, else the ticket's, else the workspace's; a Claude: its workspace's owners and the owners of sessions running on it;
   * the platform: the admins). Every recipient is checked with `can(user, 'view', subject)` again at delivery.
   */
  audience?: string[];
}

/** The decisions a notification may carry for one tool request, decided by the policy at the time the event is made. */
export interface NotifyAnswerOffer {
  sessionId: string;
  requestId: string;
  toolClass: NotifyToolClass;
  /** `deny` is always possible for a tool request; `allow` only when the policy allows this class and the whole request is shown. */
  decisions: NotifyDecision[];
}

export type NotifyDecision = 'allow' | 'deny';

/* ---------- Destinations ---------- */

/** A Web Push device, a generic signed webhook, a Discord incoming webhook, a Slack incoming webhook. */
export type DestinationType = 'push' | 'webhook' | 'discord' | 'slack';
export const DESTINATION_TYPES: readonly DestinationType[] = ['push', 'webhook', 'discord', 'slack'];

/** Fixed codes for why a delivery did not work. No provider text, no URL, no key. */
export const NOTIFY_ERRORS = [
  'invalid_url',
  'blocked_address', // the name resolved to a private, loopback, link-local or metadata address
  'dns',
  'connect',
  'tls',
  'timeout',
  'redirect', // a 3xx: never followed
  'http_4xx',
  'http_5xx',
  'rate_limited', // the destination said 429
  'gone', // a push service said 404 or 410: the subscription is over
  'bad_subscription', // the endpoint or keys were refused
  'vapid_rejected', // 401 or 403 from a push service
  'payload_too_large',
  'locked', // the portal is Locked or Frozen: sealed material cannot be opened
  'no_key', // no push key could be made yet
] as const;
export type NotifyError = (typeof NOTIFY_ERRORS)[number];

/** Why a delivery was not attempted. */
export const NOTIFY_SUPPRESSIONS = ['kind_off', 'quiet_hours', 'active_device', 'throttled', 'collapsed', 'disabled', 'resolved', 'muted'] as const;
export type NotifySuppression = (typeof NOTIFY_SUPPRESSIONS)[number];

/** Quiet hours of one destination, in the IANA zone stored with it. The window may cross midnight. Off by default (PWA PRD Q4). */
export interface QuietHours {
  enabled: boolean;
  /** `HH:MM`, 24 hours. */
  start: string;
  end: string;
  /** An IANA time zone name, for example `Asia/Jakarta`. */
  tz: string;
  /** Kinds that are delivered anyway. Whatever was held is summarised once when the window ends. */
  breakthrough: NotifyKind[];
}

export const QUIET_DEFAULT: Omit<QuietHours, 'tz' | 'breakthrough'> = { enabled: false, start: '22:00', end: '07:00' };

export interface NotifyDestination {
  /** `dst_` + 12 hex. */
  id: string;
  /** The user it belongs to. A push destination is a device under that user. */
  userId: string;
  type: DestinationType;
  /** The person's name for it ("Pixel 8 · Chrome", "Ops channel"). */
  name: string;
  enabled: boolean;
  /** Safe to show: the host a delivery goes to (`fcm.googleapis.com`, `discord.com`). Never a path, query or key. Null when sealed material cannot be read. */
  hint: string | null;
  kinds: NotifyKind[];
  quiet: QuietHours;
  /**
   * Also hear of things the user may operate but does not own (a session shared to them). Off: only what they own. Never includes
   * another user's private session: `can(user, 'view', subject)` decides at delivery.
   */
  includeShared: boolean;
  /** Put the clipped, redacted request detail in the text. Needed for Allow from a notification. Off by default; the text says it is untrusted. */
  includeDetail: boolean;
  /** Webhook only: an explicit tick that lets the portal call a private address (metadata addresses stay refused). */
  allowPrivateNetwork: boolean;
  /** Webhook only: each delivery carries an HMAC signature. The secret is shown once, at creation or rotation. */
  signed: boolean;
  /** `failing` after 3 failures in a row (one try every hour until one works); `disabled` after 20, or when a push service said the subscription is gone. */
  state: 'ok' | 'failing' | 'disabled';
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: NotifyError | null;
  failures: number;
  /** Push only: the push service host is not one this version knows (a warning, never a refusal). */
  unrecognisedService: boolean;
  createdAt: string;
}

/** `GET NOTIFY_API.overview`. */
export interface NotifyOverview {
  /** `locked` and `frozen`: sealed material cannot be opened, so nothing is delivered (the PWA PRD 11.4 says why). `readonly`: the database cannot be written. */
  state: 'ready' | 'locked' | 'frozen' | 'readonly';
  /** The VAPID public key (uncompressed P-256 point, base64url) a browser needs to subscribe; null until the first key is made. */
  vapidPublicKey: string | null;
  /** Where deep links in channel messages point (`PORTAL_UI_URL`); null: messages carry no link. */
  baseUrl: string | null;
  /** The caller's destinations only. */
  destinations: NotifyDestination[];
  /** The caller's own answer switches (`NotifyUserPrefs`), already limited by the platform ceiling: what is in force for them. */
  policy: NotifyActionPolicy;
  /** The platform ceiling (an admin's setting `notify.actions.enabled`): off means nobody may answer from a notification, whatever their own switches say. */
  actionsCeiling: boolean;
  /** Items in the history not read yet. */
  unread: number;
}

/** What may be answered from a notification: a user's own switches (`notify_user_prefs`), every `allow*` off until that person turns it on. */
export interface NotifyActionPolicy {
  /** Offer Deny on a tool request. Default on. */
  deny: boolean;
  allowRead: boolean;
  allowEdit: boolean;
  allowCommand: boolean;
}

/** `GET`/`PUT NOTIFY_API.prefs`: the caller's answer switches. Turning an `allow*` on needs `confirm: true` (409 `CONFIRMATION_REQUIRED` without it). */
export interface NotifyUserPrefs extends NotifyActionPolicy {
  confirm?: boolean;
}

/** Platform-wide settings an admin owns (`defineSetting`, group `notify`). The per-person switches live in `notify_user_prefs`, not here. */
export const NOTIFY_SETTING_KEYS = {
  /** The ceiling on answering from a notification, for everyone. On by default; the emergency action turns it off. */
  actions: 'notify.actions.enabled',
  /** Where a link in a channel message points; empty: `PORTAL_UI_URL`. */
  baseUrl: 'notify.baseUrl',
  /** The VAPID `sub` claim (mailto: or https:); empty: derived. */
  contact: 'notify.contact',
} as const;

/* ---------- Requests ---------- */

/** What a browser's `PushSubscription.toJSON()` holds. Validated by the server (https endpoint on a public address, 65-byte P-256 key, 16-byte auth secret). */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

/** `POST NOTIFY_API.push`: register this browser. Registering the same endpoint again updates it. */
export interface RegisterPushRequest {
  subscription: PushSubscriptionInput;
  name?: string;
  /** The browser's IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). */
  tz: string;
}

/** `POST NOTIFY_API.destinations`: a webhook, Discord or Slack channel. The URL is a secret: sealed, and never returned. */
export interface CreateChannelRequest {
  type: Exclude<DestinationType, 'push'>;
  name: string;
  url: string;
  kinds?: NotifyKind[];
  includeDetail?: boolean;
  includeShared?: boolean;
  /** Webhook only. */
  allowPrivateNetwork?: boolean;
  /** Webhook only: make a signing secret (returned once in the result). */
  signed?: boolean;
}

export interface CreatedChannel {
  destination: NotifyDestination;
  /** The signing secret, once. `null` when the channel is not signed. */
  signingSecret: string | null;
}

/** `PATCH NOTIFY_API.destination(id)`: whatever is present changes. The URL cannot be edited: make a new channel. */
export interface UpdateDestinationRequest {
  name?: string;
  enabled?: boolean;
  kinds?: NotifyKind[];
  quiet?: QuietHours;
  includeDetail?: boolean;
  includeShared?: boolean;
  allowPrivateNetwork?: boolean;
  tz?: string;
}

/** The result of a test notification: a delivery that went through the normal pipeline except quiet hours and presence. */
export interface TestResult {
  ok: boolean;
  error: NotifyError | null;
}

/** One delivery attempt's record (`GET NOTIFY_API.log`). Kept 30 days. */
export interface NotifyDelivery {
  id: number;
  at: string;
  eventId: string;
  kind: NotifyKind;
  destinationId: string;
  status: 'sent' | 'failed' | 'suppressed' | 'held';
  code: NotifyError | NotifySuppression | null;
  attempts: number;
  httpStatus: number | null;
}

/** One row of the in-app history (`GET NOTIFY_API.history`). Kept 30 days. The text is what a destination without detail would have got. */
export interface NotifyHistoryItem {
  id: string;
  kind: NotifyKind;
  at: string;
  title: string;
  /** The text with any clock time in UTC, said as such ("resets 19:40 UTC"): for a reader that cannot show the reader's own zone. */
  body: string;
  /**
   * T-126: the same text with its clock times as marks (`timeMark`), present only when it has any. The web shows each in the device's
   * own zone with `zonedTime` (`fillTimeMarks`), the same formatter as the Quota sheet.
   */
  bodyMarked?: string;
  /** A portal path (`/admin/sessions/s_41?request=r_7`), never an absolute URL. */
  path: string | null;
  subject: NotifySubject;
  readAt: string | null;
  /** The thing it was about is dealt with (a request answered, a run passed): the row is shown dimmed. */
  resolvedAt: string | null;
  resolution: string | null;
  /** A mute rule hushed it: stored, never buzzed, toasted or pushed; left out of the list unless `?muted=1`, and never unread. */
  muted: boolean;
}

export interface NotifyHistoryPage {
  items: NotifyHistoryItem[];
  /** The `at` to pass as `before` for the next page; null at the end. */
  next: string | null;
  unread: number;
}

/** `PUT NOTIFY_API.session(id)`: "Notify when done" for one session (the session menu). */
export interface SessionNotifyRequest {
  done: boolean;
}

/* ---------- Mute rules ("Mute similar") ---------- */

/**
 * What a rule narrows to, besides the kind: the event's subject, or a name from its facts (a CI run's repository, pipeline or
 * environment). Built by the server from the event (`notify/mutes.ts`, narrowest first), so a rule never matches on free text.
 */
export const MUTE_SCOPE_TYPES = ['session', 'ticket', 'ci_run', 'claude', 'trigger', 'trigger_run', 'budget', 'environment', 'pipeline', 'repo', 'workspace'] as const;
export type MuteScopeType = (typeof MUTE_SCOPE_TYPES)[number];

export interface MuteScope {
  type: MuteScopeType;
  /** The subject id, or `repo`, `repo/pipeline`, `repo/environment` for a CI run's names. */
  id: string;
  /** Short words for the rule list ("claudepilot · deploy", "T-25"); names and ids only. */
  label: string;
}

/**
 * Never hushed by "Mute similar": an approval blocks a session until somebody answers, and a deploy waits for a person. A rule for
 * one of these is made only in Settings, with `confirm: true`, and the pipeline also ignores any such rule made without it.
 */
export const MUTE_GUARDED_KINDS: readonly NotifyKind[] = ['approval', 'ci_waiting'];
export const isMuteGuarded = (kind: NotifyKind): boolean => MUTE_GUARDED_KINDS.includes(kind);

export const MUTE_DURATIONS = ['1h', '1d', 'forever'] as const;
export type MuteDuration = (typeof MUTE_DURATIONS)[number];
export const MUTE_DURATION_MS: Record<MuteDuration, number | null> = { '1h': 3600_000, '1d': 86_400_000, forever: null };
/** At most this many rules per person. */
export const MUTE_RULES_MAX = 100;

/** One rule of the caller's. Expired rules are not listed (and are swept). */
export interface NotifyMute {
  /** `mut_` + 12 hex. */
  id: string;
  kind: NotifyKind;
  /** Null: every event of the kind. */
  scope: MuteScope | null;
  /** Null: all of the person's devices and channels (the history row is marked muted); else only that one destination is hushed. */
  destinationId: string | null;
  createdAt: string;
  /** Null: until removed. */
  expiresAt: string | null;
  /** How many events it hushed. */
  hushed: number;
  lastHushedAt: string | null;
}

/**
 * `POST NOTIFY_API.mutes`. From a notification: `from` (an Inbox item or event id), `wide` for "all of this kind"; the server reads the
 * kind and the scope from the stored item, and refuses a guarded kind. By hand (Settings): `kind`, optional `scope` (type and id); a
 * guarded kind needs `confirm: true` (409 `CONFIRMATION_REQUIRED` without it).
 */
export interface CreateMuteRequest {
  from?: string;
  wide?: boolean;
  kind?: NotifyKind;
  scope?: { type: MuteScopeType; id: string } | null;
  destinationId?: string | null;
  duration: MuteDuration;
  confirm?: boolean;
}

/** `GET NOTIFY_API.muteOffer(ref)`: what "Mute similar" would make for that item. */
export interface MuteOffer {
  ref: string;
  kind: NotifyKind;
  /** The narrowest sensible scope; null when the event has none (then the only choice is all of the kind). */
  scope: MuteScope | null;
  /** Approvals and deploy waits: not muted from a notification (Settings only). */
  guarded: boolean;
}

/* ---------- Answering from a notification ---------- */

/** `POST NOTIFY_API.act`. The signed-in session is required as well as the token. */
export interface NotifyActRequest {
  token: string;
  decision: NotifyDecision;
}

export interface NotifyActResult {
  ok: true;
  sessionId: string;
  /** What the controller recorded: `allowed_once` or `denied`. */
  outcome: 'allowed_once' | 'denied';
}

/** In `details.reason` of a refusal, so the worker can say it in one line. The status is 403 (not allowed), 409 (used, closed), 410 (expired), 429. */
export const NOTIFY_REFUSALS = ['expired', 'used', 'closed', 'not_allowed', 'disabled', 'device_removed', 'rate_limited', 'locked', 'unknown'] as const;
export type NotifyRefusal = (typeof NOTIFY_REFUSALS)[number];

/** Prefix of an action token. The redactor knows it. */
export const ACTION_TOKEN_PREFIX = 'cpna_';
/** How long an action token lives, at most, and the cap on tokens waiting at once. */
export const ACTION_TOKEN_TTL_S = 600;
export const ACTION_TOKENS_MAX = 200;

/* ---------- The push payload (Declarative Web Push shape, section 11.3) ---------- */

export interface PushData {
  v: 1;
  /** The event id, for the history and for "resolved elsewhere". */
  id: string;
  kind: NotifyKind;
  /** The deep link, a portal path. The worker opens only `/admin/` paths of its own origin. */
  path: string;
  /** Present only when an answer can be given from this notification: the single-use token `t`, the decisions it carries `d`, and when it expires `exp` (Unix seconds). */
  act?: { t: string; d: NotifyDecision[]; exp: number };
}

export interface PushNotification {
  title: string;
  body: string;
  /** Absolute URL of the deep link (the declarative form needs one). */
  navigate: string;
  tag: string;
  renotify?: boolean;
  silent: false;
  /** The attention count where the platform has app badges; a string of digits. */
  app_badge?: string;
  /** Declarative form: every action is a navigation. The worker turns `allow` and `deny` into buttons that call the portal. */
  actions?: { action: string; title: string; navigate: string }[];
  data: PushData;
}

export interface PushPayload {
  web_push: 8030;
  mutable: true;
  notification: PushNotification;
}

/* ---------- Presence (on the live socket) ---------- */

/**
 * Browser to portal on `/api/live`, next to `subscribe` (PWA PRD A5): this tab is visible and in use, or is not. While a device is
 * visible and was used in the last two minutes it gets toasts and history entries instead of pushes. Nothing here is a secret.
 */
export interface LivePresence {
  type: 'presence';
  /** The destination id of this browser's push registration, when it has one. */
  device: string | null;
  visible: boolean;
  /** Input within the last two minutes. */
  active: boolean;
  /** The session this tab shows, when it shows one: no notification for what is already on screen. */
  session: string | null;
}

/* ---------- The platform audit (every automatic action leaves a row) ---------- */

export interface PlatformAuditEntry {
  id: number;
  at: string;
  severity: 'info' | 'medium' | 'high';
  /** `notify.action`, `notify.channel`, `trigger.fired`, `trigger.refused`, `autotransfer.moved`, `safety.emergency`, ... */
  kind: string;
  /** Who: `ui` (a person; `user:<id>` once there are several), `device:<destination id>`, `trigger:<id>`, `portal:autotransfer`, `portal`. */
  actor: string;
  /** The person it was done by, or for (a trigger's owner, a session's owner); null for the system. A user reads their own rows; an admin reads all. */
  userId: string | null;
  /** What it concerned: a session, a ticket, a trigger run. */
  subject: string | null;
  /** Names, ids and numbers only: never a secret, a URL or message text. */
  detail: Record<string, unknown>;
}

export const NOTIFY_API = {
  /** GET: `NotifyOverview`. */
  overview: '/api/notify',
  /** POST `RegisterPushRequest`: `NotifyDestination` (type `push`). */
  push: '/api/notify/push',
  /** GET: `NotifyDestination[]`. POST `CreateChannelRequest`: `CreatedChannel`. */
  destinations: '/api/notify/destinations',
  /** PATCH `UpdateDestinationRequest`: `NotifyDestination`. DELETE: remove it (its pending tokens die with it). */
  destination: (id: string) => `/api/notify/destinations/${encodeURIComponent(id)}`,
  /** POST: send a test; `TestResult`. */
  test: (id: string) => `/api/notify/destinations/${encodeURIComponent(id)}/test`,
  /** POST (after a re-check of the server code): a new signing secret, `{ signingSecret }`, shown once. */
  rotateSecret: (id: string) => `/api/notify/destinations/${encodeURIComponent(id)}/secret`,
  /** GET `?destination=&limit=`: `NotifyDelivery[]`. */
  log: '/api/notify/log',
  /** GET `?before=&limit=`: `NotifyHistoryPage`. DELETE: clear it. */
  history: '/api/notify/history',
  /** POST `{ upTo?: string }`: mark read (all when omitted); `{ unread }`. */
  read: '/api/notify/history/read',
  /** PUT `SessionNotifyRequest`. */
  session: (sessionId: string) => `/api/notify/sessions/${encodeURIComponent(sessionId)}`,
  /** GET: `NotifyUserPrefs` (the caller's). PUT `NotifyUserPrefs`: the same. */
  prefs: '/api/notify/prefs',
  /** POST `NotifyActRequest`: `NotifyActResult`. */
  act: '/api/notify/act',
  /** GET: `NotifyMute[]` (the caller's live rules). POST `CreateMuteRequest`: `NotifyMute`. DELETE: Unmute all, `{ removed }`. */
  mutes: '/api/notify/mutes',
  /** DELETE: remove one rule. */
  mute: (id: string) => `/api/notify/mutes/${encodeURIComponent(id)}`,
  /** GET: `MuteOffer` for an Inbox item (`nh_…`) or an event of the caller (`evt_…`, from a push's Mute action). */
  muteOffer: (ref: string) => `/api/notify/mutes/offer/${encodeURIComponent(ref)}`,
  /** GET `?kind=&limit=&before=`: `PlatformAuditEntry[]` (every platform module writes here): the caller's own rows, all rows for an admin. */
  audit: '/api/platform/audit',
} as const;

/* ---------- Deep links ---------- */

/** The portal path an event opens. Relative, so a worker and a channel message can add their own origin. */
export const notifyPath = {
  session: (id: string, requestId?: string | null) => `/admin/sessions/${encodeURIComponent(id)}${requestId ? `?request=${encodeURIComponent(requestId)}` : ''}`,
  ticket: (id: string) => `/admin/tickets/${encodeURIComponent(id)}`,
  ciRun: (id: string) => `/admin/ci/runs/${encodeURIComponent(id)}`,
  usage: (claudeId?: string | null) => `/admin/usage${claudeId ? `?claude=${encodeURIComponent(claudeId)}` : ''}`,
  trigger: (id: string, runId?: string | null) => `/admin/triggers/${encodeURIComponent(id)}${runId ? `?run=${encodeURIComponent(runId)}` : ''}`,
  notifications: '/admin/notifications',
} as const;

/**
 * A path a push or a channel may open: `/admin/` plus path characters and a query, no `//`, no backslash, no control character, no
 * scheme. The worker applies the same rule on its own (it is plain JavaScript and cannot import this).
 */
export const PORTAL_PATH = /^\/admin\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/;
export const isPortalPath = (p: unknown): p is string => typeof p === 'string' && p.length <= 400 && PORTAL_PATH.test(p) && !p.includes('//') && !p.includes('..');
