import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '@isnanme/core';
import { PORTAL_AGENT_TOKEN_PREFIX } from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { PortalPrincipal } from './registry.js';

// Per-session agent tokens (interface I8; portal-mcp PRD §10.1 as amended). The portal mints a `cpst_` token for ONE
// chat session of a workspace that opted in, when the session launches; it goes only into the environment of that
// session's Claude Code process (never a file, never the transcript), is bound to the workspace and the session,
// hashed at rest, and lives exactly as long as the session. Anything in the workspace can read it, hence the narrow
// scope (`agent`: only tools that opt in, never an operate or admin tool), the rate limits, and that every proposal an
// agent makes still needs a person's click.

/** A token outlives no session, and no more than this: a process that runs for a week gets a fresh one at its next wake. */
export const AGENT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** `last_used_at` is written at most this often per token. */
const TOUCH_EVERY_MS = 60_000;

const hashOf = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** What a session's launch needs (interface I8): the environment for its process, and the MCP config that refers to it. */
export interface AgentGrant {
  tokenId: string;
  /** The environment of that session's Claude Code process, and nothing else's. */
  env: {
    PILOT_MCP_TOKEN: string;
    PILOT_SESSION_ID: string;
    PILOT_WORKSPACE_ID: string;
    PILOT_MCP_URL: string;
  };
  /** JSON for `--mcp-config`: the portal's connector. It refers to the variables above and holds no secret itself. */
  mcpConfig: string;
}

/** What the launch wiring depends on: the rest of the portal never sees a token. */
export interface AgentTokenMinter {
  enabled(workspaceId: string): boolean;
  mint(req: { workspaceId: string; sessionId: string }): Promise<AgentGrant | null>;
  revokeSession(sessionId: string, reason: string): number;
}

export const AGENT_MCP_CONFIG = JSON.stringify({
  mcpServers: { pilot: { type: 'http', url: '${PILOT_MCP_URL}', headers: { Authorization: 'Bearer ${PILOT_MCP_TOKEN}' } } },
});

export type AgentVerify =
  | { ok: true; principal: PortalPrincipal }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' | 'ended' | 'disabled'; tokenId?: string };

interface TokenRow {
  id: string;
  workspace_id: string;
  session_id: string;
  vaults: string | null;
  expires_at: string;
  revoked_at: string | null;
}

export interface AgentAccessOptions {
  /** Whether a chat session is still running: it exists, hasn't ended, and isn't archived. */
  alive: (sessionId: string) => boolean;
  /** The portal's `/mcp` URL as that workspace reaches it; null when it can't be worked out. */
  url: (workspaceId: string) => Promise<string | null> | string | null;
  /** Whether MCP is switched on at all. */
  mcpEnabled?: () => boolean;
  now?: () => Date;
}

/**
 * The agents' side of Portal MCP: which workspaces opted in ("Agent access to portal tools", off by default), and
 * the per-session tokens of those that did. A2 wires `mint` and `revokeSession` into session launch and end; the
 * portal also revokes by itself when a session ends, and checks that the session is alive on every call.
 */
export class AgentAccess implements AgentTokenMinter {
  readonly #touched = new Map<string, number>();
  readonly #warned = new Set<string>();
  /** Called after the opt-in or the live tokens change, for the page that shows them. */
  onChange?: () => void;
  /** Called when a workspace's opt-in is turned on or off (what a lockdown allowlist must admit changes with it). */
  onAccessChange?: (workspaceId: string) => void;

  constructor(
    private readonly store: Store,
    private readonly o: AgentAccessOptions,
  ) {}

  get #now(): Date {
    return (this.o.now ?? (() => new Date()))();
  }

  get #db() {
    return this.store.db;
  }

  get #writable() {
    return this.store.writable ? this.store.db : null;
  }

  /* ---------- The opt-in ---------- */

  enabled(workspaceId: string): boolean {
    try {
      return !!this.#db?.prepare('SELECT 1 AS x FROM pmcp_agent_access WHERE workspace_id = ?').get(workspaceId);
    } catch {
      return false; // no such table (a failed migration): nobody has opted in
    }
  }

  /** Workspaces that opted in. */
  enabledWorkspaces(): string[] {
    const rows = this.#db?.prepare('SELECT workspace_id FROM pmcp_agent_access ORDER BY workspace_id').all() as { workspace_id: string }[] | undefined;
    return (rows ?? []).map((r) => r.workspace_id);
  }

  /** Turns agent access on or off for a workspace. Turning it off revokes every token its sessions hold. */
  setEnabled(workspaceId: string, enabled: boolean): { revoked: number } {
    const db = this.#writable;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    // Plain names only, as for every workspace route: a name is never anything a path, a shell or a URL could read differently.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(workspaceId)) throw new AppError('VALIDATION_FAILED', 'A workspace is `<target>/<name>`.');
    let revoked = 0;
    const was = this.enabled(workspaceId);
    if (enabled) db.prepare('INSERT INTO pmcp_agent_access (workspace_id, enabled_at) VALUES (?, ?) ON CONFLICT (workspace_id) DO NOTHING').run(workspaceId, this.#now.toISOString());
    else {
      db.prepare('DELETE FROM pmcp_agent_access WHERE workspace_id = ?').run(workspaceId);
      revoked = this.revokeWorkspace(workspaceId, 'agent access turned off');
    }
    this.onChange?.();
    if (was !== enabled) this.onAccessChange?.(workspaceId);
    return { revoked };
  }

  /** Live tokens per workspace, for the page. */
  liveCounts(): Map<string, number> {
    const rows = this.#db
      ?.prepare('SELECT workspace_id, count(*) AS n FROM pmcp_agent_tokens WHERE revoked_at IS NULL AND expires_at > ? GROUP BY workspace_id')
      .all(this.#now.toISOString()) as { workspace_id: string; n: number }[] | undefined;
    return new Map((rows ?? []).map((r) => [r.workspace_id, r.n]));
  }

  liveTotal(): number {
    let n = 0;
    for (const c of this.liveCounts().values()) n += c;
    return n;
  }

  /* ---------- Minting and revoking ---------- */

  /**
   * Mints the token for one session at its launch, revoking the one it had (a Claude switch gives the new process a
   * new token). Null when the workspace hasn't opted in, MCP is off, the session isn't running, or the portal's
   * address can't be worked out for that workspace: the session then simply runs without portal tools.
   */
  async mint(req: { workspaceId: string; sessionId: string }): Promise<AgentGrant | null> {
    const { workspaceId, sessionId } = req;
    if (!this.enabled(workspaceId) || this.o.mcpEnabled?.() === false || !this.o.alive(sessionId)) return null;
    const db = this.#writable;
    if (!db) return null;
    const url = await this.o.url(workspaceId);
    if (!url) {
      if (!this.#warned.has(workspaceId)) {
        this.#warned.add(workspaceId);
        console.warn(`[portal-mcp] agents in ${workspaceId} get no portal tools: the portal's address as that workspace reaches it is unknown (set PORTAL_INTERNAL_URL)`);
      }
      return null;
    }
    this.revokeSession(sessionId, 'replaced by a new token');
    const secret = `${PORTAL_AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = `agt_${randomBytes(6).toString('hex')}`;
    const now = this.#now;
    db.prepare('INSERT INTO pmcp_agent_tokens (id, token_hash, workspace_id, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      hashOf(secret),
      workspaceId,
      sessionId,
      now.toISOString(),
      new Date(now.getTime() + AGENT_TOKEN_TTL_MS).toISOString(),
    );
    this.onChange?.();
    return { tokenId: id, env: { PILOT_MCP_TOKEN: secret, PILOT_SESSION_ID: sessionId, PILOT_WORKSPACE_ID: workspaceId, PILOT_MCP_URL: url }, mcpConfig: AGENT_MCP_CONFIG };
  }

  #revoke(where: string, args: string[], reason: string): number {
    const db = this.#writable;
    if (!db) return 0;
    const r = db.prepare(`UPDATE pmcp_agent_tokens SET revoked_at = ?, revoked_reason = ? WHERE ${where} AND revoked_at IS NULL`).run(this.#now.toISOString(), reason, ...args);
    if (r.changes > 0) this.onChange?.();
    return Number(r.changes);
  }

  /** The session ended, was archived or deleted, or switched Claude: its tokens stop working on their next call. */
  revokeSession(sessionId: string, reason: string): number {
    return this.#revoke('session_id = ?', [sessionId], reason);
  }

  revokeWorkspace(workspaceId: string, reason: string): number {
    return this.#revoke('workspace_id = ?', [workspaceId], reason);
  }

  /** Every live agent token (a lockdown, or "revoke all"). */
  revokeAll(reason: string): number {
    return this.#revoke('1 = 1', [], reason);
  }

  /* ---------- Verifying ---------- */

  /**
   * Checks a bearer token: it exists, wasn't revoked, hasn't expired, its workspace still has agent access, and its
   * session is still running. A session that ended without anyone revoking its token revokes it here, so a token is
   * never good past its session whatever the wiring does.
   */
  verify(secret: string): AgentVerify {
    if (!secret.startsWith(PORTAL_AGENT_TOKEN_PREFIX) || secret.length < 20 || secret.length > 128) return { ok: false, reason: 'unknown' };
    const row = this.#db?.prepare('SELECT id, workspace_id, session_id, vaults, expires_at, revoked_at FROM pmcp_agent_tokens WHERE token_hash = ?').get(hashOf(secret)) as TokenRow | undefined;
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.revoked_at) return { ok: false, reason: 'revoked', tokenId: row.id };
    const now = this.#now;
    if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: 'expired', tokenId: row.id };
    if (!this.enabled(row.workspace_id)) {
      this.#revoke('id = ?', [row.id], 'agent access turned off');
      return { ok: false, reason: 'disabled', tokenId: row.id };
    }
    if (!this.o.alive(row.session_id)) {
      this.#revoke('id = ?', [row.id], 'its session ended');
      return { ok: false, reason: 'ended', tokenId: row.id };
    }
    this.#touch(row.id, now);
    let vaults: string[] | null = null;
    try {
      const parsed: unknown = row.vaults ? JSON.parse(row.vaults) : null;
      if (Array.isArray(parsed)) vaults = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      vaults = [];
    }
    return {
      ok: true,
      principal: {
        kind: 'agent',
        tokenId: row.id,
        label: `session ${row.session_id.slice(0, 8)} in ${row.workspace_id}`,
        scope: 'agent',
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        expiresAt: row.expires_at,
        client: null,
        vaults,
      },
    };
  }

  #touch(id: string, now: Date) {
    if (now.getTime() - (this.#touched.get(id) ?? 0) < TOUCH_EVERY_MS) return;
    this.#touched.set(id, now.getTime());
    try {
      this.#writable?.prepare('UPDATE pmcp_agent_tokens SET last_used_at = ? WHERE id = ?').run(now.toISOString(), id);
    } catch {
      // bookkeeping only
    }
  }

  /** Narrows what one live token may reach in the knowledge vaults (null: whatever each vault's policy allows). */
  setVaults(tokenId: string, vaults: string[] | null): void {
    this.#writable?.prepare('UPDATE pmcp_agent_tokens SET vaults = ? WHERE id = ?').run(vaults ? JSON.stringify(vaults) : null, tokenId);
  }
}
