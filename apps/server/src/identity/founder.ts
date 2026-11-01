// The founder account and who can still sign in (owner request 2026-11-01: "replace current super admin user as alfian@isnan.me (i will log
// in via git.isnan.me sso), then let's shut down server code access").
//
// `u_owner` is a PRINCIPAL, not an account: the server code acts as it, and so does the ONE account marked `users.founder` (migration 460,
// users.principalOf). Everything the founding user owns (the orgs isnan, Konfersi and Kohilabs, workspaces, buckets, vaults, sets, tokens
// from before 462) is owned by `u_owner`, so moving the founder mark moves all of it at once, with no row rewritten, and moving the mark back
// undoes it. What a transfer does besides the mark:
// - What the NEW founder owned under its own id (it acted as itself until now) goes to `u_owner`, the id it acts as from now on; otherwise it
//   would hold it no longer. Org memberships merge (the founding user's row is kept where both have one). A transfer back leaves these with
//   the founding user (they are the same person's; nothing is lost).
// - Every token and agent minted from either account is revoked (accountGate.ts): each would otherwise act as another user than the one it
//   was minted as (the old founder's drop from `u_owner` to itself, the new founder's rise to `u_owner`). Their holders mint new ones.

import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import { FOUNDING_USER_ID } from '@portal/contracts';
import { revokeAccountTokens } from './accountGate.js';

export interface FounderTransfer {
  from: { id: string; email: string } | null;
  to: { id: string; email: string };
  /** Rows the new founder owned under its own id, now `u_owner`'s, by table (only tables with any). */
  moved: Record<string, number>;
  tokens: { pmcp: number; reporter: number; agent: number };
}

/** The account marked founder, or null (nobody: only the server code is the founding user). */
export function currentFounder(db: DatabaseSync): { id: string; email: string } | null {
  const r = db.prepare('SELECT id, email FROM users WHERE founder = 1').get() as { id: string; email: string } | undefined;
  return r ? { id: r.id, email: r.email } : null;
}

/** Token tables keep who a token was minted as: those are revoked, never re-owned. */
const NOT_MOVED = new Set(['pmcp_tokens', 'reporter_tokens', 'pmcp_agent_tokens']);

/** Every table with an `owner_id` column, and whether it has `owner_kind` (then only `user` rows are a person's). */
function ownedTables(db: DatabaseSync): { name: string; kind: boolean }[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const out: { name: string; kind: boolean }[] = [];
  for (const { name } of tables) {
    if (NOT_MOVED.has(name) || !/^[a-z0-9_]+$/.test(name)) continue;
    const cols = new Set((db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all() as { name: string }[]).map((c) => c.name));
    if (cols.has('owner_id')) out.push({ name, kind: cols.has('owner_kind') });
  }
  return out;
}

/**
 * Moves the founder mark to `targetId` (an active admin account, not the founder already) in one transaction. Who may ask is the caller's
 * decision (admin/routes.ts: the current founder, or whoever gives the server code).
 */
export function transferFounder(db: DatabaseSync, targetId: string, at: string): FounderTransfer {
  const t = db.prepare('SELECT id, email, role, state, founder FROM users WHERE id = ?').get(targetId) as
    | { id: string; email: string; role: string; state: string; founder: number }
    | undefined;
  if (!t) throw new AppError('NOT_FOUND', 'No such account.');
  if (t.founder === 1) throw new AppError('CONFLICT', 'This account is the founder already.');
  if (t.role !== 'admin' || t.state !== 'active') throw new AppError('CONFLICT', 'The founder is an active admin account.');
  const from = currentFounder(db);
  const moved: Record<string, number> = {};
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET founder = 0 WHERE founder = 1').run();
    db.prepare('UPDATE users SET founder = 1 WHERE id = ?').run(t.id);
    for (const { name, kind } of ownedTables(db)) {
      const n = Number(db.prepare(`UPDATE ${name} SET owner_id = ? WHERE owner_id = ?${kind ? " AND owner_kind = 'user'" : ''}`).run(FOUNDING_USER_ID, t.id).changes);
      if (n) moved[name] = n;
    }
    // Org memberships: the founding user's row stays where both have one; the account's other rows become the founding user's.
    const dropped = Number(
      db.prepare('DELETE FROM org_members WHERE user_id = ? AND org_id IN (SELECT org_id FROM org_members WHERE user_id = ?)').run(t.id, FOUNDING_USER_ID).changes,
    );
    const kept = Number(db.prepare('UPDATE org_members SET user_id = ? WHERE user_id = ?').run(FOUNDING_USER_ID, t.id).changes);
    if (dropped + kept) moved.org_members = dropped + kept;
    const a = revokeAccountTokens(db, t.id, at, 'founder transferred');
    const b = from ? revokeAccountTokens(db, from.id, at, 'founder transferred') : { pmcp: 0, reporter: 0, agent: 0 };
    db.exec('COMMIT');
    return { from, to: { id: t.id, email: t.email }, moved, tokens: { pmcp: a.pmcp + b.pmcp, reporter: a.reporter + b.reporter, agent: a.agent + b.agent } };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** One active admin account and how it can sign in to the main portal now. */
export interface AdminSignInPath {
  id: string;
  email: string;
  /** `password`, or the name of each enabled provider it has a linked identity at. Empty: it cannot sign in to the main portal. */
  methods: string[];
}

/**
 * Every active admin account and how it can sign in (the server code's off switch refuses while none can). A password counts unless the
 * email's domain routes to SSO only (`passwordRefused`); a linked identity counts while its provider is enabled (and its org active).
 */
export function adminSignInPaths(db: DatabaseSync, passwordRefused: (email: string) => boolean): AdminSignInPath[] {
  const admins = db.prepare("SELECT id, email, password_set FROM users WHERE role = 'admin' AND state = 'active' ORDER BY created_at").all() as {
    id: string;
    email: string;
    password_set: number;
  }[];
  const links = db.prepare(
    `SELECT p.name FROM sso_identities i JOIN sso_providers p ON p.id = i.provider_id AND p.enabled = 1
     LEFT JOIN orgs o ON o.id = p.org_id WHERE i.user_id = ? AND (p.org_id IS NULL OR o.state = 'active') ORDER BY p.name`,
  );
  return admins.map((a) => {
    const methods: string[] = [];
    let refused = true;
    try {
      refused = passwordRefused(a.email);
    } catch {
      refused = true;
    }
    if (a.password_set !== 0 && !refused) methods.push('password');
    for (const l of links.all(a.id) as { name: string }[]) methods.push(l.name);
    return { id: a.id, email: a.email, methods };
  });
}
