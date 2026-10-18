import { createHash, randomBytes } from 'node:crypto';
import { PORTAL_MANAGER_TOKEN_PREFIX } from '@portal/contracts';
import type { Store } from '../store/store.js';
import { AGENT_TOKEN_TTL_MS } from './agents.js';
import type { PortalPrincipal } from './registry.js';

// The General Manager's token (T-968 S1, general-manager PRD §4). The portal mints a `cpmt_` token for the person's one manager
// session when its process starts; it goes only into that process's environment (`PILOT_MCP_TOKEN`), is hashed at rest and lives
// at most 7 days (as an agent's). It is not an agent token: its principal is the PERSON (`userId`), and `actorOfPrincipal` hands
// can() the person's own user actor, resolved on every call. `manager:<session id>` is an audit label only. It is revoked on
// disable, on remove, and on ANY sign-out of the person, on any device (Q3, #11136: Portal.onSignedOut, wired in index.ts).

const TOUCH_EVERY_MS = 60_000;
const hashOf = (secret: string) => createHash('sha256').update(secret).digest('hex');

export type ManagerVerify =
  | { ok: true; principal: PortalPrincipal }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' | 'ended'; tokenId?: string };

export interface ManagerTokensOptions {
  /** Whether the manager session is still running (exists, not ended, not archived). Default: no session is, so no token passes. */
  alive?: (sessionId: string) => boolean;
  now?: () => Date;
}

interface Row {
  id: string;
  user_id: string;
  session_id: string;
  expires_at: string;
  revoked_at: string | null;
}

export class ManagerTokens {
  readonly #touched = new Map<string, number>();
  onChange?: () => void;

  constructor(
    private readonly store: Store,
    private readonly o: ManagerTokensOptions = {},
  ) {}

  get #now(): Date {
    return (this.o.now ?? (() => new Date()))();
  }

  get #writable() {
    return this.store.writable ? this.store.db : null;
  }

  /** A fresh token for the person's manager session; the session's older tokens stop working. Null on a database that can't be written. */
  mint(req: { userId: string; sessionId: string }, opts: { keepOthers?: boolean } = {}): { tokenId: string; secret: string; expiresAt: string } | null {
    const db = this.#writable;
    if (!db) return null;
    // As an agent token (agents.ts settle): with keepOthers the old token stays good until the launch says a new process started; a start that
    // attached to the running process must not cut it off.
    if (!opts.keepOthers) this.revokeSession(req.sessionId, 'replaced by a new token');
    const secret = `${PORTAL_MANAGER_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = `mgt_${randomBytes(6).toString('hex')}`;
    const now = this.#now;
    const expiresAt = new Date(now.getTime() + AGENT_TOKEN_TTL_MS).toISOString();
    db.prepare('INSERT INTO pmcp_manager_tokens (id, token_hash, user_id, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      hashOf(secret),
      req.userId,
      req.sessionId,
      now.toISOString(),
      expiresAt,
    );
    this.onChange?.();
    return { tokenId: id, secret, expiresAt };
  }

  #revoke(where: string, args: string[], reason: string): number {
    const db = this.#writable;
    if (!db) return 0;
    const r = db
      .prepare(`UPDATE pmcp_manager_tokens SET revoked_at = ?, revoked_reason = ? WHERE ${where} AND revoked_at IS NULL`)
      .run(this.#now.toISOString(), reason, ...args);
    if (r.changes > 0) this.onChange?.();
    return Number(r.changes);
  }

  /** After a launch with keepOthers: a new process started (the others go) or not (the unused new one goes). */
  settle(sessionId: string, tokenId: string, started: boolean): void {
    if (started) this.#revoke('session_id = ? AND id != ?', [sessionId, tokenId], 'replaced by a new token');
    else this.#revoke('id = ?', [tokenId], 'its launch started no new process');
  }

  /** Whether the manager session holds a token that still works (not revoked, not expired). */
  hasLive(sessionId: string): boolean {
    return !!this.store.db
      ?.prepare('SELECT 1 FROM pmcp_manager_tokens WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1')
      .get(sessionId, this.#now.toISOString());
  }

  /** The manager was disabled or removed, or its process was replaced. */
  revokeSession(sessionId: string, reason: string): number {
    return this.#revoke('session_id = ?', [sessionId], reason);
  }

  /** The person signed out on any device (Q3, #11136), or their account went: their manager stops acting for them. */
  revokeUser(userId: string, reason: string): number {
    return this.#revoke('user_id = ?', [userId], reason);
  }

  /** A lockdown, or "revoke all". */
  revokeAll(reason: string): number {
    return this.#revoke('1 = 1', [], reason);
  }

  /** Checks a bearer token: a `cpmt_` that exists, wasn't revoked, hasn't expired, and whose session still runs. */
  verify(secret: string): ManagerVerify {
    if (!secret.startsWith(PORTAL_MANAGER_TOKEN_PREFIX) || secret.length < 20 || secret.length > 128) return { ok: false, reason: 'unknown' };
    const row = this.store.db
      ?.prepare('SELECT id, user_id, session_id, expires_at, revoked_at FROM pmcp_manager_tokens WHERE token_hash = ?')
      .get(hashOf(secret)) as Row | undefined;
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.revoked_at) return { ok: false, reason: 'revoked', tokenId: row.id };
    const now = this.#now;
    if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: 'expired', tokenId: row.id };
    if (!(this.o.alive ?? (() => false))(row.session_id)) {
      this.#revoke('id = ?', [row.id], 'its session ended');
      return { ok: false, reason: 'ended', tokenId: row.id };
    }
    this.#touch(row.id, now);
    return {
      ok: true,
      principal: {
        kind: 'manager',
        tokenId: row.id,
        label: 'General Manager',
        // The tool tier until S5's confirmation card: reads and operate-tier writes; an admin-tier tool is refused (PRD §4: never with the
        // model's confirm_token alone). can() still decides every object as the person.
        scope: 'operate',
        userId: row.user_id,
        workspaceId: null,
        sessionId: row.session_id,
        expiresAt: row.expires_at,
        client: null,
        vaults: null,
      },
    };
  }

  #touch(id: string, now: Date) {
    if (now.getTime() - (this.#touched.get(id) ?? 0) < TOUCH_EVERY_MS) return;
    this.#touched.set(id, now.getTime());
    try {
      this.#writable?.prepare('UPDATE pmcp_manager_tokens SET last_used_at = ? WHERE id = ?').run(now.toISOString(), id);
    } catch {
      // bookkeeping only
    }
  }
}
