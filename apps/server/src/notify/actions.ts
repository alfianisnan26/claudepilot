// Answering from a notification (docs/prd/web-app-pwa.md §11.7, owner decision O1). Review always; Deny on a tool request; Allow only
// for a tool class the person switched on, only when the whole request is in the notification, never for a session started from outside.
// An answer needs the signed-in session AND a single-use token (32 random bytes, `cpna_`, stored only as its SHA-256) bound to the user,
// the destination, the event, the session, the request, the decisions offered, the tool class and what the request showed; the policy is
// checked again when the answer arrives, and one atomic UPDATE makes the token single-use.

import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { AppError } from '@isnanme/core';
import {
  ACTION_TOKEN_PREFIX,
  ACTION_TOKEN_TTL_S,
  ACTION_TOKENS_MAX,
  notifyToolClass,
  requestReview,
  type ChatRequest,
  type ChatSession,
  type NotifyActionPolicy,
  type NotifyActResult,
  type NotifyDecision,
  type NotifyRefusal,
  type NotifyToolClass,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { PlatformAudit } from '../platform/audit.js';
import type { PlatformOwner } from '../platform/owner.js';
import type { Destinations } from './destinations.js';

/** What a notification can show of a request in full: printable ASCII, at most this long (what a lock screen shows expanded). */
export const SHOWN_MAX = 100;
const PRINTABLE = /^[\x20-\x7e]+$/;
/** A command shown whole and plain: letters, digits, spaces and `._/=:@%+,-` (no shell operator, quote, glob or expansion). */
const PLAIN_COMMAND = /^[A-Za-z0-9 ._/=:@%+,-]+$/;
const PATH_TOOLS = new Set(['Read', 'LS', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** Never answered from a notification, not even Deny: a question needs typed words, a plan changes the mode. */
const NEVER = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** A path inside the session's folder after normalising, with no `..` and no segment starting with a dot (never `.ssh`, `.git`, `.claude`). */
export function pathInside(text: string, cwd: string): boolean {
  if (!cwd.startsWith('/') || text.includes('\\') || text.includes('~') || text.includes('\0')) return false;
  if (text.split('/').some((s) => s === '..')) return false;
  const root = posix.normalize(cwd).replace(/\/+$/, '');
  const abs = posix.normalize(text.startsWith('/') ? text : posix.join(root, text));
  if (!abs.startsWith(`${root}/`)) return false;
  return abs
    .slice(root.length + 1)
    .split('/')
    .every((s) => s.length > 0 && !s.startsWith('.'));
}

/** Whether the request is shown whole in a notification and qualifies for Allow in its class. */
export function shownWhole(r: Pick<ChatRequest, 'toolName' | 'full' | 'fullCut'>, cwd: string): boolean {
  if (!requestReview(r).allow) return false;
  const text = r.full ?? '';
  if (text.length > SHOWN_MAX || !PRINTABLE.test(text) || text.endsWith('…')) return false;
  const cls = notifyToolClass(r.toolName);
  if (cls === 'command') return PLAIN_COMMAND.test(text);
  if (cls === 'read' || cls === 'edit') return PATH_TOOLS.has(r.toolName ?? '') && pathInside(text, cwd);
  return false;
}

/** SHA-256 of what the request showed: the answer must find the same text still open. */
export const shownHash = (r: Pick<ChatRequest, 'toolName' | 'full'>) => createHash('sha256').update(`${r.toolName ?? ''}\n${r.full ?? ''}`).digest('hex');

const classSwitch = (p: NotifyActionPolicy, c: NotifyToolClass): boolean => (c === 'read' ? p.allowRead : c === 'edit' ? p.allowEdit : c === 'command' ? p.allowCommand : false);

/** The decisions a notification may carry for one request, worked out from the policy when the event is made. */
export function answerOffer(input: { request: ChatRequest; cwd: string; untrusted: boolean; policy: NotifyActionPolicy; ceiling: boolean }): { toolClass: NotifyToolClass; decisions: NotifyDecision[] } {
  const { request, policy } = input;
  const toolClass = notifyToolClass(request.toolName);
  if (!input.ceiling || request.kind !== 'tool' || NEVER.has(request.toolName ?? '')) return { toolClass, decisions: [] };
  const decisions: NotifyDecision[] = [];
  if (toolClass !== 'other' && !input.untrusted && classSwitch(policy, toolClass) && shownWhole(request, input.cwd)) decisions.push('allow');
  if (policy.deny) decisions.push('deny');
  return { toolClass, decisions };
}

/** The chat controller, as far as answers need it. */
export interface ActChat {
  get(id: string): ChatSession | null;
  openRequests(id: string): ChatRequest[];
  respond(id: string, requestId: string, decision: 'allow' | 'deny', opts: { note?: string; actor?: string }): Promise<void>;
}

export interface ActionDeps {
  store: Store;
  destinations: Destinations;
  owner: PlatformOwner;
  audit: PlatformAudit;
  chat: ActChat;
  ceiling: () => boolean;
  /** A session a webhook or CI trigger started (or whose parent chain leads to one): Review and Deny only. */
  untrusted: (sessionId: string) => boolean;
  /** The pipeline marks the history resolved and closes what waits on the request. */
  answered?: (sessionId: string, requestId: string, outcome: string) => void;
  now?: () => Date;
}

interface TokenRow {
  hash: string;
  owner_id: string;
  destination_id: string;
  event_id: string;
  session_id: string;
  request_id: string;
  decisions: string;
  tool_class: NotifyToolClass;
  tool_name: string | null;
  detail_hash: string | null;
  expires_at: string;
  used_at: string | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const TOKEN = /^cpna_[A-Za-z0-9_-]{43}$/;

/** A refusal: the status says which family; `details.reason` is the one word the worker turns into a line. */
export function refusal(reason: NotifyRefusal): AppError {
  const status = reason === 'used' || reason === 'closed' ? 409 : reason === 'expired' ? 410 : reason === 'rate_limited' ? 429 : reason === 'locked' ? 503 : 403;
  const code = status === 409 ? 'CONFLICT' : status === 429 ? 'RATE_LIMITED' : status === 503 ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN';
  return new AppError(code, 'Couldn’t answer from the notification. Open the request.', { status, details: { reason } });
}

export class NotifyActions {
  readonly #now: () => Date;
  /** Refusals per sign-in (5 in 10 minutes), answers per destination (20 an hour). */
  readonly #refusals = new Map<string, number[]>();
  readonly #answers = new Map<string, number[]>();

  constructor(private readonly deps: ActionDeps) {
    this.#now = deps.now ?? (() => new Date());
  }

  /** Makes one token for one destination and offer; null when nothing can be written. The token travels only inside the encrypted payload. */
  issue(input: { ownerId: string; destinationId: string; eventId: string; sessionId: string; requestId: string; decisions: NotifyDecision[]; toolClass: NotifyToolClass; request: Pick<ChatRequest, 'toolName' | 'full'> }): { token: string; exp: number } | null {
    const db = this.deps.store.writable ? this.deps.store.db : null;
    if (!db || !input.decisions.length) return null;
    const token = `${ACTION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const now = this.#now();
    const expires = new Date(now.getTime() + ACTION_TOKEN_TTL_S * 1000);
    db.prepare(
      `INSERT INTO notify_action_tokens (hash, owner_id, destination_id, event_id, session_id, request_id, decisions, tool_class, tool_name, detail_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sha(token), input.ownerId, input.destinationId, input.eventId, input.sessionId, input.requestId, input.decisions.join(','), input.toolClass, input.request.toolName ?? null, shownHash(input.request), now.toISOString(), expires.toISOString());
    // At most ACTION_TOKENS_MAX pending: the oldest go first.
    db.prepare(
      `DELETE FROM notify_action_tokens WHERE used_at IS NULL AND hash IN (
         SELECT hash FROM notify_action_tokens WHERE used_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
    ).run(ACTION_TOKENS_MAX);
    return { token, exp: Math.floor(expires.getTime() / 1000) };
  }

  pending(): number {
    return (this.deps.store.db?.prepare('SELECT COUNT(*) AS n FROM notify_action_tokens WHERE used_at IS NULL').get() as { n: number } | undefined)?.n ?? 0;
  }

  #limited(map: Map<string, number[]>, key: string, windowMs: number, max: number): boolean {
    const now = this.#now().getTime();
    const list = (map.get(key) ?? []).filter((t) => now - t < windowMs);
    map.set(key, list);
    return list.length >= max;
  }

  #count(map: Map<string, number[]>, key: string) {
    const list = map.get(key) ?? [];
    list.push(this.#now().getTime());
    map.set(key, list);
    if (map.size > 5000) map.delete(map.keys().next().value!);
  }

  /** `POST /api/notify/act`, after the session guard. `signIn` is the sign-in the request came with (its cookie), for the refusal limit. */
  async act(input: { userId: string; actor: string; signIn: string; token: unknown; decision: unknown }): Promise<NotifyActResult> {
    const signInKey = sha(input.signIn);
    const audit = (refused: NotifyRefusal | null, extra: Record<string, unknown> = {}, outcome?: string) =>
      this.deps.audit.record({
        kind: 'notify.action',
        severity: input.decision === 'allow' && !refused ? 'medium' : 'info',
        actor: input.actor,
        userId: input.userId,
        subject: typeof extra.session === 'string' ? `session:${extra.session}` : null,
        detail: { decision: input.decision === 'allow' || input.decision === 'deny' ? input.decision : 'invalid', ...extra, ...(refused ? { refused } : { outcome }) },
      });
    const refuse = (reason: NotifyRefusal, extra: Record<string, unknown> = {}): never => {
      if (reason !== 'rate_limited') this.#count(this.#refusals, signInKey);
      audit(reason, extra);
      throw refusal(reason);
    };

    if (this.#limited(this.#refusals, signInKey, 10 * 60_000, 5)) refuse('rate_limited');
    if (!this.deps.store.secrets || this.deps.store.trust.state !== 'ok') refuse('locked');
    const decision = input.decision;
    if (decision !== 'allow' && decision !== 'deny') refuse('not_allowed');
    if (typeof input.token !== 'string' || !TOKEN.test(input.token)) refuse('unknown');
    const db = this.deps.store.db!;
    const hash = sha(input.token as string);
    const row = db.prepare('SELECT hash, owner_id, destination_id, event_id, session_id, request_id, decisions, tool_class, tool_name, detail_hash, expires_at, used_at FROM notify_action_tokens WHERE hash = ?').get(hash) as
      | TokenRow
      | undefined;
    // Another user's token looks exactly like a wrong one.
    if (!row || row.owner_id !== input.userId) refuse('unknown');
    const t = row!;
    const where = { session: t.session_id, request: t.request_id, destination: t.destination_id, toolClass: t.tool_class };
    if (t.used_at) refuse('used', where);
    if (Date.parse(t.expires_at) <= this.#now().getTime()) refuse('expired', where);
    const dest = this.deps.destinations.find(t.destination_id);
    if (!dest || !dest.enabled || dest.state === 'disabled' || dest.userId !== input.userId) refuse('device_removed', where);
    const extra = { ...where, device: dest!.name };
    if (this.#limited(this.#answers, t.destination_id, 3600_000, 20)) refuse('rate_limited', extra);
    if (!t.decisions.split(',').includes(decision as string)) refuse('not_allowed', extra);
    // The policy NOW: turning a switch off cancels every pending token.
    const policy = this.deps.destinations.prefs(input.userId);
    if (!this.deps.ceiling()) refuse('disabled', extra);
    if (decision === 'deny' && !policy.deny) refuse('disabled', extra);
    if (decision === 'allow' && (t.tool_class === 'other' || !classSwitch(policy, t.tool_class))) refuse('disabled', extra);
    if (!this.deps.owner.userEnabled(input.userId) || !this.deps.owner.can(input.userId, 'operate', { type: 'session', id: t.session_id })) refuse('not_allowed', extra);
    const session = this.deps.chat.get(t.session_id);
    if (!session || session.state === 'ended') refuse('closed', extra);
    if (decision === 'allow' && this.deps.untrusted(t.session_id)) refuse('not_allowed', extra);
    const open = this.deps.chat.openRequests(t.session_id).find((r) => r.requestId === t.request_id);
    if (!open) refuse('closed', extra);
    // The details still hold: the same tool (so the same class) and the same text as the notification showed.
    if (notifyToolClass(open!.toolName) !== t.tool_class || (open!.toolName ?? null) !== t.tool_name || shownHash(open!) !== t.detail_hash) refuse('not_allowed', extra);
    if (decision === 'allow' && !shownWhole(open!, session!.worktree?.path ?? session!.cwd)) refuse('not_allowed', extra);
    // Single use: one atomic statement; zero rows means someone else got there first.
    const won = db.prepare('UPDATE notify_action_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL').run(this.#now().toISOString(), hash).changes === 1;
    if (!won) refuse('used', extra);
    this.#count(this.#answers, t.destination_id);
    try {
      await this.deps.chat.respond(t.session_id, t.request_id, decision as NotifyDecision, {
        note: decision === 'deny' ? 'Denied from a notification.' : undefined,
        actor: `portal:notify-${t.destination_id}`,
      });
    } catch (e) {
      if (e instanceof AppError && (e.is('CONFLICT') || e.is('NOT_FOUND'))) refuse('closed', extra);
      throw e;
    }
    const outcome = decision === 'allow' ? 'allowed_once' : 'denied';
    audit(null, extra, outcome);
    this.deps.answered?.(t.session_id, t.request_id, outcome);
    return { ok: true, sessionId: t.session_id, outcome };
  }

  /** A request answered or withdrawn anywhere: its tokens are dead. */
  closeRequest(sessionId: string, requestId: string): void {
    if (!this.deps.store.writable) return;
    this.deps.store.db!.prepare('UPDATE notify_action_tokens SET used_at = COALESCE(used_at, ?) WHERE session_id = ? AND request_id = ?').run(this.#now().toISOString(), sessionId, requestId);
  }
}
