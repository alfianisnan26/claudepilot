import { AppError, defineErrorCodes, newId } from '@isnanme/core';
import { secretCredentialType, type SecretValueInfo } from '@portal/contracts';
import type { Store } from '../store/store.js';

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    LOCKED: true;
  }
}
// The same code and status Account Pool registers: re-registering one is allowed, and this module may load first.
defineErrorCodes({ LOCKED: { status: 423, message: 'Secrets are locked.' } });

interface ValueRow {
  id: string;
  pool_id: string;
  entry_id: string;
  field: string;
  version: number;
  ciphertext: string | null;
  fingerprint: string;
  fingerprint_key_id: string;
  hint: string;
  byte_length: number;
  detected_type: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
  purge_after?: string | null;
  created_at: string;
}

/** Where a value's ciphertext belongs: bound into its encryption (PRD §9: `secret_values|<id>|ciphertext`). */
const slot = (id: string) => ({ table: 'secret_values', row: id, column: 'ciphertext' });

/** Prefixes a hint may keep, longest first: they say what a value is without saying what it holds. */
const HINT_PREFIXES = ['github_pat_', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'glpat-', 'npm_', 'AKIA', 'ASIA', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'AIza'];

/**
 * `ghp_…a1b2`: a known prefix and the last four characters of a one-line value of 20 characters or
 * more, else `••••••` (PRD §9). Never more than that, so a hint can't help guess a short value.
 */
export function secretHint(value: string): string {
  const v = value.trim();
  if (v.length < 20 || /[\r\n]/.test(v)) return '••••••';
  return `${HINT_PREFIXES.find((p) => v.startsWith(p)) ?? ''}…${v.slice(-4)}`;
}

/** A secret's ID as an exposure record names it (foundation §5: `exposures.secret_ref`). */
export const exposureRef = (valueId: string) => `secret:${valueId}`;

/**
 * Secret values as immutable, encrypted versions (PRD §9, A8), in `secret_values`: revision content holds
 * only their IDs. Each new value of an entry's field is its next version, sealed under the portal's key,
 * with a keyed fingerprint (A11), a hint, its length and what it looks like. Nothing here ever returns a
 * value except `open`, which only delivery calls.
 */
export class SecretValues {
  constructor(private readonly store: Store) {}

  #row(id: string): ValueRow | undefined {
    return this.store.db?.prepare('SELECT * FROM secret_values WHERE id = ?').get(id) as ValueRow | undefined;
  }

  /** The key, or LOCKED: a portal without it can't store or deliver values (foundation §4.1). */
  #box() {
    const box = this.store.secrets;
    if (!box || !this.store.writable)
      throw new AppError('LOCKED', `Secrets are locked: ${this.store.trust.reasons.map((r) => r.message).join(' ') || 'the database is read-only.'}`);
    return box;
  }

  /**
   * Seals `value` as the next version of the entry's field and returns its ID. Runs inside the caller's
   * transaction (a pool kind's `parse`), so a failed save leaves nothing behind.
   */
  add(poolId: string, entryId: string, field: string, value: string, opts: { expiresAt?: string | null } = {}): string {
    const box = this.#box();
    const db = this.store.db!;
    const last = db
      .prepare('SELECT version, fingerprint FROM secret_values WHERE pool_id = ? AND entry_id = ? AND field = ? ORDER BY version DESC LIMIT 1')
      .get(poolId, entryId, field) as { version: number; fingerprint: string } | undefined;
    const id = newId();
    db.prepare(
      `INSERT INTO secret_values (id, pool_id, entry_id, field, version, ciphertext, fingerprint, fingerprint_key_id, prev_fingerprint, hint, byte_length, detected_type, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      poolId,
      entryId,
      field,
      (last?.version ?? 0) + 1,
      box.seal(value, slot(id)),
      box.fingerprint(value).slice(0, 8),
      box.keyId,
      last?.fingerprint ?? null,
      secretHint(value),
      Buffer.byteLength(value, 'utf8'),
      secretCredentialType(value),
      opts.expiresAt ?? null,
      new Date().toISOString(),
    );
    return id;
  }

  /** Metadata for the API (write-only, PRD §13); null for an ID that no longer exists. */
  info(id: string): SecretValueInfo | null {
    const r = this.#row(id);
    if (!r) return null;
    return {
      version: r.version,
      hint: r.hint,
      fingerprint: r.fingerprint,
      length: r.byte_length,
      type: (r.detected_type as SecretValueInfo['type']) ?? null,
      createdAt: r.created_at,
      stored: r.ciphertext !== null,
      expiresAt: r.expires_at ?? null,
      revokedAt: r.revoked_at ?? null,
    };
  }

  /**
   * The value an urgent rotation (A14) replaced this one with, or null: workspaces pinned to a revision that
   * still names the old one get the new one anyway. Only urgent rotations do that; a plain rotation lets pins hold.
   */
  supersededBy(id: string): string | null {
    const row = this.store.db?.prepare('SELECT to_value_id FROM secret_rotations WHERE from_value_id = ? AND urgent = 1 ORDER BY started_at DESC LIMIT 1').get(id) as { to_value_id: string } | undefined;
    return row?.to_value_id ?? null;
  }

  /** Marks a value revoked (FR16): never delivered, restored or pinned to again. Returns whether it changed. */
  revoke(id: string, now = new Date()): boolean {
    return Number(this.store.db!.prepare('UPDATE secret_values SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now.toISOString(), id).changes) > 0;
  }

  /** An entry field's versions, newest first. */
  versionsOf(poolId: string, entryId: string, field: string): (ValueRow & { revoked_at: string | null; expires_at: string | null })[] {
    return this.store.db!
      .prepare('SELECT * FROM secret_values WHERE pool_id = ? AND entry_id = ? AND field = ? ORDER BY version DESC')
      .all(poolId, entryId, field) as unknown as (ValueRow & { revoked_at: string | null; expires_at: string | null })[];
  }

  /** The row behind an ID, for the tracker and revocation. */
  row(id: string): (ValueRow & { revoked_at: string | null; expires_at: string | null }) | undefined {
    return this.#row(id) as (ValueRow & { revoked_at: string | null; expires_at: string | null }) | undefined;
  }

  /** Clears a value's ciphertext (FR18: purged once nothing uses it). Returns whether anything was cleared. */
  purge(id: string, now = new Date()): boolean {
    return Number(this.store.db!.prepare('UPDATE secret_values SET ciphertext = NULL, purge_after = ? WHERE id = ? AND ciphertext IS NOT NULL').run(now.toISOString(), id).changes) > 0;
  }

  /** When a value was revoked (FR16, FR18), or null: a revoked version is never delivered, restored or pinned to. */
  revokedAt(id: string): string | null {
    return (this.store.db?.prepare('SELECT revoked_at FROM secret_values WHERE id = ?').get(id) as { revoked_at: string | null } | undefined)?.revoked_at ?? null;
  }

  /**
   * The newest version of an entry's field: what "keeps its current version" means for an entry the
   * current revision no longer has, when a roll back brings the entry back (FR18). Null when it has none.
   */
  newest(poolId: string, entryId: string, field: string): { id: string; version: number; revokedAt: string | null; stored: boolean } | null {
    const r = this.store.db
      ?.prepare('SELECT id, version, revoked_at, ciphertext FROM secret_values WHERE pool_id = ? AND entry_id = ? AND field = ? ORDER BY version DESC LIMIT 1')
      .get(poolId, entryId, field) as { id: string; version: number; revoked_at: string | null; ciphertext: string | null } | undefined;
    return r ? { id: r.id, version: r.version, revokedAt: r.revoked_at, stored: r.ciphertext !== null } : null;
  }

  /** Whether the value belongs to `poolId` (a duplicated set's revision still names its source's values). */
  belongsTo(id: string, poolId: string): boolean {
    return this.#row(id)?.pool_id === poolId;
  }

  /**
   * The value itself, for delivery only: it travels on in archive bodies (FR11). Throws, without the value
   * or ciphertext in the message, when it's gone, cleared by `portal forget-secrets`, or sealed with
   * another key.
   */
  open(id: string): string {
    const box = this.#box();
    const r = this.#row(id);
    if (!r) throw new Error('its value no longer exists');
    if (r.ciphertext === null) throw new Error('its value was cleared (portal forget-secrets); enter it again');
    try {
      return box.open(r.ciphertext, slot(id));
    } catch {
      throw new Error('its value does not open with this portal’s key');
    }
  }
}
