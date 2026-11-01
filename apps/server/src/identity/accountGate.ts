// Organizations slice 0, review M1 and M2 (docs/prd/multi-user.md §20): a token and an agent live no longer than the account behind them.
// Every Portal MCP, VS Code and reporter token minted from an email account records that ACCOUNT (`token_accounts`, migration 462), and
// every chat session records the account that started it (`chat_sessions.started_by_account`). The actor value alone cannot do this: the
// founder account acts as `u_owner`, the same value every token from before and every server-code token carries.
//
// `accountStanding` is asked at USE time by each token's verify: an account that is gone, disabled, or no longer an admin (only a full
// session, an admin's or the server code's, can mint a token or start a session) stops every token it minted at once. `revokeAccountTokens`
// makes that permanent when an admin disables, demotes or removes the account, so promoting it again revives nothing.

import type { DatabaseSync } from 'node:sqlite';
import { FOUNDING_USER_ID, type UserId } from '@portal/contracts';

export type TokenKind = 'pmcp' | 'reporter';

/**
 * Whether what an account minted or started may still act, and as whom. No account (null: the server code, or a token from before 462) is
 * the founding user, as it always was. An account acts while it is an active admin: as `u_owner` when it is the founder, else as itself.
 * A database that cannot be read answers no (fail closed).
 */
export function accountStanding(db: DatabaseSync | null | undefined, accountId: string | null | undefined): { ok: boolean; userId: UserId } {
  if (!accountId) return { ok: true, userId: FOUNDING_USER_ID };
  try {
    const r = db?.prepare('SELECT founder, role, state FROM users WHERE id = ?').get(accountId) as { founder: number; role: string; state: string } | undefined;
    if (!r || r.role !== 'admin' || r.state !== 'active') return { ok: false, userId: accountId };
    return { ok: true, userId: r.founder === 1 ? FOUNDING_USER_ID : accountId };
  } catch {
    return { ok: false, userId: accountId };
  }
}

/** The account a token was minted from, or null (the server code, or a token from before 462). */
export function tokenAccount(db: DatabaseSync | null | undefined, kind: TokenKind, tokenId: string): string | null {
  const r = db?.prepare('SELECT account_id FROM token_accounts WHERE kind = ? AND token_id = ?').get(kind, tokenId) as { account_id: string } | undefined;
  return r?.account_id ?? null;
}

/** Records the account a token was minted from; nothing for the server code. */
export function recordTokenAccount(db: DatabaseSync, kind: TokenKind, tokenId: string, accountId: string | null | undefined): void {
  if (accountId) db.prepare('INSERT INTO token_accounts (kind, token_id, account_id) VALUES (?, ?, ?)').run(kind, tokenId, accountId);
}

/**
 * Revokes every live token the account minted (Portal MCP, VS Code, reporter) and every agent token of a session it started. Called when an
 * admin disables, demotes or removes the account. Returns how many were revoked, by kind.
 */
export function revokeAccountTokens(db: DatabaseSync, accountId: string, at: string, reason: string): { pmcp: number; reporter: number; agent: number } {
  const n = (sql: string, ...args: (string | null)[]) => Number(db.prepare(sql).run(...args).changes);
  const hasTable = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const pmcp = n(
    // Owner need 2026-11-01: and the tokens an admin minted FOR this account (they act as it: `owner_id`). The founder's own act as u_owner,
    // never as the account id, so this never reaches the founding user's tokens.
    "UPDATE pmcp_tokens SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL AND (id IN (SELECT token_id FROM token_accounts WHERE kind = 'pmcp' AND account_id = ?) OR owner_id = ?)",
    at,
    reason,
    accountId,
    accountId,
  );
  const reporter = hasTable('reporter_tokens')
    ? n(
        "UPDATE reporter_tokens SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL AND id IN (SELECT token_id FROM token_accounts WHERE kind = 'reporter' AND account_id = ?)",
        at,
        reason,
        accountId,
      )
    : 0;
  const agent = n(
    'UPDATE pmcp_agent_tokens SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL AND session_id IN (SELECT id FROM chat_sessions WHERE started_by_account = ?)',
    at,
    reason,
    accountId,
  );
  return { pmcp, reporter, agent };
}
