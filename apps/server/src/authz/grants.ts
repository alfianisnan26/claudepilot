// Grants (docs/prd/authorization.md §10, §13; organizations §6.5; migration 466): one table for every share, built once. A grant gives a
// user, a team or an org a level on one object. Organizations slice 5 writes the CREATOR grant of an org-owned object (`share_id =
// 'creator'`, §6.1); slice 7 writes shares to an org or its teams (orgs/sharing.ts, `share_id` = the `org_shares` row).
//
// `levelFor` is the one query of Authorization §10 for the grant arms, with the org arm of §6.5:
//   - to the user (a creator grant only while the user is an ACTIVE member of the org that owns the object: leaving ends it, §6.9);
//   - to a team the user is in; a team of an org only while the user is an ACTIVE member of that ACTIVE org (§6.5 invariant 7, a join and not
//     only the trigger of migration 475);
//   - to an org the user is an active member of, not as a guest, while that org is active;
//   - not expired; a workspace grant only for the workspace it was made for (`object_uid`, FR10a);
//   - none at all on an object whose owning org is not active (a suspended org gives nothing, §6.5).
// It fails closed: no database, no table, a row it cannot read: `none`.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Level, ObjectRef, UserId } from '@portal/contracts';
import type { ResolvedObject } from './seam.js';

export type GrantSubject = { kind: 'user'; id: UserId } | { kind: 'team'; id: string } | { kind: 'org'; id: string };
export const CREATOR_SHARE = 'creator';

const LEVELS: readonly Level[] = ['none', 'view', 'operate', 'manage'];

export class Grants {
  readonly #db: () => DatabaseSync | null;
  readonly #now: () => Date;

  constructor(deps: { db: () => DatabaseSync | null; now?: () => Date }) {
    this.#db = deps.db;
    this.#now = deps.now ?? (() => new Date());
  }

  /** The highest level the user's grants give on a resolved object, read now; `none` when none or unreadable. */
  levelFor(ref: ObjectRef, userId: UserId, found: ResolvedObject): Level {
    const db = this.#db();
    if (!db) return 'none';
    const orgId = found.owner?.kind === 'org' ? found.owner.id : null;
    const uid = typeof found.attrs?.uid === 'string' ? found.attrs.uid : null;
    try {
      if (orgId) {
        const state = (db.prepare('SELECT state FROM orgs WHERE id = ?').get(orgId) as { state?: unknown } | undefined)?.state;
        if (state !== 'active') return 'none';
      }
      const row = db
        .prepare(
          `SELECT max(rank) AS rank FROM (
             SELECT CASE g.level WHEN 'manage' THEN 3 WHEN 'operate' THEN 2 ELSE 1 END AS rank FROM grants g
               WHERE g.object_type = ?1 AND g.object_id = ?2 AND g.subject_kind = 'user' AND g.subject_id = ?3
                 AND (g.share_id != 'creator' OR EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ?5 AND m.user_id = ?3 AND m.state = 'active'))
                 AND (g.expires_at IS NULL OR g.expires_at > ?4) AND (g.object_uid IS NULL OR g.object_uid = ?6)
             UNION ALL
             SELECT CASE g.level WHEN 'manage' THEN 3 WHEN 'operate' THEN 2 ELSE 1 END FROM grants g
               JOIN team_members t ON g.subject_kind = 'team' AND g.subject_id = t.team_id AND t.user_id = ?3
               JOIN teams tt ON tt.id = t.team_id
               WHERE (tt.org_id IS NULL OR EXISTS (SELECT 1 FROM org_members tm JOIN orgs tor ON tor.id = tm.org_id AND tor.state = 'active'
                                                   WHERE tm.org_id = tt.org_id AND tm.user_id = ?3 AND tm.state = 'active'))
                 AND g.object_type = ?1 AND g.object_id = ?2 AND (g.expires_at IS NULL OR g.expires_at > ?4) AND (g.object_uid IS NULL OR g.object_uid = ?6)
             UNION ALL
             SELECT CASE g.level WHEN 'operate' THEN 2 ELSE 1 END FROM grants g
               JOIN org_members m ON g.subject_kind = 'org' AND g.subject_id = m.org_id AND m.user_id = ?3 AND m.state = 'active' AND m.role != 'guest'
               JOIN orgs o ON o.id = m.org_id AND o.state = 'active'
               WHERE g.object_type = ?1 AND g.object_id = ?2 AND (g.expires_at IS NULL OR g.expires_at > ?4) AND (g.object_uid IS NULL OR g.object_uid = ?6)
           )`,
        )
        .get(ref.type, ref.id, userId, this.#now().toISOString(), orgId, uid) as { rank?: unknown } | undefined;
      const rank = row?.rank;
      return typeof rank === 'number' && Number.isInteger(rank) && rank >= 1 && rank <= 3 ? LEVELS[rank]! : 'none';
    } catch {
      return 'none';
    }
  }

  /** Writes one grant (inside the caller's transaction when it runs one). Replaces the same (object, subject, share). */
  add(db: DatabaseSync, g: { ref: ObjectRef; uid?: string | null; subject: GrantSubject; level: Exclude<Level, 'none'>; shareId: string; by: string; expiresAt?: string | null }): string {
    if (g.subject.kind === 'org' && g.level === 'manage') throw new Error('manage to a whole org is refused (§6.4)');
    const id = `gr_${randomBytes(9).toString('base64url')}`;
    db.prepare(
      `INSERT INTO grants (id, object_type, object_id, object_uid, subject_kind, subject_id, level, share_id, granted_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (object_type, object_id, subject_kind, subject_id, share_id) DO UPDATE SET
         level = excluded.level, object_uid = excluded.object_uid, granted_by = excluded.granted_by, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    ).run(id, g.ref.type, g.ref.id, g.uid ?? null, g.subject.kind, g.subject.id, g.level, g.shareId, g.by, this.#now().toISOString(), g.expiresAt ?? null);
    return id;
  }

  /** Removes the grants one share made on an object (all of them without a share id). */
  removeFor(db: DatabaseSync, ref: ObjectRef, shareId?: string): number {
    const sql = shareId ? 'DELETE FROM grants WHERE object_type = ? AND object_id = ? AND share_id = ?' : 'DELETE FROM grants WHERE object_type = ? AND object_id = ?';
    return Number(db.prepare(sql).run(...(shareId ? [ref.type, ref.id, shareId] : [ref.type, ref.id])).changes);
  }

  /** The grants on an object (for a later share dialog and tests): subject, level, share. */
  on(ref: ObjectRef): { subjectKind: string; subjectId: string; level: Level; shareId: string; objectUid: string | null }[] {
    const db = this.#db();
    if (!db) return [];
    return (
      db.prepare('SELECT subject_kind, subject_id, level, share_id, object_uid FROM grants WHERE object_type = ? AND object_id = ? ORDER BY created_at, id').all(ref.type, ref.id) as {
        subject_kind: string;
        subject_id: string;
        level: Level;
        share_id: string;
        object_uid: string | null;
      }[]
    ).map((r) => ({ subjectKind: r.subject_kind, subjectId: r.subject_id, level: r.level, shareId: r.share_id, objectUid: r.object_uid }));
  }
}
