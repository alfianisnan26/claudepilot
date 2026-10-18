import { createHash, randomBytes } from 'node:crypto';
import { JOBRUN_TOKEN_PREFIX, JOBRUN_TOKEN_TTL_DAYS, type JobRunTokenSummary } from '@portal/contracts';
import type { Store } from '../store/store.js';

// The job-run Mac door tokens (T-1083 S1b, D-84). A `cpjr_` token opens `/jobrun/mac/*` for ONE workspace and nothing else: it is in its
// own table, so `/mcp` (pmcp_tokens, agents, managers) and `/api` (the cookie) never know it, and the door knows no other token. Only an
// admin mints or revokes one (routes.ts, `manage` on the `targets` platform area). Hashed at rest; the secret is shown once.

const TOUCH_EVERY_MS = 60_000;
const hashOf = (secret: string) => createHash('sha256').update(secret).digest('hex');

export type JobRunVerify =
  | { ok: true; tokenId: string; userId: string; workspaceId: string; label: string }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired'; tokenId?: string };

interface Row {
  id: string;
  label: string;
  last4: string;
  user_id: string;
  workspace_id: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const summary = (r: Row): JobRunTokenSummary => ({
  id: r.id,
  label: r.label,
  workspaceId: r.workspace_id,
  hint: `${JOBRUN_TOKEN_PREFIX}…${r.last4}`,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

export class JobRunTokens {
  readonly #touched = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get #writable() {
    return this.store.writable ? this.store.db : null;
  }

  /** A fresh token for `workspaceId`, acting as `userId`. Null on a database that can't be written. */
  mint(req: { userId: string; workspaceId: string; label: string }): { token: JobRunTokenSummary; secret: string } | null {
    const db = this.#writable;
    if (!db) return null;
    const secret = `${JOBRUN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = `jrt_${randomBytes(6).toString('hex')}`;
    const now = this.now();
    const expiresAt = new Date(now.getTime() + JOBRUN_TOKEN_TTL_DAYS * 86_400_000).toISOString();
    db.prepare('INSERT INTO jobrun_tokens (id, label, token_hash, last4, user_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      req.label,
      hashOf(secret),
      secret.slice(-4),
      req.userId,
      req.workspaceId,
      now.toISOString(),
      expiresAt,
    );
    return { token: this.get(id)!, secret };
  }

  get(id: string): JobRunTokenSummary | null {
    const row = this.store.db
      ?.prepare('SELECT id, label, last4, user_id, workspace_id, created_at, expires_at, last_used_at, revoked_at FROM jobrun_tokens WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? summary(row) : null;
  }

  /** Every token, newest first: never a secret or a hash. */
  list(): JobRunTokenSummary[] {
    const rows = (this.store.db
      ?.prepare('SELECT id, label, last4, user_id, workspace_id, created_at, expires_at, last_used_at, revoked_at FROM jobrun_tokens ORDER BY created_at DESC, id')
      .all() ?? []) as unknown as Row[];
    return rows.map(summary);
  }

  /** Revokes one token; false when there is none or it was already revoked. */
  revoke(id: string, reason: string): boolean {
    const db = this.#writable;
    if (!db) return false;
    const r = db.prepare('UPDATE jobrun_tokens SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL').run(this.now().toISOString(), reason, id);
    return Number(r.changes) > 0;
  }

  /** A lockdown or "revoke all". */
  revokeAll(reason: string): number {
    const db = this.#writable;
    if (!db) return 0;
    return Number(db.prepare('UPDATE jobrun_tokens SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL').run(this.now().toISOString(), reason).changes);
  }

  /** Checks a bearer secret: a `cpjr_` that exists, wasn't revoked and hasn't expired (refused from the moment `expires_at` is reached). */
  verify(secret: string): JobRunVerify {
    if (!secret.startsWith(JOBRUN_TOKEN_PREFIX) || secret.length < 20 || secret.length > 128) return { ok: false, reason: 'unknown' };
    const row = this.store.db
      ?.prepare('SELECT id, label, last4, user_id, workspace_id, created_at, expires_at, last_used_at, revoked_at FROM jobrun_tokens WHERE token_hash = ?')
      .get(hashOf(secret)) as Row | undefined;
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.revoked_at) return { ok: false, reason: 'revoked', tokenId: row.id };
    const now = this.now();
    if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: 'expired', tokenId: row.id };
    this.#touch(row.id, now);
    return { ok: true, tokenId: row.id, userId: row.user_id, workspaceId: row.workspace_id, label: row.label };
  }

  #touch(id: string, now: Date) {
    if (now.getTime() - (this.#touched.get(id) ?? 0) < TOUCH_EVERY_MS) return;
    this.#touched.set(id, now.getTime());
    try {
      this.#writable?.prepare('UPDATE jobrun_tokens SET last_used_at = ? WHERE id = ?').run(now.toISOString(), id);
    } catch {
      // bookkeeping only
    }
  }
}
