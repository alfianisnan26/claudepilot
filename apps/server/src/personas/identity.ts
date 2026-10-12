import { AppError } from '@isnanme/core';
import { PERSONAS_API, type PersonaIdentity, type PersonaPolicy, type PersonaPoolInfo } from '@portal/contracts';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import type { Avatar } from './avatar.js';

/** A persona's own record besides its revisions (Persona PRD A10): the avatar, the self-edit switches and the default flag. */
export interface PersonaMeta {
  avatar: string | null;
  agentsMayPropose: boolean;
  autoApproveCosmetic: boolean;
  isDefault: boolean;
}

const NO_META: PersonaMeta = { avatar: null, agentsMayPropose: false, autoApproveCosmetic: false, isDefault: false };
const DAY_MS = 24 * 60 * 60 * 1000;
/** A proposal's image is kept this long after the proposal is decided, so its card still shows what was proposed. */
const DECIDED_KEEP_MS = 30 * DAY_MS;

/**
 * What makes a persona someone on screen (interface I11): its name (the pool's), an avatar, the switches that
 * let agents propose changes to it, and whether it's the persona new workspaces start with. None of this is
 * part of a revision, so none of it is delivered into a workspace and none of it waits for a publish.
 */
export class PersonaIdentityStore {
  constructor(
    private readonly store: Store,
    private readonly pools: PoolService,
  ) {}

  get #db() {
    const db = this.store.db;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not available.');
    return db;
  }

  get #writable() {
    if (!this.store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not writable.');
    return this.#db;
  }

  #persona(poolId: string): void {
    if (this.pools.typeOf(poolId) !== 'persona') throw new AppError('NOT_FOUND', 'That persona no longer exists.');
  }

  meta(poolId: string): PersonaMeta {
    const row = this.#db.prepare('SELECT avatar, agents_may_propose, auto_approve_cosmetic, is_default FROM persona_meta WHERE pool_id = ?').get(poolId) as
      | { avatar: string | null; agents_may_propose: number; auto_approve_cosmetic: number; is_default: number }
      | undefined;
    return row ? { avatar: row.avatar, agentsMayPropose: !!row.agents_may_propose, autoApproveCosmetic: !!row.auto_approve_cosmetic, isDefault: !!row.is_default } : { ...NO_META };
  }

  /** Creates the row on first use. */
  #touch(poolId: string) {
    this.#writable.prepare('INSERT INTO persona_meta (pool_id, updated_at) VALUES (?, ?) ON CONFLICT (pool_id) DO NOTHING').run(poolId, new Date().toISOString());
  }

  policy(poolId: string, portalAllows: boolean): PersonaPolicy {
    this.#persona(poolId);
    const m = this.meta(poolId);
    return { agentsMayPropose: m.agentsMayPropose, autoApproveCosmetic: m.autoApproveCosmetic, portalAllows, isDefault: m.isDefault, avatar: this.avatarUrl(m.avatar) };
  }

  /** What each persona's card shows besides its revisions: avatar, default flag, the agents' switch and the proposals waiting. */
  poolInfos(): PersonaPoolInfo[] {
    const rows = this.#db
      .prepare(
        `SELECT p.id, m.avatar, m.is_default, m.agents_may_propose,
                (SELECT count(*) FROM persona_proposals q WHERE q.pool_id = p.id AND q.status = 'pending') AS pending
         FROM pools p LEFT JOIN persona_meta m ON m.pool_id = p.id WHERE p.type = 'persona' ORDER BY p.created_at, p.name`,
      )
      .all() as { id: string; avatar: string | null; is_default: number | null; agents_may_propose: number | null; pending: number }[];
    return rows.map((r) => ({ poolId: r.id, avatar: this.avatarUrl(r.avatar), isDefault: !!r.is_default, agentsMayPropose: !!r.agents_may_propose, pendingProposals: Number(r.pending) }));
  }

  /**
   * The self-edit switches. Auto-approval only means something while agents may propose, so turning proposals
   * off turns it off too.
   */
  setPolicy(poolId: string, patch: { agentsMayPropose?: boolean; autoApproveCosmetic?: boolean }): PersonaMeta {
    this.#persona(poolId);
    this.#touch(poolId);
    const now = this.meta(poolId);
    const may = patch.agentsMayPropose ?? now.agentsMayPropose;
    const auto = may && (patch.autoApproveCosmetic ?? now.autoApproveCosmetic);
    this.#writable.prepare('UPDATE persona_meta SET agents_may_propose = ?, auto_approve_cosmetic = ?, updated_at = ? WHERE pool_id = ?').run(may ? 1 : 0, auto ? 1 : 0, new Date().toISOString(), poolId);
    this.pools.onChange();
    return this.meta(poolId);
  }

  /* ---------- Avatars ---------- */

  /** Keeps a normalized avatar (once per content) and returns its address. */
  putAvatar(a: Avatar): string {
    this.#writable.prepare('INSERT INTO persona_avatars (sha256, png, size, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING').run(a.sha256, a.png, a.side, new Date().toISOString());
    return a.sha256;
  }

  avatarPng(sha: string): Buffer | null {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    const row = this.#db.prepare('SELECT png FROM persona_avatars WHERE sha256 = ?').get(sha) as { png: Uint8Array } | undefined;
    return row ? Buffer.from(row.png) : null;
  }

  hasAvatar(sha: string): boolean {
    return !!this.#db.prepare('SELECT 1 FROM persona_avatars WHERE sha256 = ?').get(sha);
  }

  avatarUrl(sha: string | null): string | null {
    return sha ? PERSONAS_API.avatar(sha) : null;
  }

  /** Sets or clears (`null`) the persona's avatar. The image has to be kept already (`putAvatar`). */
  setAvatar(poolId: string, sha: string | null): void {
    this.#persona(poolId);
    if (sha !== null && !this.hasAvatar(sha)) throw new AppError('NOT_FOUND', 'That image is gone: upload it again.');
    this.#touch(poolId);
    this.#writable.prepare('UPDATE persona_meta SET avatar = ?, updated_at = ? WHERE pool_id = ?').run(sha, new Date().toISOString(), poolId);
    this.collect();
    this.pools.onChange();
  }

  /** Deletes avatars nothing refers to: not a persona's, not a proposal's that is pending or was decided recently. */
  collect(now = new Date()): void {
    const db = this.#writable;
    const cutoff = new Date(now.getTime() - DECIDED_KEEP_MS).toISOString();
    db.prepare(
      `DELETE FROM persona_avatars
       WHERE sha256 NOT IN (SELECT avatar FROM persona_meta WHERE avatar IS NOT NULL)
         AND sha256 NOT IN (
           SELECT json_extract(payload, '$.avatar') FROM persona_proposals
           WHERE kind = 'avatar' AND (status = 'pending' OR COALESCE(decided_at, created_at) > ?) AND json_extract(payload, '$.avatar') IS NOT NULL)`,
    ).run(cutoff);
  }

  /* ---------- The default for new workspaces ---------- */

  /** The persona new workspaces start with, when it still exists and has a published revision. */
  defaultPool(): string | null {
    const row = this.#db
      .prepare('SELECT m.pool_id FROM persona_meta m JOIN pools p ON p.id = m.pool_id WHERE m.is_default = 1 AND p.type = ? AND p.current_revision > 0')
      .get('persona') as { pool_id: string } | undefined;
    return row?.pool_id ?? null;
  }

  /** At most one persona is the default; `null` clears it. Only a published persona can be. */
  setDefault(poolId: string | null): void {
    const db = this.#writable;
    if (poolId !== null) {
      this.#persona(poolId);
      const row = db.prepare('SELECT name, current_revision FROM pools WHERE id = ?').get(poolId) as { name: string; current_revision: number };
      if (row.current_revision === 0) throw new AppError('CONFLICT', `${row.name} hasn’t been published yet: publish a revision first.`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE persona_meta SET is_default = 0 WHERE is_default = 1').run();
      if (poolId !== null) {
        this.#touch(poolId);
        db.prepare('UPDATE persona_meta SET is_default = 1, updated_at = ? WHERE pool_id = ?').run(new Date().toISOString(), poolId);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.pools.onChange();
  }

  /* ---------- Who shows as what ---------- */

  identity(poolId: string): PersonaIdentity {
    const row = this.#db.prepare('SELECT p.name, m.avatar FROM pools p LEFT JOIN persona_meta m ON m.pool_id = p.id WHERE p.id = ? AND p.type = ?').get(poolId, 'persona') as
      | { name: string; avatar: string | null }
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'That persona no longer exists.');
    return { poolId, name: row.name, avatar: this.avatarUrl(row.avatar) };
  }

  /** Every workspace's persona at once, for lists that show a name and an avatar per row. */
  identities(): Record<string, PersonaIdentity> {
    const rows = this.#db
      .prepare(
        `SELECT a.workspace_id, p.id AS pool_id, p.name, m.avatar FROM assignments a
         JOIN pools p ON p.id = a.pool_id LEFT JOIN persona_meta m ON m.pool_id = p.id WHERE a.pool_type = 'persona'`,
      )
      .all() as { workspace_id: string; pool_id: string; name: string; avatar: string | null }[];
    return Object.fromEntries(rows.map((r) => [r.workspace_id, { poolId: r.pool_id, name: r.name, avatar: this.avatarUrl(r.avatar) }]));
  }

  /** The persona pool a workspace has assigned (whatever revision it gets), or null. */
  personaOf(workspaceId: string): string | null {
    const row = this.#db.prepare("SELECT pool_id FROM assignments WHERE workspace_id = ? AND pool_type = 'persona'").get(workspaceId) as { pool_id: string } | undefined;
    return row?.pool_id ?? null;
  }
}
