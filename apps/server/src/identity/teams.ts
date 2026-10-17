// Teams (owner, 2026-10-17: "team based multiaccount"): a named group of accounts. A session shared to a team reaches every member while
// they are in it (leaving or being removed ends it at once, because shares are read on every request). An admin makes and removes teams;
// a team's owners add and remove its people. A team never loses its last owner.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import { PORTAL_TEAM_LIMITS, type PortalTeam, type PortalTeamMember, type PortalTeamRole } from '@portal/contracts';

interface TeamRow {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
  members: number;
}

const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

export class PortalTeams {
  constructor(
    private readonly db: () => DatabaseSync | null,
    private readonly writable: () => DatabaseSync | null = db,
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

  #view = (r: TeamRow, me?: string): PortalTeam => {
    const out: PortalTeam = { id: r.id, name: r.name, description: r.description, members: r.members, createdAt: r.created_at, createdBy: r.created_by };
    if (me) {
      const role = this.roleIn(r.id, me);
      if (role) out.myRole = role;
    }
    return out;
  };

  static #SELECT = 'SELECT t.*, (SELECT count(*) FROM team_members m WHERE m.team_id = t.id) AS members FROM teams t';

  #name(raw: unknown): string {
    const name = typeof raw === 'string' ? clean(raw) : '';
    if (!name || name.length > PORTAL_TEAM_LIMITS.nameMax)
      throw new AppError('VALIDATION_FAILED', `Give it a name of at most ${PORTAL_TEAM_LIMITS.nameMax} characters.`, { details: { name: 'Required.' } });
    return name;
  }
  #description(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    const d = typeof raw === 'string' ? clean(raw) : '';
    if (d.length > PORTAL_TEAM_LIMITS.descriptionMax) throw new AppError('VALIDATION_FAILED', 'Keep the description short.', { details: { description: 'Too long.' } });
    return d || null;
  }

  list(me?: string): PortalTeam[] {
    return (this.#db().prepare(`${PortalTeams.#SELECT} ORDER BY t.name_key`).all() as unknown as TeamRow[]).map((r) => this.#view(r, me));
  }

  /** The teams an account is in. */
  mine(userId: string): PortalTeam[] {
    return (
      this.#db().prepare(`${PortalTeams.#SELECT} WHERE t.id IN (SELECT team_id FROM team_members WHERE user_id = ?) ORDER BY t.name_key`).all(userId) as unknown as TeamRow[]
    ).map((r) => this.#view(r, userId));
  }

  /** Team ids an account is in (read on every delegate request). */
  idsOf(userId: string): string[] {
    return ((this.db()?.prepare('SELECT team_id FROM team_members WHERE user_id = ?').all(userId) ?? []) as { team_id: string }[]).map((r) => r.team_id);
  }

  get(id: string, me?: string): PortalTeam {
    const r = this.#db().prepare(`${PortalTeams.#SELECT} WHERE t.id = ?`).get(id) as TeamRow | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'No such team.');
    return this.#view(r, me);
  }

  nameOf(id: string): string {
    return (this.db()?.prepare('SELECT name FROM teams WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? 'a removed team';
  }

  exists(id: string): boolean {
    return !!this.db()?.prepare('SELECT 1 FROM teams WHERE id = ?').get(id);
  }

  create(req: { name?: unknown; description?: unknown }, owners: string[], by: string): PortalTeam {
    const name = this.#name(req.name);
    const description = this.#description(req.description);
    const db = this.#w();
    if ((db.prepare('SELECT count(*) AS n FROM teams').get() as { n: number }).n >= PORTAL_TEAM_LIMITS.maxTeams) throw new AppError('CONFLICT', 'There are as many teams as the portal allows.');
    if (db.prepare('SELECT 1 FROM teams WHERE name_key = ?').get(name.toLowerCase())) throw new AppError('CONFLICT', 'A team with that name exists.', { details: { name: 'Already used.' } });
    const id = `tm_${randomBytes(9).toString('base64url')}`;
    const at = this.now().toISOString();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO teams (id, name, name_key, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, name.toLowerCase(), description, by, at);
      for (const u of new Set(owners)) db.prepare("INSERT INTO team_members (team_id, user_id, role, added_by, added_at) VALUES (?, ?, 'owner', ?, ?)").run(id, u, by, at);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return this.get(id);
  }

  update(id: string, req: { name?: unknown; description?: unknown }): PortalTeam {
    this.get(id);
    const db = this.#w();
    if (req.name !== undefined) {
      const name = this.#name(req.name);
      const other = db.prepare('SELECT id FROM teams WHERE name_key = ?').get(name.toLowerCase()) as { id: string } | undefined;
      if (other && other.id !== id) throw new AppError('CONFLICT', 'A team with that name exists.', { details: { name: 'Already used.' } });
      db.prepare('UPDATE teams SET name = ?, name_key = ? WHERE id = ?').run(name, name.toLowerCase(), id);
    }
    if (req.description !== undefined) db.prepare('UPDATE teams SET description = ? WHERE id = ?').run(this.#description(req.description), id);
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    const db = this.#w();
    db.prepare('DELETE FROM team_members WHERE team_id = ?').run(id); // not left to ON DELETE CASCADE: foreign keys may be off
    db.prepare('DELETE FROM teams WHERE id = ?').run(id);
  }

  members(id: string): PortalTeamMember[] {
    return (
      this.#db()
        .prepare(
          `SELECT m.user_id, m.role, m.added_at, u.email, u.display_name FROM team_members m JOIN users u ON u.id = m.user_id
           WHERE m.team_id = ? ORDER BY m.role DESC, u.email_key`,
        )
        .all(id) as { user_id: string; role: PortalTeamRole; added_at: string; email: string; display_name: string }[]
    ).map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role, addedAt: r.added_at }));
  }

  roleIn(teamId: string, userId: string): PortalTeamRole | null {
    return (this.db()?.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId) as { role: PortalTeamRole } | undefined)?.role ?? null;
  }

  /** Add an account, or change its role. */
  setMember(teamId: string, userId: string, role: PortalTeamRole, by: string): void {
    this.get(teamId);
    const db = this.#w();
    const current = this.roleIn(teamId, userId);
    if (!current && (db.prepare('SELECT count(*) AS n FROM team_members WHERE team_id = ?').get(teamId) as { n: number }).n >= PORTAL_TEAM_LIMITS.maxMembers)
      throw new AppError('CONFLICT', 'The team is full.');
    if (current === 'owner' && role === 'member') this.#keepAnOwner(teamId, userId);
    db.prepare(
      'INSERT INTO team_members (team_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role',
    ).run(teamId, userId, role, by, this.now().toISOString());
  }

  removeMember(teamId: string, userId: string): boolean {
    if (this.roleIn(teamId, userId) === 'owner') this.#keepAnOwner(teamId, userId);
    return Number(this.#w().prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId).changes) > 0;
  }

  /** An account that is removed leaves every team; a team it was the last owner of keeps going, owned by the admins. */
  removeUser(userId: string): void {
    this.writable()?.prepare('DELETE FROM team_members WHERE user_id = ?').run(userId);
  }

  #keepAnOwner(teamId: string, leaving: string): void {
    const n = (this.#db().prepare("SELECT count(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner' AND user_id != ?").get(teamId, leaving) as { n: number }).n;
    if (n === 0) throw new AppError('CONFLICT', 'A team keeps at least one owner. Make someone else an owner first.');
  }
}
