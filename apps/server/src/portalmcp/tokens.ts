import { createHash, randomBytes } from 'node:crypto';
import { AppError, defineErrorCodes } from '@isnanme/core';
import {
  PORTAL_SCOPES,
  PORTAL_TOKEN_CAP,
  PORTAL_TOKEN_CAP_DEFAULT,
  PORTAL_TOKEN_DAYS,
  PORTAL_TOKEN_LABEL_IN_USE,
  PORTAL_TOKEN_LABEL_MAX,
  PORTAL_TOKEN_LIFETIMES,
  PORTAL_TOKEN_LIFETIME_MS,
  PORTAL_TOKEN_PREFIX,
  type CreatePortalTokenRequest,
  type PortalScope,
  type PortalToken,
  type PortalTokenLabelConflict,
  type PortalTokenLifetime,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { PortalPrincipal } from './registry.js';
import { cleanText, looksLikeSecret } from './sanitize.js';

interface Row {
  id: string;
  label: string;
  token_hash: string;
  last4: string;
  scope: PortalScope;
  vaults: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  default_workspace_id: string | null;
  client?: string | null;
  client_instance?: string | null;
}

/** T-1974: a token issued to a first-party client by its device flow, and the installation that signed in (replaced only by itself). */
export interface ClientTokenOrigin {
  client: 'vscode';
  /** The installation's own id, or null when the client sent none (then nothing is replaced). */
  instance: string | null;
}

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    TOKEN_LABEL_IN_USE: true;
    TOKEN_CAP: true;
  }
}
defineErrorCodes({
  [PORTAL_TOKEN_LABEL_IN_USE]: { status: 409, message: 'Live tokens with this label exist.' },
  [PORTAL_TOKEN_CAP]: { status: 409, message: 'This label has as many live admin tokens as allowed.' },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const LIFETIMES_TEXT = '15 minutes, 1 hour, 1 day, 7, 30, 90 or 365 days';

/** How long a new token lives: `expiresIn` (`15m` … `365d`) or the older `expiresInDays`; 90 days when neither is given. */
export function lifetimeMs(req: Partial<CreatePortalTokenRequest>): number {
  if (req.expiresIn !== undefined) {
    if (req.expiresInDays !== undefined)
      throw new AppError('VALIDATION_FAILED', 'Give expiresIn or expiresInDays, not both.', { details: { expiresIn: 'Not with expiresInDays.' } });
    if (!(PORTAL_TOKEN_LIFETIMES as readonly unknown[]).includes(req.expiresIn))
      throw new AppError('VALIDATION_FAILED', `Pick ${LIFETIMES_TEXT}.`, { details: { expiresIn: `One of ${PORTAL_TOKEN_LIFETIMES.join(', ')}.` } });
    return PORTAL_TOKEN_LIFETIME_MS[req.expiresIn as PortalTokenLifetime];
  }
  const days = req.expiresInDays ?? 90;
  if (!(PORTAL_TOKEN_DAYS as readonly number[]).includes(days))
    throw new AppError('VALIDATION_FAILED', `Pick ${PORTAL_TOKEN_DAYS.join(', ')} days.`, { details: { expiresInDays: `One of ${PORTAL_TOKEN_DAYS.join(', ')}.` } });
  return days * DAY_MS;
}

export interface CreateTokenRules {
  /** Live admin-scope tokens one label may have (the setting `mcp.tokens.maxActivePerLabel`). */
  maxAdminPerLabel?: number;
}
/** `last_used_at` is written at most this often per token: a busy script must not turn every call into a write. */
const TOUCH_EVERY_MS = 60_000;

export const hashToken = (secret: string): string => createHash('sha256').update(secret).digest('hex');

/** `cpat_` plus 43 base64url characters: 256 random bits. */
export const newTokenSecret = (): string => `${PORTAL_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

const preview = (last4: string) => `${PORTAL_TOKEN_PREFIX}…${last4}`;

function view(r: Row): PortalToken {
  return {
    id: r.id,
    label: r.label,
    preview: preview(r.last4),
    scope: r.scope,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    lastUsedIp: r.last_used_ip,
    revokedAt: r.revoked_at,
    revokedReason: r.revoked_reason,
    defaultWorkspaceId: r.default_workspace_id ?? null,
    client: r.client === 'vscode' ? 'vscode' : null,
  };
}

function vaultsOf(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export type VerifyResult =
  | { ok: true; principal: PortalPrincipal; token: PortalToken }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired'; tokenId?: string };

/**
 * An admin's personal access tokens (portal-mcp PRD §12.1). Only the SHA-256 of a token is stored, so a token is
 * shown once, at creation, and can't be recovered. Reads work while the portal is Locked (the hash needs no
 * key); the bookkeeping writes (last used) are skipped while the database is read-only. Agents' per-session
 * tokens are a separate class (agents.ts).
 */
export class PortalTokens {
  readonly #touched = new Map<string, number>();
  /** Called after any change, for pages that list tokens. */
  onChange?: () => void;

  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get #db() {
    return this.store.db;
  }

  get #writable() {
    return this.store.writable ? this.store.db : null;
  }

  list(): PortalToken[] {
    const rows = this.#db?.prepare('SELECT * FROM pmcp_tokens ORDER BY created_at DESC, id DESC LIMIT 200').all() as unknown as Row[] | undefined;
    return (rows ?? []).map(view);
  }

  get(id: string): PortalToken | null {
    const row = this.#db?.prepare('SELECT * FROM pmcp_tokens WHERE id = ?').get(id) as Row | undefined;
    return row ? view(row) : null;
  }

  /** Tokens that can still be used right now. */
  activeCount(): number {
    const row = this.#db?.prepare('SELECT count(*) AS n FROM pmcp_tokens WHERE revoked_at IS NULL AND expires_at > ?').get(this.now().toISOString()) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Live tokens with exactly this label, newest first. */
  liveWithLabel(label: string): PortalToken[] {
    const rows = this.#db
      ?.prepare('SELECT * FROM pmcp_tokens WHERE label = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC, rowid DESC')
      .all(label, this.now().toISOString()) as unknown as Row[] | undefined;
    return (rows ?? []).map(view);
  }

  /**
   * Makes a token. Returns the view, the secret (which exists nowhere else) and the ids of the tokens a `replace` revoked, for the
   * caller's audit rows.
   */
  create(req: Partial<CreatePortalTokenRequest>, rules: CreateTokenRules = {}, origin?: ClientTokenOrigin): { token: PortalToken; secret: string; replaced: string[] } {
    const db = this.#writable;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    const label = typeof req.label === 'string' ? req.label.trim() : '';
    if (!label)
      throw new AppError('VALIDATION_FAILED', 'Give the token a label: it is the name shown wherever this client acts (chats, tickets, CI, audit).', { details: { label: 'Required.' } });
    // One line of plain text: it is shown as the sender of messages, so no line breaks, control characters or markup brackets.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029"<>]/.test(label))
      throw new AppError('VALIDATION_FAILED', 'Use one line of plain text: no line breaks, quotes or angle brackets.', { details: { label: 'One line, plain text.' } });
    if (label.length > PORTAL_TOKEN_LABEL_MAX)
      throw new AppError('VALIDATION_FAILED', `Use at most ${PORTAL_TOKEN_LABEL_MAX} characters.`, { details: { label: `At most ${PORTAL_TOKEN_LABEL_MAX} characters.` } });
    if (looksLikeSecret(label)) throw new AppError('VALIDATION_FAILED', 'That label looks like a secret. Name the token after what uses it.', { details: { label: 'Not a secret.' } });
    if (!req.scope || !PORTAL_SCOPES.includes(req.scope)) throw new AppError('VALIDATION_FAILED', 'Pick read, operate or admin.', { details: { scope: 'Pick a scope.' } });
    const ttl = lifetimeMs(req);
    if (req.replace !== undefined && typeof req.replace !== 'boolean') throw new AppError('VALIDATION_FAILED', '`replace` must be true or false.', { details: { replace: 'Use true or false.' } });
    if (req.addAnother !== undefined && typeof req.addAnother !== 'boolean') throw new AppError('VALIDATION_FAILED', '`addAnother` must be true or false.', { details: { addAnother: 'Use true or false.' } });
    if (req.replace && req.addAnother) throw new AppError('VALIDATION_FAILED', 'Pick replace or addAnother, not both.', { details: { replace: 'Not with addAnother.' } });

    // A label names one client (T-258): live tokens with it are refused unless the request says replace (revoke them) or addAnother
    // (keep them; admin scope only up to the cap). Agents' per-session tokens are another table (agents.ts) and none of this applies to them.
    const name = cleanText(label, PORTAL_TOKEN_LABEL_MAX);
    const live = this.liveWithLabel(name);
    const conflict = (rows: PortalToken[], max?: number): PortalTokenLabelConflict => ({
      label: name,
      live: rows.length,
      newest: { id: rows[0]!.id, expiresAt: rows[0]!.expiresAt },
      ...(max !== undefined ? { max } : {}),
    });
    if (live.length > 0 && !req.replace && !req.addAnother)
      throw new AppError(PORTAL_TOKEN_LABEL_IN_USE, `“${name}” has ${live.length} live token${live.length === 1 ? '' : 's'}. Replace ${live.length === 1 ? 'it' : 'them'}, add another or pick another label.`, { details: conflict(live) });
    const max = Math.max(1, Math.floor(rules.maxAdminPerLabel ?? PORTAL_TOKEN_CAP_DEFAULT));
    const liveAdmin = live.filter((t) => t.scope === 'admin');
    if (req.scope === 'admin' && req.addAnother && liveAdmin.length >= max)
      throw new AppError(PORTAL_TOKEN_CAP, `“${name}” has ${liveAdmin.length} live admin tokens, the most allowed (${max}). Revoke older ones or replace them.`, { details: conflict(liveAdmin, max) });

    const now = this.now();
    const replaced: string[] = [];
    // A client's sign-in replaces the token of the same installation only (never another one that happens to carry the same name).
    if (origin?.instance) {
      const mine = this.#db
        ?.prepare('SELECT id FROM pmcp_tokens WHERE client = ? AND client_instance = ? AND revoked_at IS NULL AND expires_at > ?')
        .all(origin.client, origin.instance, now.toISOString()) as { id: string }[] | undefined;
      const stmt = db.prepare('UPDATE pmcp_tokens SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL');
      for (const t of mine ?? []) if (stmt.run(now.toISOString(), 'replaced by a new sign-in from the same installation', t.id).changes > 0) replaced.push(t.id);
    }
    if (req.replace) {
      const stmt = db.prepare('UPDATE pmcp_tokens SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL');
      for (const t of live) if (stmt.run(now.toISOString(), 'replaced by a new token with this label', t.id).changes > 0) replaced.push(t.id);
    }
    const secret = newTokenSecret();
    const id = `ptk_${randomBytes(6).toString('hex')}`;
    db.prepare(
      `INSERT INTO pmcp_tokens (id, label, token_hash, last4, scope, purpose, created_at, expires_at, client, client_instance)
       VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, ?)`,
    ).run(id, name, hashToken(secret), secret.slice(-4), req.scope, now.toISOString(), new Date(now.getTime() + ttl).toISOString(), origin?.client ?? null, origin?.instance ?? null);
    this.onChange?.();
    return { token: this.get(id)!, secret, replaced };
  }

  /** Checks a bearer token: whether it exists, wasn't revoked and hasn't expired, and who it is. */
  verify(secret: string, ip?: string): VerifyResult {
    if (!secret.startsWith(PORTAL_TOKEN_PREFIX) || secret.length < 20 || secret.length > 128) return { ok: false, reason: 'unknown' };
    const row = this.#db?.prepare('SELECT * FROM pmcp_tokens WHERE token_hash = ?').get(hashToken(secret)) as Row | undefined;
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.revoked_at) return { ok: false, reason: 'revoked', tokenId: row.id };
    const now = this.now();
    if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: 'expired', tokenId: row.id };
    this.#touch(row.id, ip, now);
    return {
      ok: true,
      token: view(row),
      principal: {
        kind: 'user',
        tokenId: row.id,
        label: row.label,
        scope: row.scope,
        workspaceId: null,
        sessionId: null,
        expiresAt: row.expires_at,
        client: null,
        vaults: vaultsOf(row.vaults),
        defaultWorkspaceId: row.default_workspace_id ?? null,
      },
    };
  }

  #touch(id: string, ip: string | undefined, now: Date) {
    const last = this.#touched.get(id) ?? 0;
    if (now.getTime() - last < TOUCH_EVERY_MS) return;
    this.#touched.set(id, now.getTime());
    try {
      this.#writable?.prepare('UPDATE pmcp_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(now.toISOString(), ip ?? null, id);
    } catch {
      // bookkeeping only: a database that can't be written must not fail the call
    }
  }

  /**
   * T-1105: sets (or with null clears) where the token's tickets go when a call names no workspace. The caller (module.ts) has checked the
   * person's manage on the token and that the workspace is one they and the token may operate. False when the token is gone or not live.
   */
  setDefaultWorkspace(id: string, workspaceId: string | null): boolean {
    const db = this.#writable;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    const r = db
      .prepare('UPDATE pmcp_tokens SET default_workspace_id = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?')
      .run(workspaceId, id, this.now().toISOString());
    if (r.changes > 0) this.onChange?.();
    return r.changes > 0;
  }

  /** Revokes one token: it fails on its next request. False when it was already revoked or doesn't exist. */
  revoke(id: string, reason = 'revoked in the portal'): boolean {
    const db = this.#writable;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    const r = db.prepare('UPDATE pmcp_tokens SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL').run(this.now().toISOString(), reason, id);
    if (r.changes > 0) this.onChange?.();
    return r.changes > 0;
  }

  /** Revokes the live tokens with this label, or all but the newest with `keepNewest`; returns the ids it revoked. */
  revokeLabel(label: string, keepNewest: boolean, reason: string): string[] {
    const db = this.#writable;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    const live = this.liveWithLabel(label);
    const stmt = db.prepare('UPDATE pmcp_tokens SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL');
    const at = this.now().toISOString();
    const done = (keepNewest ? live.slice(1) : live).filter((t) => stmt.run(at, reason, t.id).changes > 0).map((t) => t.id);
    if (done.length > 0) this.onChange?.();
    return done;
  }

  /** Revokes every token that is still live; returns how many. */
  revokeAll(reason: string): number {
    const db = this.#writable;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    const r = db.prepare('UPDATE pmcp_tokens SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL').run(this.now().toISOString(), reason);
    if (r.changes > 0) this.onChange?.();
    return Number(r.changes);
  }
}
