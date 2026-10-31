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
  APPROVAL_TTL_REFUSAL_MIN,
  approvalNeedsValue,
  isApprovalKind,
  isRefusalKind,
  type Actor,
  type Approval,
  type ApprovalKind,
  type ApprovalResult,
  type ApprovalStatus,
} from '@portal/contracts';
import { findSecret } from '../portalmcp/sanitize.js';
import { mayDecide, NO_APPROVAL } from './authz.js';
import { APPROVAL_KIND_DEFS, type ApprovalChat, type ApprovalDelivery, type ApprovalDeps, type ApprovalKindDef, type ApprovalPools, type ApprovalRequester } from './kinds.js';
import { canonicalJson, cleanRefusal, PASS_HASH, PASS_KINDS, PASS_TTL_MS, passFrom } from './pass.js';

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

/** The shape of a request id (`apr-` and 18 hex digits): the service draws it, or a workspace's writer does (T-2885). */
export const APPROVAL_ID = /^apr-[0-9a-f]{18}$/;

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
  /** Minutes until it expires (default a day, at most a week; a refused call: 30 minutes, at most 30, T-3114). */
  ttlMinutes?: number;
}

/** T-3114: more refusal requests of one session wait than the outbox lets wait (OUTBOX_PENDING_MAX): the new one is dropped. */
export const REFUSAL_CAP_MESSAGE = 'Too many refused calls of this session wait already.';

/** T-3206: a repeat moves a refused call's expiry forward, but never past this long after the card was made (a looping retry). */
export const REFUSAL_FOLD_MAX_LIFE_MS = 2 * 60 * 60_000;
/**
 * T-3206: the repeat rows of a decided or expired card are kept this long after its end, so the decision message's repeat id still answers
 * `approval_get` while its outcome (a one-time pass lasts PASS_TTL_MS) matters; the sweep deletes them after that.
 */
export const REPEATS_KEEP_MS = PASS_TTL_MS;

type RepeatRow = { id: string; approval_id: string; requester_session: string | null; created_at: string };

/**
 * T-3206: what makes two refusals "the same call" for the fold. Claude Code writes a new free-text `description` on most retries, so the
 * key is the tool, its input WITHOUT `description` (the rest of the input in canonical JSON), the folder and the form. Only the fold uses
 * it: the card stores the first call exactly, and its pass hashes that. Any other kind folds on its whole payload.
 */
export function refusalFoldKey(kind: string, payload: unknown): string {
  return canonicalJson(kind === 'guard.refusal' ? withoutDescription(payload) : payload);
}

/** A refusal payload with its tool input's free-text `description` left out (anything else: unchanged). */
function withoutDescription<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  if (!p.input || typeof p.input !== 'object' || Array.isArray(p.input)) return payload;
  const { description: _free, ...input } = p.input as Record<string, unknown>;
  return { ...p, input } as T;
}

export interface ApprovalsOptions {
  db: () => DatabaseSync | null;
  chat?: ApprovalChat | null;
  /** The pools service (pool.secret_set). Absent: that kind can't be asked for. */
  pools?: ApprovalPools | null;
  /** Delivery (T-2889): deliver a workspace again when its passes change. Absent: a refused call's Allow issues no pass. */
  delivery?: ApprovalDelivery | null;
  now?: () => number;
  /** Tells Needs you something changed (attention.changed). */
  changed?: () => void;
  log?: (what: string, e: unknown) => void;
}

export class Approvals {
  readonly #o: ApprovalsOptions;
  chat: ApprovalChat | null;
  pools: ApprovalPools | null;
  delivery: ApprovalDelivery | null;

  constructor(opts: ApprovalsOptions) {
    this.#o = opts;
    this.chat = opts.chat ?? null;
    this.pools = opts.pools ?? null;
    this.delivery = opts.delivery ?? null;
  }

  /** The services the kinds use (titles, mayAsk, the executors). */
  get deps(): ApprovalDeps {
    return { chat: this.chat, pools: this.pools, delivery: this.delivery };
  }

  /**
   * T-2889: the live one-time passes of a workspace (allowed refusals, unexpired, not reported used), for its passes file. The rows are
   * read through the decision time, so only the last PASS_TTL_MS of decisions are scanned.
   */
  livePasses(workspaceId: string): { pass: string; until: number }[] {
    const db = this.#o.db();
    if (!db) return [];
    const now = this.#now();
    const rows = db
      .prepare(`SELECT result FROM approvals WHERE workspace = ? AND status = 'allowed' AND decided_at > ? AND kind IN (${PASS_KINDS.map(() => '?').join(', ')}) ORDER BY decided_at, id`)
      .all(workspaceId, this.#iso(now - PASS_TTL_MS - 60_000), ...PASS_KINDS) as { result: string | null }[];
    const out: { pass: string; until: number }[] = [];
    for (const r of rows) {
      const p = passFrom(r.result);
      if (p && !p.used && p.until > now) out.push({ pass: p.pass, until: p.until });
    }
    return out;
  }

  /** T-2889: a workspace reports it used a pass; the portal stops delivering it. True when one of its live passes matched. */
  markPassUsed(workspaceId: string, pass: string): boolean {
    const db = this.#o.db();
    if (!db || !PASS_HASH.test(pass)) return false;
    const rows = db
      .prepare(`SELECT id, result FROM approvals WHERE workspace = ? AND status = 'allowed' AND decided_at > ? AND kind IN (${PASS_KINDS.map(() => '?').join(', ')})`)
      .all(workspaceId, this.#iso(this.#now() - PASS_TTL_MS - 60_000), ...PASS_KINDS) as { id: string; result: string | null }[];
    let hit = false;
    for (const r of rows) {
      const p = passFrom(r.result);
      if (!p || p.used || p.pass !== pass) continue;
      const result = JSON.parse(r.result!) as ApprovalResult & { output: Record<string, unknown> };
      result.output = { ...result.output, used: true };
      db.prepare('UPDATE approvals SET result = ? WHERE id = ?').run(JSON.stringify(result), r.id);
      hit = true;
    }
    if (hit) this.#o.changed?.();
    return hit;
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
      count: 1 + this.#repeats(r.id),
    };
  }

  /** T-3114: how many repeats were folded into this request. */
  #repeats(id: string): number {
    const r = this.#db().prepare('SELECT count(*) AS n FROM approval_repeats WHERE approval_id = ?').get(id) as { n: number };
    return Number(r.n);
  }

  /** T-3114: the waiting refusal of this workspace with the same kind and the same call (`refusalFoldKey`, T-3206), or none. */
  #twin(kind: string, workspace: string | null, payload: unknown): Row | undefined {
    const want = refusalFoldKey(kind, payload);
    const rows = this.#db()
      .prepare(
        "SELECT * FROM approvals WHERE kind = ? AND workspace IS ? AND status = 'pending' AND expires_at > ? ORDER BY created_at, id",
      )
      .all(kind, workspace, this.#iso()) as Row[];
    return rows.find((r) => refusalFoldKey(kind, JSON.parse(r.payload)) === want);
  }

  /**
   * T-3206: the card as a session that only filed a repeat of it sees it: under its own repeat id, as its own ask (its session and title,
   * its time), with nothing of the first asker: no id, no session, no reason, and no `description` (the first asker's words; the fold
   * ignores it). The status, expiry, count and result are the card's.
   */
  #repeatView(card: Row, rep: RepeatRow): Approval {
    const a = this.#toApproval(card);
    return {
      ...a,
      id: rep.id,
      payload: withoutDescription(a.payload),
      requesterSession: rep.requester_session,
      requesterTitle: rep.requester_session ? (this.chat?.get(rep.requester_session)?.title ?? null) : null,
      reason: '',
      createdAt: rep.created_at,
    };
  }

  /**
   * T-3206: the sweep. Deletes the repeat rows of every card that ended (decided, or past its expiry) more than REPEATS_KEEP_MS ago, and of a
   * card that is gone. It walks approval_repeats (only live and recent repeats are left in it) with one key lookup per row. Returns how many.
   */
  #pruneRepeats(): number {
    const cut = this.#iso(this.#now() - REPEATS_KEEP_MS);
    const r = this.#db()
      .prepare(
        `DELETE FROM approval_repeats WHERE NOT EXISTS (
           SELECT 1 FROM approvals a WHERE a.id = approval_repeats.approval_id
             AND ((a.status = 'pending' AND a.expires_at > ?) OR (a.status != 'pending' AND coalesce(a.decided_at, a.expires_at) > ?)))`,
      )
      .run(cut, cut);
    return Number(r.changes);
  }

  #row(id: string): Row | undefined {
    return this.#db().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
  }

  /** Marks what waited past its time `expired` (lazily, on each read of the queue), and prunes old repeats (T-3206). */
  expire(): number {
    const r = this.#db().prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(this.#iso());
    this.#pruneRepeats();
    return Number(r.changes);
  }

  /**
   * Asks. `requester`: the verified asking session (an agent's token), or null for the portal's own request. Validates the kind and its
   * schema, caps the size, refuses a secret-shaped value or a key that would hold a secret, and stores the payload once.
   */
  create(
    req: ApprovalCreate,
    requester: ApprovalRequester | null,
    opts: { id?: string; pendingCap?: { max: number; kinds: readonly string[] } } = {},
  ): Approval {
    // T-2885: a workspace's outbox line names the id its writer already printed. Only the service's own shape; an id in use is a conflict
    // (a card's own id or a repeat's, T-3114).
    if (opts.id !== undefined && !APPROVAL_ID.test(opts.id)) throw new AppError('VALIDATION_FAILED', 'Not an approval id.');
    if (opts.id !== undefined && (this.#row(opts.id) || this.#db().prepare('SELECT 1 FROM approval_repeats WHERE id = ?').get(opts.id)))
      throw new AppError('CONFLICT', 'That approval id is in use.');
    if (!isApprovalKind(req.kind)) throw new AppError('VALIDATION_FAILED', 'Unknown kind.', { details: { kind: 'Unknown.' } });
    const def: ApprovalKindDef = APPROVAL_KIND_DEFS[req.kind];
    // T-2885 review M2: a refused file call's content is never stored, and the rest is redacted (approvals/pass.ts cleanRefusal).
    const parsed = def.schema.safeParse(req.kind === 'guard.refusal' ? cleanRefusal(req.payload) : req.payload);
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
    // T-3114: a refused call waits 30 minutes at most (a day buried the real asks), whatever the asker says.
    const refusal = isRefusalKind(req.kind);
    const ttlMax = refusal ? APPROVAL_TTL_REFUSAL_MIN : APPROVAL_TTL_MAX_MIN;
    const ttl = Math.min(
      Math.max(Math.round(req.ttlMinutes ?? (refusal ? APPROVAL_TTL_REFUSAL_MIN : APPROVAL_TTL_DEFAULT_MIN)), 1),
      ttlMax,
    );
    const now = this.#now();
    const id = opts.id ?? `apr-${randomBytes(9).toString('hex')}`;
    // T-3114: the same refused call again in the same workspace (same kind and call, `refusalFoldKey`) while its card waits: no second card.
    // The repeat is recorded under the card (its id stays readable by the session that filed it), the count goes up, and the card lives
    // another TTL from now, since an agent is still trying it, but at most REFUSAL_FOLD_MAX_LIFE_MS after it was made (T-3206). Before the
    // cap: a repeat adds no card, so it never counts against the five. Each filing also runs the repeats sweep (T-3206).
    if (refusal) {
      this.#pruneRepeats();
      const twin = this.#twin(req.kind, requester?.workspaceId ?? null, payload);
      if (twin) {
        this.#db()
          .prepare('INSERT INTO approval_repeats (id, approval_id, requester_session, created_at) VALUES (?, ?, ?, ?)')
          .run(id, twin.id, requester?.sessionId ?? null, this.#iso(now));
        const until = this.#iso(Math.min(now + ttl * 60_000, Date.parse(twin.created_at) + REFUSAL_FOLD_MAX_LIFE_MS));
        if (until > twin.expires_at)
          this.#db().prepare("UPDATE approvals SET expires_at = ? WHERE id = ? AND status = 'pending'").run(until, twin.id);
        this.#o.changed?.();
        return this.#toApproval(this.#row(twin.id)!);
      }
    }
    if (opts.pendingCap && requester && this.pendingCount(requester.sessionId, opts.pendingCap.kinds) >= opts.pendingCap.max)
      throw new AppError('RATE_LIMITED', REFUSAL_CAP_MESSAGE);
    this.#db()
      .prepare(
        `INSERT INTO approvals (id, kind, payload, requester_session, workspace, tier, reason, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'T2', ?, 'pending', ?, ?)`,
      )
      .run(id, req.kind, json, requester?.sessionId ?? null, requester?.workspaceId ?? null, reason, this.#iso(now), this.#iso(now + ttl * 60_000));
    this.#o.changed?.();
    return this.#toApproval(this.#row(id)!);
  }

  /** How many requests of these kinds wait (pending, not expired) for one session: the outbox's cap (T-2885). */
  pendingCount(sessionId: string, kinds: readonly string[]): number {
    if (!kinds.length) return 0;
    const r = this.#db()
      .prepare(`SELECT count(*) AS n FROM approvals WHERE requester_session = ? AND status = 'pending' AND expires_at > ? AND kind IN (${kinds.map(() => '?').join(', ')})`)
      .get(sessionId, this.#iso(), ...kinds) as { n: number };
    return Number(r.n);
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
    const own = (
      this.#db().prepare('SELECT * FROM approvals WHERE requester_session = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(sessionId, limit) as Row[]
    ).map((r) => this.#toApproval(r));
    // T-3114: also the cards a repeat of this session was folded into; T-3206: another asker's card shows once, under this session's first
    // repeat id and as its own (`#repeatView`), never under the card's id. Its own card is listed above already.
    const reps = this.#db()
      .prepare('SELECT * FROM approval_repeats WHERE requester_session = ? ORDER BY created_at, id')
      .all(sessionId) as RepeatRow[];
    const seen = new Set<string>();
    const theirs: Approval[] = [];
    for (const rep of reps) {
      if (seen.has(rep.approval_id)) continue;
      seen.add(rep.approval_id);
      const card = this.#row(rep.approval_id);
      if (card && card.requester_session !== sessionId) theirs.push(this.#repeatView(card, rep));
    }
    return [...own, ...theirs]
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  ownOne(sessionId: string, id: string): Approval {
    const r = this.#row(id);
    if (r && r.requester_session === sessionId) return this.#toApproval(r);
    // T-3114: the id the guard printed for a repeat answers with the card it was folded into, for the session that filed it only. T-3206:
    // the first asker's own repeat answers with its card; any other session sees it under that repeat id, as its own (`#repeatView`).
    const rep = this.#db().prepare('SELECT * FROM approval_repeats WHERE id = ? AND requester_session = ?').get(id, sessionId) as
      RepeatRow | undefined;
    const card = rep ? this.#row(rep.approval_id) : undefined;
    if (!rep || !card) throw new AppError('NOT_FOUND', NO_APPROVAL);
    return card.requester_session === sessionId ? this.#toApproval(card) : this.#repeatView(card, rep);
  }

  /**
   * T-3114: the session ended (or was archived or deleted): its refused calls wait for nothing any more, so their cards expire now. Only
   * the refusal kinds; a Bypass or a secret ask stays for the person. Returns how many expired.
   */
  expireForSession(sessionId: string, why = 'The asking session ended.'): number {
    const db = this.#o.db();
    if (!db) return 0;
    const result: ApprovalResult = { ok: false, message: why };
    const r = db
      .prepare(
        "UPDATE approvals SET status = 'expired', decided_at = ?, result = ? WHERE requester_session = ? AND status = 'pending' AND kind = ?",
      )
      .run(this.#iso(), JSON.stringify(result), sessionId, 'guard.refusal');
    const n = Number(r.changes);
    if (n) this.#o.changed?.();
    return n;
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
    const ctx = { approvalId: id, actor, sessionToken: opts.sessionToken, value: opts.value, workspaceId: row.workspace, now: this.#now(), ...this.deps };
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
    // T-2889: a pass is in the stored result now; deliver its workspace so the passes file holds it.
    if (result.ok && row.workspace && passFrom(JSON.stringify(result))) {
      try {
        this.delivery?.passesChanged(row.workspace);
      } catch (e) {
        this.#o.log?.(`delivering the pass of ${id}`, e);
      }
    }
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
    if (!this.chat) return;
    // T-3114: every session whose refusal was folded into this card hears it too, once each, under the id it was given.
    const told = new Map<string, string>();
    if (a.requesterSession) told.set(a.requesterSession, a.id);
    const reps = this.#db()
      .prepare('SELECT id, requester_session FROM approval_repeats WHERE approval_id = ? ORDER BY created_at, id')
      .all(a.id) as { id: string; requester_session: string | null }[];
    for (const r of reps) if (r.requester_session && !told.has(r.requester_session)) told.set(r.requester_session, r.id);
    for (const [session, id] of told) {
      const text = `Your approval request ${id} (${a.kind}) was decided. ${what}`;
      try {
        await this.chat.send(session, randomUUID(), text, { actor: `portal:approval.${a.id}`, actorLabel: 'Approval', priority: 'later' });
      } catch (e) {
        this.#o.log?.(`telling ${session} about ${a.id}`, e);
      }
    }
  }
}
