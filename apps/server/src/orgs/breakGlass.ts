// Break-glass (docs/prd/organizations.md §6.7, OD-4; migration 467). The instance owner has full access to any org's content, but only
// through a recorded entry. Read this before calling it.
//
// - `start`: an instance admin, as a PERSON (requireInstanceAdmin: no token, no agent), from the Admin console (whose route adds the fresh
//   re-auth). A reason of at least 10 characters. The entry lasts ONE hour; a new entry by the same admin on the same org replaces the
//   open one (renewal is a new entry with a new reason). The org's active owners are notified; `org.break_glass_started` (high).
// - While open, the seam gives that admin `manage` on the org's objects (seam.ts, `OrgAuthority.breakGlass`), in the normal portal, as a
//   person; never on personal objects (an org role or entry never reaches a user-owned object). `isOpen` checks `expires_at` against the
//   clock on every decision, so security never waits for the sweep.
// - Every decision that NEEDED the entry for a verb above `view` writes `org.break_glass_access` (medium), de-duplicated per entry, object
//   and verb for a minute (a burst of checks on one request is one row).
// - `end`: the admin who opened it (Admin console), or an owner of the org (main portal): `org.break_glass_ended`. `sweep` closes entries
//   past their hour: `org.break_glass_expired`.
// - Org owners read the entries and the access rows (`forOrg`); the admin reads every entry (`listAll`); the banner reads `mine`.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  BREAK_GLASS_LIMITS,
  ORGS_ERROR_CODES,
  actorString,
  actorUserId,
  isOrgId,
  orgRef,
  type Actor,
  type BreakGlassEntry,
  type ObjectRef,
  type OrgBreakGlassView,
  type OrgId,
  type UserId,
  type Verb,
} from '@portal/contracts';
import { requireCan } from '../authz/seam.js';
import type { AuditInput } from '../platform/audit.js';
import { requireInstanceAdmin } from './abilities.js';
import type { OrgsService } from './service.js';

export interface BreakGlassNotice {
  orgId: OrgId;
  orgName: string;
  entryId: string;
  admin: string;
  expiresAt: string;
}

export interface BreakGlassDeps {
  db: () => DatabaseSync | null;
  writable?: () => DatabaseSync | null;
  orgs: OrgsService;
  audit: (e: AuditInput) => void;
  /** Tells the org's owners (a notification); never throws into the caller. */
  notify?: (owners: UserId[], notice: BreakGlassNotice) => void;
  now?: () => Date;
}

interface Row {
  id: string;
  org_id: string;
  org_name: string | null;
  admin_user_id: string;
  reason: string;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  ended_by: string | null;
  end_kind: BreakGlassEntry['endKind'];
}

const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
const notFound = () => new AppError('NOT_FOUND', 'Not found.');
const SELECT = `SELECT b.id, b.org_id, o.name AS org_name, b.admin_user_id, b.reason, b.started_at, b.expires_at, b.ended_at, b.ended_by, b.end_kind
  FROM org_break_glass b LEFT JOIN orgs o ON o.id = b.org_id`;
const ACCESS_DEDUPE_MS = 60_000;

export class BreakGlassService {
  readonly #db: () => DatabaseSync | null;
  readonly #w: () => DatabaseSync | null;
  readonly #orgs: OrgsService;
  readonly #audit: (e: AuditInput) => void;
  readonly #notify: BreakGlassDeps['notify'];
  readonly #now: () => Date;
  readonly #recent = new Map<string, number>();

  constructor(deps: BreakGlassDeps) {
    this.#db = deps.db;
    this.#w = deps.writable ?? deps.db;
    this.#orgs = deps.orgs;
    this.#audit = deps.audit;
    this.#notify = deps.notify;
    this.#now = deps.now ?? (() => new Date());
  }

  #write(): DatabaseSync {
    const db = this.#w();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    return db;
  }
  #read(): DatabaseSync {
    const db = this.#db();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is not available.');
    return db;
  }

  #view(r: Row, nowIso: string): BreakGlassEntry {
    return {
      id: r.id,
      orgId: r.org_id,
      orgName: r.org_name ?? '',
      adminUserId: r.admin_user_id,
      reason: r.reason,
      startedAt: r.started_at,
      expiresAt: r.expires_at,
      endedAt: r.ended_at,
      endKind: r.end_kind,
      endedBy: r.ended_by,
      open: r.ended_at === null && r.expires_at > nowIso,
    };
  }

  /** The id of the user's open entry on the org, read now (the seam's hot path: one indexed SELECT); null when none or unreadable. */
  isOpen(orgId: string, userId: UserId): string | null {
    if (!isOrgId(orgId)) return null;
    try {
      const r = this.#db()
        ?.prepare('SELECT id FROM org_break_glass WHERE org_id = ? AND admin_user_id = ? AND ended_at IS NULL AND expires_at > ? ORDER BY started_at DESC LIMIT 1')
        .get(orgId, userId, this.#now().toISOString()) as { id?: unknown } | undefined;
      return typeof r?.id === 'string' ? r.id : null;
    } catch {
      return null;
    }
  }

  /** Opens an entry (§6.7). The Admin console's route has checked the fresh re-auth. */
  start(actor: Actor, orgId: OrgId, rawReason: unknown): BreakGlassEntry {
    requireInstanceAdmin(actor);
    const reason = typeof rawReason === 'string' ? clean(rawReason) : '';
    if (reason.length < BREAK_GLASS_LIMITS.reasonMin || reason.length > BREAK_GLASS_LIMITS.reasonMax)
      throw new AppError('VALIDATION_FAILED', `Say why, in ${BREAK_GLASS_LIMITS.reasonMin} to ${BREAK_GLASS_LIMITS.reasonMax} characters.`, {
        details: { reason: 'Too short.', code: ORGS_ERROR_CODES.BREAK_GLASS_REASON },
      });
    const state = this.#orgs.stateOf(orgId);
    if (!state || state === 'deleting') throw notFound();
    this.sweep();
    const adminId = actor.userId;
    const by = actorString(actor);
    const now = this.#now();
    const at = now.toISOString();
    const expiresAt = new Date(now.getTime() + BREAK_GLASS_LIMITS.durationMs).toISOString();
    const id = `bg_${randomBytes(9).toString('base64url')}`;
    const db = this.#write();
    let replaced: string[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      replaced = (db.prepare('SELECT id FROM org_break_glass WHERE org_id = ? AND admin_user_id = ? AND ended_at IS NULL').all(orgId, adminId) as { id: string }[]).map((r) => r.id);
      db.prepare("UPDATE org_break_glass SET ended_at = ?, ended_by = ?, end_kind = 'replaced' WHERE org_id = ? AND admin_user_id = ? AND ended_at IS NULL").run(at, by, orgId, adminId);
      db.prepare('INSERT INTO org_break_glass (id, org_id, admin_user_id, reason, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, orgId, adminId, reason, at, expiresAt);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    for (const old of replaced) this.#record('org.break_glass_ended', by, orgId, adminId, { entryId: old, endKind: 'replaced', by: 'admin', replacedBy: id }, 'medium');
    this.#record('org.break_glass_started', by, orgId, adminId, { entryId: id, reason, expiresAt }, 'high');
    const entry = this.#get(id);
    const owners = this.#orgs.activeOwners(orgId);
    try {
      this.#notify?.(owners, { orgId, orgName: entry.orgName, entryId: id, admin: by, expiresAt });
    } catch (e) {
      console.error(`[orgs] the break-glass notification failed: ${(e as Error).message}`);
    }
    return entry;
  }

  #get(id: string): BreakGlassEntry {
    const r = this.#read().prepare(`${SELECT} WHERE b.id = ?`).get(id) as Row | undefined;
    if (!r) throw notFound();
    return this.#view(r, this.#now().toISOString());
  }

  /** The admin ends their own open entry on the org early (the Admin console). Nothing open: `{ ended: 0 }`. */
  endByAdmin(actor: Actor, orgId: OrgId): { ended: number } {
    requireInstanceAdmin(actor);
    this.sweep();
    const ids = this.#openIds('SELECT id FROM org_break_glass WHERE org_id = ? AND admin_user_id = ? AND ended_at IS NULL', orgId, actor.userId);
    for (const id of ids) this.#end(actor, orgId, id, 'admin');
    return { ended: ids.length };
  }

  /** An OWNER of the org ends an open entry early (the main portal). Anyone else: refused (a non-member: the org's 404). */
  endByOrgOwner(actor: Actor, orgId: OrgId, entryId: string): BreakGlassEntry {
    this.#requireOrgOwner(actor, orgId);
    this.sweep();
    const r = this.#read().prepare('SELECT ended_at FROM org_break_glass WHERE id = ? AND org_id = ?').get(entryId, orgId) as { ended_at: string | null } | undefined;
    if (!r) throw notFound();
    if (r.ended_at === null) this.#end(actor, orgId, entryId, 'org_owner');
    return this.#get(entryId);
  }

  #openIds(sql: string, ...args: string[]): string[] {
    return (this.#read().prepare(sql).all(...args) as { id: string }[]).map((r) => r.id);
  }

  #end(actor: Actor, orgId: OrgId, id: string, by: 'admin' | 'org_owner'): void {
    const changed = Number(
      this.#write()
        .prepare("UPDATE org_break_glass SET ended_at = ?, ended_by = ?, end_kind = 'ended' WHERE id = ? AND ended_at IS NULL")
        .run(this.#now().toISOString(), actorString(actor), id).changes,
    );
    if (changed) this.#record('org.break_glass_ended', actorString(actor), orgId, actorUserId(actor), { entryId: id, endKind: 'ended', by }, 'medium');
  }

  /** Closes every entry past its hour, with its audit row. Returns how many. Called by the routes and a timer; decisions never rely on it. */
  sweep(): number {
    const db = this.#w();
    if (!db) return 0;
    const nowIso = this.#now().toISOString();
    let rows: { id: string; org_id: string; admin_user_id: string; expires_at: string }[];
    try {
      rows = db.prepare('SELECT id, org_id, admin_user_id, expires_at FROM org_break_glass WHERE ended_at IS NULL AND expires_at <= ?').all(nowIso) as typeof rows;
      if (!Array.isArray(rows)) return 0;
    } catch {
      return 0;
    }
    let n = 0;
    for (const r of rows) {
      const changed = Number(db.prepare("UPDATE org_break_glass SET ended_at = expires_at, ended_by = 'system:break-glass', end_kind = 'expired' WHERE id = ? AND ended_at IS NULL").run(r.id).changes);
      if (!changed) continue;
      n++;
      this.#record('org.break_glass_expired', 'system:break-glass', r.org_id, r.admin_user_id, { entryId: r.id, expiresAt: r.expires_at }, 'medium');
    }
    return n;
  }

  /** One access row for a decision that needed the entry (seam.ts). De-duplicated per entry, object and verb for a minute. Never throws. */
  recordAccess(entryId: string, userId: UserId, orgId: string, verb: Verb, object: ObjectRef): void {
    try {
      const key = `${entryId}|${object.type}:${object.id}|${verb}`;
      const t = this.#now().getTime();
      const last = this.#recent.get(key);
      if (last !== undefined && t - last < ACCESS_DEDUPE_MS) return;
      this.#recent.set(key, t);
      if (this.#recent.size > 5000) for (const [k, v] of this.#recent) if (t - v >= ACCESS_DEDUPE_MS) this.#recent.delete(k);
      this.#record('org.break_glass_access', `user:${userId}`, orgId as OrgId, userId, { entryId, object: `${object.type}:${object.id}`, verb }, 'medium');
    } catch (e) {
      console.error(`[orgs] a break-glass access row could not be written: ${(e as Error).message}`);
    }
  }

  /** The signed-in person's OPEN entries (the banner). Anyone who is not an instance admin person has none. */
  mine(actor: Actor): BreakGlassEntry[] {
    const userId = actorUserId(actor);
    if (actor.kind !== 'user' || !userId) return [];
    const nowIso = this.#now().toISOString();
    const rows = this.#read().prepare(`${SELECT} WHERE b.admin_user_id = ? AND b.ended_at IS NULL AND b.expires_at > ? ORDER BY b.started_at DESC`).all(userId, nowIso) as unknown as Row[];
    return rows.map((r) => this.#view(r, nowIso));
  }

  /** Every entry, newest first (the Admin console). */
  listAll(actor: Actor, limit = 200): BreakGlassEntry[] {
    requireInstanceAdmin(actor);
    this.sweep();
    const nowIso = this.#now().toISOString();
    const rows = this.#read().prepare(`${SELECT} ORDER BY b.started_at DESC, b.id LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as unknown as Row[];
    return rows.map((r) => this.#view(r, nowIso));
  }

  /** The org's entries and the access rows written under them: the org's OWNERS only (§6.7 "visible to the org's owners"). */
  forOrg(actor: Actor, orgId: OrgId): OrgBreakGlassView {
    this.#requireOrgOwner(actor, orgId);
    this.sweep();
    const db = this.#read();
    const nowIso = this.#now().toISOString();
    const entries = (db.prepare(`${SELECT} WHERE b.org_id = ? ORDER BY b.started_at DESC, b.id LIMIT 200`).all(orgId) as unknown as Row[]).map((r) => this.#view(r, nowIso));
    const access = (
      db
        .prepare("SELECT at, actor, detail FROM platform_audit WHERE subject = ? AND kind = 'org.break_glass_access' ORDER BY id DESC LIMIT 500")
        .all(`org:${orgId}`) as { at: string; actor: string; detail: string }[]
    ).map((r) => {
      let d: Record<string, unknown> = {};
      try {
        d = JSON.parse(r.detail) as Record<string, unknown>;
      } catch {
        // an unreadable row shows empty fields
      }
      return { at: r.at, actor: r.actor, entryId: String(d.entryId ?? ''), object: String(d.object ?? ''), verb: String(d.verb ?? '') };
    });
    return { entries, access };
  }

  #requireOrgOwner(actor: Actor, orgId: OrgId): void {
    requireCan(actor, 'view', orgRef(orgId));
    const userId = actorUserId(actor);
    if (actor.kind !== 'user' || !userId || this.#orgs.roleOf(orgId, userId) !== 'owner') throw new AppError('FORBIDDEN', 'Only an owner of the organization sees this.');
  }

  #record(kind: string, actor: string, orgId: OrgId, userId: UserId | null, detail: Record<string, unknown>, severity: AuditInput['severity']): void {
    this.#audit({ kind, severity, actor, userId, subject: `org:${orgId}`, detail: { orgId, ...detail } });
  }
}
