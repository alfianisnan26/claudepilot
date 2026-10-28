// Approvals (docs/prd/approvals.md, PILOT-1000 / T-2867): the `approvals` table (migration 883) and the one service that writes it.
//
//  - create: an agent (its verified session) or the portal asks; the kind's schema, a size cap and a secret check guard the payload, which
//    is stored once and never edited (no method here writes `payload` after the INSERT).
//  - allow: a PERSON only. The kind's precheck runs first (a refusal leaves the request pending); then ONE conditional UPDATE claims the
//    row (pending and not expired), so a double click or two tabs run the executor exactly once; the result is stored.
//  - deny: a person only; the reason is stored. Both tell the asking session with a message.
//  - expiry: a pending request past `expires_at` can't be allowed; it is marked `expired` when read.

import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  APPROVAL_PAYLOAD_MAX_BYTES,
  APPROVAL_REASON_MAX,
  APPROVAL_TTL_DEFAULT_MIN,
  APPROVAL_TTL_MAX_MIN,
  approvalNeedsValue,
  isApprovalKind,
  type Actor,
  type Approval,
  type ApprovalKind,
  type ApprovalResult,
  type ApprovalStatus,
} from '@portal/contracts';
import { findSecret } from '../portalmcp/sanitize.js';
import { mayDecide, NO_APPROVAL } from './authz.js';
import { APPROVAL_KIND_DEFS, type ApprovalChat, type ApprovalDeps, type ApprovalKindDef, type ApprovalPools, type ApprovalRequester } from './kinds.js';

type Row = {
  id: string;
  kind: string;
  payload: string;
  requester_session: string | null;
  workspace: string | null;
  tier: string;
  reason: string;
  status: string;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  result: string | null;
};

/** A key that names a secret's VALUE is refused: a kind that needs a secret names it (`secretName`), never carries it. */
const SECRET_KEY = /^(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|credentials|auth|authorization|cookie)$/i;

function secretKeyPath(value: unknown, path = '', depth = 0): string | null {
  if (depth > 12 || !value || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    const here = path ? `${path}.${k}` : k;
    if (SECRET_KEY.test(k) && v !== null && v !== '') return here;
    const hit = secretKeyPath(v, here, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export interface ApprovalCreate {
  kind: string;
  payload: unknown;
  reason?: string;
  /** Minutes until it expires (default a day, at most a week). */
  ttlMinutes?: number;
}

export interface ApprovalsOptions {
  db: () => DatabaseSync | null;
  chat?: ApprovalChat | null;
  /** The pools service (pool.secret_set). Absent: that kind can't be asked for. */
  pools?: ApprovalPools | null;
  now?: () => number;
  /** Tells Needs you something changed (attention.changed). */
  changed?: () => void;
  log?: (what: string, e: unknown) => void;
}

export class Approvals {
  readonly #o: ApprovalsOptions;
  chat: ApprovalChat | null;
  pools: ApprovalPools | null;

  constructor(opts: ApprovalsOptions) {
    this.#o = opts;
    this.chat = opts.chat ?? null;
    this.pools = opts.pools ?? null;
  }

  /** The services the kinds use (titles, mayAsk, the executors). */
  get deps(): ApprovalDeps {
    return { chat: this.chat, pools: this.pools };
  }

  #db(): DatabaseSync {
    const db = this.#o.db();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not available.');
    return db;
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  #iso(ms = this.#now()): string {
    return new Date(ms).toISOString();
  }

  #toApproval(r: Row): Approval {
    const now = this.#iso();
    const status = (r.status === 'pending' && r.expires_at <= now ? 'expired' : r.status) as ApprovalStatus;
    const title = r.requester_session ? (this.chat?.get(r.requester_session)?.title ?? null) : null;
    return {
      id: r.id,
      kind: r.kind as ApprovalKind,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      requesterSession: r.requester_session,
      requesterTitle: title,
      workspace: r.workspace,
      tier: 'T2',
      reason: r.reason,
      status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      result: r.result ? (JSON.parse(r.result) as ApprovalResult) : null,
    };
  }

  #row(id: string): Row | undefined {
    return this.#db().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
  }

  /** Marks what waited past its time `expired` (lazily, on each read of the queue). */
  expire(): number {
    const r = this.#db().prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(this.#iso());
    return Number(r.changes);
  }

  /**
   * Asks. `requester`: the verified asking session (an agent's token), or null for the portal's own request. Validates the kind and its
   * schema, caps the size, refuses a secret-shaped value or a key that would hold a secret, and stores the payload once.
   */
  create(req: ApprovalCreate, requester: ApprovalRequester | null): Approval {
    if (!isApprovalKind(req.kind)) throw new AppError('VALIDATION_FAILED', 'Unknown kind.', { details: { kind: 'Unknown.' } });
    const def: ApprovalKindDef = APPROVAL_KIND_DEFS[req.kind];
    const parsed = def.schema.safeParse(req.payload);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', `The payload does not fit ${req.kind}.`, { details: { payload: parsed.error.issues.map((i) => i.message).join('; ') } });
    const payload = parsed.data;
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json) > APPROVAL_PAYLOAD_MAX_BYTES) throw new AppError('VALIDATION_FAILED', 'The payload is too large.');
    const secretAt = findSecret(payload) ?? secretKeyPath(payload);
    if (secretAt) throw new AppError('VALIDATION_FAILED', `The payload may not hold a secret (at ${secretAt}); name the secret instead.`);
    const reason = (req.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, APPROVAL_REASON_MAX);
    if (findSecret(reason)) throw new AppError('VALIDATION_FAILED', 'The reason may not hold a secret.');
    def.mayAsk?.(payload, requester, this.deps);
    // T-2887: one pending Bypass card per session and requester. The same ask again by the same asker gets the card that waits (no new row,
    // no second push); an expired card does not count, so the ask makes a fresh one. Never another asker's card: an agent must be able to
    // read its own request and hear its outcome, which the portal's card would not give it (review c43483).
    if (req.kind === 'session.bypass') {
      const waiting = this.#db()
        .prepare(
          "SELECT * FROM approvals WHERE kind = ? AND payload = ? AND requester_session IS ? AND status = 'pending' AND expires_at > ? ORDER BY created_at, id LIMIT 1",
        )
        .get(req.kind, json, requester?.sessionId ?? null, this.#iso()) as Row | undefined;
      if (waiting) return this.#toApproval(waiting);
    }
    const ttl = Math.min(Math.max(Math.round(req.ttlMinutes ?? APPROVAL_TTL_DEFAULT_MIN), 1), APPROVAL_TTL_MAX_MIN);
    const now = this.#now();
    const id = `apr-${randomBytes(9).toString('hex')}`;
    this.#db()
      .prepare(
        `INSERT INTO approvals (id, kind, payload, requester_session, workspace, tier, reason, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'T2', ?, 'pending', ?, ?)`,
      )
      .run(id, req.kind, json, requester?.sessionId ?? null, requester?.workspaceId ?? null, reason, this.#iso(now), this.#iso(now + ttl * 60_000));
    this.#o.changed?.();
    return this.#toApproval(this.#row(id)!);
  }

  /** The queue a person decides from (pending, not expired, oldest first). Anyone else: empty. */
  pending(actor: Actor): Approval[] {
    if (!mayDecide(actor)) return [];
    const rows = this.#db().prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at, id").all(this.#iso()) as Row[];
    return rows.map((r) => this.#toApproval(r));
  }

  /** One request for a person (any status). Anyone else: NOT_FOUND, as a missing one. */
  getFor(actor: Actor, id: string): Approval {
    const r = mayDecide(actor) ? this.#row(id) : undefined;
    if (!r) throw new AppError('NOT_FOUND', NO_APPROVAL);
    return this.#toApproval(r);
  }

  /** What a session asked, newest first; another session's request is NOT_FOUND (`ownOne`). */
  listOwn(sessionId: string, limit = 50): Approval[] {
    const rows = this.#db().prepare('SELECT * FROM approvals WHERE requester_session = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(sessionId, limit) as Row[];
    return rows.map((r) => this.#toApproval(r));
  }

  ownOne(sessionId: string, id: string): Approval {
    const r = this.#row(id);
    if (!r || r.requester_session !== sessionId) throw new AppError('NOT_FOUND', NO_APPROVAL);
    return this.#toApproval(r);
  }

  /** Every pending request, for Needs you (the source filters by actor). */
  pendingRows(nowMs: number): Approval[] {
    const db = this.#o.db();
    if (!db) return [];
    const rows = db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at, id").all(this.#iso(nowMs)) as Row[];
    return rows.map((r) => this.#toApproval(r));
  }

  #pendingOr404(actor: Actor, id: string): { row: Row; def: ApprovalKindDef } {
    const row = mayDecide(actor) ? this.#row(id) : undefined;
    if (!row || !isApprovalKind(row.kind)) throw new AppError('NOT_FOUND', NO_APPROVAL);
    if (row.status !== 'pending') throw new AppError('CONFLICT', `This request was already ${row.status}.`);
    if (row.expires_at <= this.#iso()) throw new AppError('CONFLICT', 'This request expired.');
    return { row, def: APPROVAL_KIND_DEFS[row.kind] };
  }

  /**
   * A person allows: the kind's precheck, then one atomic claim (pending and not expired), then the executor runs ONCE on the stored
   * payload as the portal, and its result is stored and sent to the asking session.
   *
   * `value`: what the person typed, for a kind that needs one (pool.secret_set). It lives in this call only: it goes to the executor and
   * nowhere else (not the row, the result, a message or a log); a value for a kind that takes none is refused.
   */
  async allow(actor: Actor, id: string, opts: { sessionToken?: string | undefined; decidedBy?: string; value?: string | undefined } = {}): Promise<Approval> {
    const { row, def } = this.#pendingOr404(actor, id);
    if (opts.value !== undefined && !approvalNeedsValue(def.kind)) throw new AppError('VALIDATION_FAILED', 'This request takes no value.', { details: { value: 'Not used.' } });
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const ctx = { approvalId: id, actor, sessionToken: opts.sessionToken, value: opts.value, ...this.deps };
    def.precheck?.(payload, ctx);
    const at = this.#iso();
    const claimed = this.#db()
      .prepare("UPDATE approvals SET status = 'allowed', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?")
      .run(opts.decidedBy ?? 'ui', at, id, at);
    if (Number(claimed.changes) !== 1) throw new AppError('CONFLICT', 'This request was already decided or expired.');
    let result: ApprovalResult;
    try {
      result = await def.run(payload, ctx);
    } catch (e) {
      const said = e instanceof Error ? e.message : String(e);
      this.#o.log?.(`running approval ${id}`, opts.value && said.includes(opts.value) ? new Error('the executor threw') : e);
      result = { ok: false, message: e instanceof AppError ? e.message : 'The run failed.' };
    }
    // Belt and braces: whatever an executor says, the typed value never reaches the row or the asking agent.
    if (opts.value && JSON.stringify(result).includes(opts.value)) result = { ok: result.ok, message: result.ok ? 'Done.' : 'The run failed.' };
    this.#db().prepare('UPDATE approvals SET result = ? WHERE id = ?').run(JSON.stringify(result), id);
    this.#o.changed?.();
    const out = this.#toApproval(this.#row(id)!);
    await this.#tell(out, result.ok ? `Allowed: ${result.message}` : `Allowed, but it did not run: ${result.message}`);
    return out;
  }

  /** A person denies, with an optional reason; the asking session is told. */
  async deny(actor: Actor, id: string, reasonIn?: string, decidedBy = 'ui'): Promise<Approval> {
    const { row } = this.#pendingOr404(actor, id);
    const reason = (reasonIn ?? '').replace(/\s+/g, ' ').trim().slice(0, APPROVAL_REASON_MAX) || 'Denied.';
    // The reason is stored and sent to an agent: a pasted credential would land in both (review nit 4, T-2867).
    if (findSecret(reason)) throw new AppError('VALIDATION_FAILED', 'The reason may not hold a secret.', { details: { reason: 'Looks like a secret.' } });
    const at = this.#iso();
    const result: ApprovalResult = { ok: false, message: reason };
    const r = this.#db()
      .prepare("UPDATE approvals SET status = 'denied', decided_by = ?, decided_at = ?, result = ? WHERE id = ? AND status = 'pending' AND expires_at > ?")
      .run(decidedBy, at, JSON.stringify(result), row.id, at);
    if (Number(r.changes) !== 1) throw new AppError('CONFLICT', 'This request was already decided or expired.');
    this.#o.changed?.();
    const out = this.#toApproval(this.#row(id)!);
    await this.#tell(out, `Denied: ${reason}`);
    return out;
  }

  /** A message to the asking session (none when the portal asked). Best effort: a session that ended does not undo the decision. */
  async #tell(a: Approval, what: string): Promise<void> {
    if (!a.requesterSession || !this.chat) return;
    const text = `Your approval request ${a.id} (${a.kind}) was decided. ${what}`;
    try {
      await this.chat.send(a.requesterSession, randomUUID(), text, { actor: `portal:approval.${a.id}`, actorLabel: 'Approval', priority: 'later' });
    } catch (e) {
      this.#o.log?.(`telling ${a.requesterSession} about ${a.id}`, e);
    }
  }
}
