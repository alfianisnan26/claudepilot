import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '@isnanme/core';
import { PORTAL_AGENT_TOKEN_PREFIX } from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { WorkspaceRefs } from '../workspaces/identity.js';
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
  mint(req: { workspaceId: string; sessionId: string }, opts?: { keepOthers?: boolean }): Promise<AgentGrant | null>;
  settle(sessionId: string, tokenId: string, started: boolean): void;
  revokeSession(sessionId: string, reason: string): number;
}

/** How often one session's stale-token heal may fire (a restart that fails is not retried in a loop). */
export const STALE_HEAL_EVERY_MS = 10 * 60_000;

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
  revoked_reason?: string | null;
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
  /**
   * Self-heal (owner, 2026-10-17: "harusnya bisa otomatis auto heal apapun caranya"): a session that is still alive called with a token that
   * was replaced or ran out. A running process can't be handed a new token, so the portal restarts it (index.ts: at the turn's end, the same
   * conversation), and the new process starts with a good one. At most once in `STALE_HEAL_EVERY_MS` per session.
   */
  onStaleToken?: (sessionId: string, reason: 'revoked' | 'expired') => void;
  readonly #healed = new Map<string, number>();
  /** Called when a workspace's opt-in is turned on or off (what a lockdown allowlist must admit changes with it). */
  onAccessChange?: (workspaceId: string) => void;
  /**
   * The workspaces' registry (T-42 slice 3): the opt-in and the tokens store the workspace's stable id and read it back as the key the rest of
   * the portal speaks (a token's principal carries the key). Rows written before (a key) read and match as they are. index.ts sets it; unset,
   * stored as given.
   */
  workspaceRefs?: WorkspaceRefs;
  /** T-436: the vault ids a workspace's agents may reach (the knowledge service's `vaultsForWorkspace`). Unset: a token is bound to no vault. */
  vaultsFor?: (workspaceId: string) => string[];

  constructor(
    private readonly store: Store,
    private readonly o: AgentAccessOptions,
  ) {}

  /** Every form one workspace's rows may hold while the move to the stable id runs. */
  #forms(workspaceId: string): { sql: string; args: string[] } {
    const forms = this.workspaceRefs ? this.workspaceRefs.storedForms(workspaceId) : [workspaceId];
    return { sql: `workspace_id IN (${forms.map(() => '?').join(', ')})`, args: forms };
  }

  #stored(workspaceId: string): string {
    return this.workspaceRefs?.storedRef(workspaceId) ?? workspaceId;
  }

  #key(stored: string): string {
    return this.workspaceRefs?.keyOf(stored) ?? stored;
  }

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
      // On what is stored: the opt-in of a REMOVED workspace (its id) is not the opt-in of a new workspace that took the name.
      const mine = this.#forms(workspaceId);
      return !!this.#db?.prepare(`SELECT 1 AS x FROM pmcp_agent_access WHERE ${mine.sql}`).get(...mine.args);
    } catch {
      return false; // no such table (a failed migration): nobody has opted in
    }
  }

  /** A stored reference that stands for a live workspace: a key (as before slice 3), or the id of one not removed. */
  #isLive(stored: string): boolean {
    if (!this.workspaceRefs) return true;
    const key = this.#key(stored);
    return this.workspaceRefs.storedForms(key).includes(stored);
  }

  /** The opt-in of the workspace a token was minted for, by what the token stored: its own workspace's, never a successor's of that name. */
  #enabledAsStored(stored: string): boolean {
    return this.#isLive(stored) && this.enabled(this.#key(stored));
  }

  /** Workspaces that opted in. */
  enabledWorkspaces(): string[] {
    const rows = this.#db?.prepare('SELECT workspace_id FROM pmcp_agent_access ORDER BY workspace_id').all() as
      { workspace_id: string }[] | undefined;
    // Only live workspaces' opt-ins count (a removed one's stays on record as its id, which reads as no live workspace's key).
    return [...new Set((rows ?? []).filter((r) => this.#isLive(r.workspace_id)).map((r) => this.#key(r.workspace_id)))].sort();
  }

  /** Turns agent access on or off for a workspace. Turning it off revokes every token its sessions hold. */
  setEnabled(workspaceId: string, enabled: boolean): { revoked: number } {
    const db = this.#writable;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    // Plain names only, as for every workspace route: a name is never anything a path, a shell or a URL could read differently.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(workspaceId))
      throw new AppError('VALIDATION_FAILED', 'A workspace is `<target>/<name>`.');
    let revoked = 0;
    const was = this.enabled(workspaceId);
    if (enabled) {
      if (!was)
        db.prepare('INSERT INTO pmcp_agent_access (workspace_id, enabled_at) VALUES (?, ?) ON CONFLICT (workspace_id) DO NOTHING').run(
          this.#stored(workspaceId),
          this.#now.toISOString(),
        );
    } else {
      const mine = this.#forms(workspaceId);
      db.prepare(`DELETE FROM pmcp_agent_access WHERE ${mine.sql}`).run(...mine.args);
      revoked = this.revokeWorkspace(workspaceId, 'agent access turned off');
    }
    this.onChange?.();
    if (was !== enabled) this.onAccessChange?.(workspaceId);
    return { revoked };
  }

  /** Live tokens per workspace, for the page. */
  liveCounts(): Map<string, number> {
    const rows = this.#db
      ?.prepare(
        'SELECT workspace_id, count(*) AS n FROM pmcp_agent_tokens WHERE revoked_at IS NULL AND expires_at > ? GROUP BY workspace_id',
      )
      .all(this.#now.toISOString()) as { workspace_id: string; n: number }[] | undefined;
    const out = new Map<string, number>();
    for (const r of rows ?? []) {
      const key = this.#key(r.workspace_id);
      out.set(key, (out.get(key) ?? 0) + r.n);
    }
    return out;
  }

  liveTotal(): number {
    let n = 0;
    for (const c of this.liveCounts().values()) n += c;
    return n;
  }

  /* ---------- Minting and revoking ---------- */

  /**
   * Mints the token for one session at its launch, revoking the one it had (a Claude switch gives the new process a
   * new token). With `keepOthers` the old one stays good until `settle` says whether a new process really started: a start the host
   * answers "already running" (exit 3) attaches to the process that holds the OLD token, and revoking it then cut that process off
   * from every portal tool until a person reconnected it (Konfersi lead, 2026-10-17 19:17). Null when the workspace hasn't opted in, MCP is off, the session isn't running, or the portal's
   * address can't be worked out for that workspace: the session then simply runs without portal tools.
   */
  async mint(req: { workspaceId: string; sessionId: string }, opts: { keepOthers?: boolean } = {}): Promise<AgentGrant | null> {
    const { workspaceId, sessionId } = req;
    if (!this.enabled(workspaceId) || this.o.mcpEnabled?.() === false || !this.o.alive(sessionId)) return null;
    const db = this.#writable;
    if (!db) return null;
    const url = await this.o.url(workspaceId);
    if (!url) {
      if (!this.#warned.has(workspaceId)) {
        this.#warned.add(workspaceId);
        console.warn(
          `[portal-mcp] agents in ${workspaceId} get no portal tools: the portal's address as that workspace reaches it is unknown (set PORTAL_INTERNAL_URL)`,
        );
      }
      return null;
    }
    if (!opts.keepOthers) this.revokeSession(sessionId, 'replaced by a new token');
    const secret = `${PORTAL_AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = `agt_${randomBytes(6).toString('hex')}`;
    const now = this.#now;
    // T-436: bound to its workspace's vaults at mint. No lookup wired, or a lookup that fails: bound to none (never to all).
    const vaults = this.#vaultsOf(workspaceId);
    db.prepare(
      'INSERT INTO pmcp_agent_tokens (id, token_hash, workspace_id, session_id, created_at, expires_at, vaults) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      hashOf(secret),
      this.#stored(workspaceId),
      sessionId,
      now.toISOString(),
      new Date(now.getTime() + AGENT_TOKEN_TTL_MS).toISOString(),
      JSON.stringify(vaults),
    );
    this.onChange?.();
    return {
      tokenId: id,
      env: { PILOT_MCP_TOKEN: secret, PILOT_SESSION_ID: sessionId, PILOT_WORKSPACE_ID: workspaceId, PILOT_MCP_URL: url },
      mcpConfig: AGENT_MCP_CONFIG,
    };
  }

  #vaultsOf(workspaceId: string): string[] {
    try {
      return this.vaultsFor ? [...this.vaultsFor(workspaceId)] : [];
    } catch {
      return [];
    }
  }

  /** Binds every live token again to its workspace's vaults (a vault's list of agent workspaces changed). Returns how many tokens changed. */
  rebindVaults(): number {
    const db = this.#writable;
    if (!db) return 0;
    const rows = db
      .prepare('SELECT id, workspace_id, vaults FROM pmcp_agent_tokens WHERE revoked_at IS NULL AND expires_at > ?')
      .all(this.#now.toISOString()) as { id: string; workspace_id: string; vaults: string | null }[];
    let n = 0;
    for (const r of rows) {
      const next = JSON.stringify(this.#vaultsOf(this.#key(r.workspace_id)));
      if (next === r.vaults) continue;
      this.setVaults(r.id, JSON.parse(next) as string[]);
      n++;
    }
    return n;
  }

  /** Shuts every live token out of the vaults at once (one statement): the fail-closed step when a rebind throws. Returns how many changed. */
  closeVaults(): number {
    const db = this.#writable;
    if (!db) return 0;
    return Number(
      db.prepare("UPDATE pmcp_agent_tokens SET vaults = '[]' WHERE revoked_at IS NULL AND (vaults IS NULL OR vaults != '[]')").run()
        .changes,
    );
  }

  #revoke(where: string, args: string[], reason: string): number {
    const db = this.#writable;
    if (!db) return 0;
    const r = db
      .prepare(`UPDATE pmcp_agent_tokens SET revoked_at = ?, revoked_reason = ? WHERE ${where} AND revoked_at IS NULL`)
      .run(this.#now.toISOString(), reason, ...args);
    if (r.changes > 0) this.onChange?.();
    return Number(r.changes);
  }

  /** The session ended, was archived or deleted, or switched Claude: its tokens stop working on their next call. */
  /**
   * After a launch with `keepOthers`: a new process started, so every other token of the session goes; or none did (the host said "already
   * running", or the start failed), so the unused new one goes and the running process keeps its own.
   */
  settle(sessionId: string, tokenId: string, started: boolean): void {
    if (started) this.#revoke('session_id = ? AND id != ?', [sessionId, tokenId], 'replaced by a new token');
    else this.#revoke('id = ?', [tokenId], 'its launch started no new process');
  }

  revokeSession(sessionId: string, reason: string): number {
    return this.#revoke('session_id = ?', [sessionId], reason);
  }

  revokeWorkspace(workspaceId: string, reason: string): number {
    const mine = this.#forms(workspaceId);
    return this.#revoke(mine.sql, mine.args, reason);
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
    const row = this.#db
      ?.prepare('SELECT id, workspace_id, session_id, vaults, expires_at, revoked_at, revoked_reason FROM pmcp_agent_tokens WHERE token_hash = ?')
      .get(hashOf(secret)) as TokenRow | undefined;
    if (!row) return { ok: false, reason: 'unknown' };
    // The token's workspace as stored decides (a removed workspace's token never passes as a new one's); the principal carries the key.
    const stored = row.workspace_id;
    row.workspace_id = this.#key(stored);
    const now = this.#now;
    if (row.revoked_at) {
      // Only a token that lost to a newer one of the same session heals by itself; one revoked on purpose (access off, the session ended,
      // a lockdown) stays refused.
      if (row.revoked_reason === 'replaced by a new token' || row.revoked_reason === 'its launch started no new process') this.#stale(row.session_id, 'revoked', now);
      return { ok: false, reason: 'revoked', tokenId: row.id };
    }
    if (Date.parse(row.expires_at) <= now.getTime()) {
      this.#stale(row.session_id, 'expired', now);
      return { ok: false, reason: 'expired', tokenId: row.id };
    }
    if (!this.#enabledAsStored(stored)) {
      this.#revoke('id = ?', [row.id], 'agent access turned off');
      return { ok: false, reason: 'disabled', tokenId: row.id };
    }
    if (!this.o.alive(row.session_id)) {
      this.#revoke('id = ?', [row.id], 'its session ended');
      return { ok: false, reason: 'ended', tokenId: row.id };
    }
    this.#touch(row.id, now);
    // T-436: an agent token is never unbound: no list (a token minted before the bind), or one that does not parse, reaches no vault.
    let vaults: string[] = [];
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

  #stale(sessionId: string, reason: 'revoked' | 'expired', now: Date) {
    if (!this.onStaleToken || !this.o.alive(sessionId)) return;
    if (now.getTime() - (this.#healed.get(sessionId) ?? 0) < STALE_HEAL_EVERY_MS) return;
    this.#healed.set(sessionId, now.getTime());
    try {
      this.onStaleToken(sessionId, reason);
    } catch {
      // the next stale call tries again after the pause
    }
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

  /** Sets what one live token may reach in the knowledge vaults. An agent token reads no list (null) as none, never as all. */
  setVaults(tokenId: string, vaults: string[] | null): void {
    this.#writable?.prepare('UPDATE pmcp_agent_tokens SET vaults = ? WHERE id = ?').run(vaults ? JSON.stringify(vaults) : null, tokenId);
  }
}
