// The person's own profile (owner request 2026-11-01: "refine user information as well, and profile"; identity-onboarding PRD "Profile").
// A person changes only their OWN name, handle and picture here: every method takes the signed-in account's id from the session, never from
// the request. Pictures go through the persona pipeline (personas/avatar.ts: PNG, JPEG or WebP, re-encoded square, metadata stripped,
// content-addressed) into a table of their own (user_avatars, migration 407).
//
// SSO fills the profile from the provider's claims (name, preferred_username, picture) on a sign-in, but never what the person set: a name
// they (or an admin) gave sets name_locked, a picture they chose or removed sets avatar_locked, and a username is only filled while empty.

import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  DISPLAY_NAME_MAX,
  normalizeUsername,
  PORTAL_USER_API,
  usernameProblem,
  type LinkedSignIn,
  type MyProfile,
  type PersonSummary,
  type UpdateMyProfileRequest,
} from '@portal/contracts';
import { normalizeAvatar } from '../personas/avatar.js';

interface ProfileRow {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'member';
  founder: number;
  password_set: number;
  username: string | null;
  avatar: string | null;
  name_locked: number;
  avatar_locked: number;
  avatar_source_url: string | null;
  created_at: string;
  last_login_at: string | null;
}

/** What an SSO sign-in's ID token said about the person (identity/sso.ts `SsoResult.profile`). Untrusted text: cleaned before use. */
export interface IdpClaims {
  name?: string | null;
  preferredUsername?: string | null;
  picture?: string | null;
  /** The provider may be on a private network (its `allow_private_network`): the picture is fetched under the same rule. */
  allowPrivate: boolean;
}

/** Fetches an image through the SSRF guard (oidc.ts `fetchImage`), at most `maxBytes`. */
export type ImageFetch = (url: string, allowPrivate: boolean) => Promise<Buffer>;

const clean = (s: string) => s.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
const avatarUrl = (sha: string | null) => (sha ? PORTAL_USER_API.avatar(sha) : null);

export class PortalProfiles {
  constructor(
    private readonly db: () => DatabaseSync | null,
    private readonly writable: () => DatabaseSync | null,
    private readonly fetchImage: ImageFetch | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  #db(): DatabaseSync {
    const db = this.db();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is not available.');
    return db;
  }

  #w(): DatabaseSync {
    const db = this.writable();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    return db;
  }

  #row(id: string): ProfileRow {
    const r = this.#db().prepare('SELECT * FROM users WHERE id = ?').get(id) as ProfileRow | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'No such account.');
    return r;
  }

  /** A provider's name by id, or null (removed). */
  providerName(id: string): string | null {
    const r = this.db()?.prepare('SELECT name FROM sso_providers WHERE id = ?').get(id) as { name: string } | undefined;
    return r?.name ?? null;
  }

  #signIns(userId: string): LinkedSignIn[] {
    const rows = this.#db()
      .prepare(
        `SELECT i.provider_id, p.name, i.email, i.linked_at, i.last_login_at FROM sso_identities i LEFT JOIN sso_providers p ON p.id = i.provider_id
         WHERE i.user_id = ? ORDER BY i.linked_at`,
      )
      .all(userId) as { provider_id: string; name: string | null; email: string; linked_at: string; last_login_at: string | null }[];
    return rows.map((r) => ({ providerId: r.provider_id, provider: r.name ?? 'A removed provider', email: r.email, linkedAt: r.linked_at, lastUsedAt: r.last_login_at }));
  }

  /** The account as its own Profile shows it. */
  profile(userId: string): MyProfile {
    const r = this.#row(userId);
    return {
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      username: r.username,
      avatar: avatarUrl(r.avatar),
      role: r.role,
      founder: r.founder === 1,
      passwordSet: r.password_set !== 0,
      signIns: this.#signIns(r.id),
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    };
  }

  /** The founder account (users.founder = 1), shown on a server-code session; null when there is none. */
  founder(): PersonSummary | null {
    const r = this.db()?.prepare('SELECT * FROM users WHERE founder = 1').get() as ProfileRow | undefined;
    return r ? { displayName: r.display_name, email: r.email, username: r.username, avatar: avatarUrl(r.avatar) } : null;
  }

  /** The person changes their own name and handle. Every check runs before anything is written. */
  update(userId: string, req: Partial<UpdateMyProfileRequest>): MyProfile {
    this.#row(userId);
    let name: string | undefined;
    if (req.displayName !== undefined) {
      name = typeof req.displayName === 'string' ? clean(req.displayName) : '';
      if (!name || name.length > DISPLAY_NAME_MAX)
        throw new AppError('VALIDATION_FAILED', `A name of 1 to ${DISPLAY_NAME_MAX} characters.`, { details: { displayName: `1 to ${DISPLAY_NAME_MAX} characters.` } });
    }
    let username: { value: string | null; key: string | null } | undefined;
    if (req.username === null || req.username === '') username = { value: null, key: null };
    else if (req.username !== undefined) {
      const raw = typeof req.username === 'string' ? req.username : '';
      const problem = usernameProblem(raw);
      if (problem === 'format')
        throw new AppError('VALIDATION_FAILED', '3 to 32 characters: a-z, 0-9, dot, dash, underscore; starts with a letter.', { details: { username: 'Not a username.' } });
      const key = normalizeUsername(raw);
      const taken = this.#db().prepare('SELECT 1 FROM users WHERE username_key = ? AND id != ?').get(key, userId);
      // A reserved name and a taken one get the same answer (nothing says which).
      if (problem === 'reserved' || taken) throw new AppError('CONFLICT', 'That username isn’t available.', { details: { username: 'Not available.' } });
      username = { value: key, key };
    }
    const db = this.#w();
    db.exec('BEGIN');
    try {
      if (name !== undefined) db.prepare('UPDATE users SET display_name = ?, name_locked = 1 WHERE id = ?').run(name, userId);
      if (username) db.prepare('UPDATE users SET username = ?, username_key = ? WHERE id = ?').run(username.value, username.key, userId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      if (/UNIQUE/i.test(String((e as Error).message))) throw new AppError('CONFLICT', 'That username isn’t available.', { details: { username: 'Not available.' } });
      throw e;
    }
    return this.profile(userId);
  }

  #store(png: Buffer, sha: string, side: number): void {
    this.#w().prepare('INSERT INTO user_avatars (sha256, png, side, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING').run(sha, png, side, this.now().toISOString());
  }

  /** Pictures no account refers to any more. */
  #sweep(): void {
    this.writable()?.prepare('DELETE FROM user_avatars WHERE sha256 NOT IN (SELECT avatar FROM users WHERE avatar IS NOT NULL)').run();
  }

  /** The person's own picture from an upload: re-encoded, kept, and never replaced by the provider's again. Returns its URL. */
  async setAvatar(userId: string, bytes: Buffer): Promise<string> {
    this.#row(userId);
    const a = await normalizeAvatar(bytes);
    this.#store(a.png, a.sha256, a.side);
    this.#w().prepare('UPDATE users SET avatar = ?, avatar_locked = 1 WHERE id = ?').run(a.sha256, userId);
    this.#sweep();
    return avatarUrl(a.sha256)!;
  }

  /** The person removes their picture (initials again); a removal is a choice too, so the provider's picture does not come back. */
  clearAvatar(userId: string): void {
    this.#row(userId);
    this.#w().prepare('UPDATE users SET avatar = NULL, avatar_locked = 1 WHERE id = ?').run(userId);
    this.#sweep();
  }

  /** A kept picture by its hash, or null. */
  avatarPng(sha: string): Buffer | null {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    const r = this.db()?.prepare('SELECT png FROM user_avatars WHERE sha256 = ?').get(sha) as { png: Uint8Array } | undefined;
    return r ? Buffer.from(r.png) : null;
  }

  /**
   * After an SSO sign-in: fills what the person has not set from the provider's claims. The name while `name_locked` is 0, the username
   * while it is empty (a valid, free one only), the picture while `avatar_locked` is 0 and the provider names a new https URL. Best effort:
   * a picture that cannot be fetched or read is skipped, and nothing here fails the sign-in.
   */
  async adoptClaims(userId: string, claims: IdpClaims): Promise<void> {
    let r: ProfileRow;
    try {
      r = this.#row(userId);
    } catch {
      return;
    }
    const db = this.writable();
    if (!db) return;
    const name = typeof claims.name === 'string' ? clean(claims.name).slice(0, DISPLAY_NAME_MAX) : '';
    if (name && r.name_locked === 0 && name !== r.display_name) db.prepare('UPDATE users SET display_name = ? WHERE id = ? AND name_locked = 0').run(name, userId);
    const handle = typeof claims.preferredUsername === 'string' ? claims.preferredUsername : '';
    if (!r.username && handle && usernameProblem(handle) === null) {
      const key = normalizeUsername(handle);
      try {
        db.prepare('UPDATE users SET username = ?, username_key = ? WHERE id = ? AND username IS NULL').run(key, key, userId);
      } catch {
        // Taken by another account: left empty; the person picks one on their Profile.
      }
    }
    const picture = typeof claims.picture === 'string' ? claims.picture.trim() : '';
    if (!picture || r.avatar_locked === 1 || picture === r.avatar_source_url || !this.fetchImage) return;
    let url: URL;
    try {
      url = new URL(picture);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' || url.username || url.password || picture.length > 2048) return;
    try {
      const a = await normalizeAvatar(await this.fetchImage(url.href, claims.allowPrivate));
      this.#store(a.png, a.sha256, a.side);
      db.prepare('UPDATE users SET avatar = ?, avatar_source_url = ? WHERE id = ? AND avatar_locked = 0').run(a.sha256, picture, userId);
      this.#sweep();
    } catch (e) {
      // The URL may carry a provider's signed query: only the host is logged.
      console.log(`[portal] SSO picture from ${url.host} not used: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`);
    }
  }
}
