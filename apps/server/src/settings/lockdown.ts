import { createHash } from 'node:crypto';
import { claudeMinimum, SETTING_KEYS, type LockdownStatus, type McpMatcher } from '@portal/contracts';
import { versionAtLeast } from '../delivery/compile.js';
import { dropInPath } from '../delivery/ownership.js';
import type { FragmentProvider } from '../delivery/reconciler.js';
import type { Fragment } from '../delivery/types.js';
import type { Store } from '../store/store.js';
import { defineSetting } from './registry.js';
import type { Settings } from './store.js';

/**
 * The owner's "pool MCP only" settings (settings-policies PRD, MCP lockdown): two global switches, delivered
 * to every workspace as the `settings` owner's managed drop-in, `05-claudepilot-settings.json`.
 *
 * - **Account MCP off** → `disableClaudeAiConnectors: true`: Claude Code's claude.ai (SSO) connectors never
 *   load. ✅ 2.1.296 reads it from a managed drop-in: its debug log says "[claudeai-mcp] Disabled via
 *   disableClaudeAiConnectors setting" instead of "API-key auth precedence active". (Connectors only appear
 *   for a claude.ai login, which this sandbox can't do, so what a login shows is unverified.)
 * - **Pool-only MCP** → `allowManagedMcpServersOnly: true` and `allowedMcpServers` listing exactly what the
 *   pools deliver (each source reports its matchers, MCP set FR19). ✅ 2.1.296: with both, `claude mcp list`
 *   shows only the pool servers; a server in `~/.claude.json`, in a repository's `.mcp.json` or in
 *   `--mcp-config` (the portal's own, unless a source admits it) is blocked; `claude mcp add` itself refuses
 *   ("not allowed by enterprise policy"); a user-level `allowedMcpServers` can't widen it; an empty allowlist
 *   blocks every server, pool ones too.
 *
 * Not a boundary against someone with `sudo` (foundation §2): managed settings are precedence, and the
 * reconciler puts the file back. It does stop Claude's own routes to a new connection.
 */
export const MIN_CLAUDE_VERSION = claudeMinimum('mcp-lockdown'); // the feature-minimum registry (claude-version-pinning PRD §5)

defineSetting({
  key: SETTING_KEYS.mcpAccountOff,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'mcp',
  order: 10,
  label: 'Account MCP off',
  help: 'claude.ai connectors (the SSO ones: Gmail, Drive, Slack and the rest) never load in a workspace, whoever is signed in. Takes effect in sessions that start after the change.',
  confirmText: 'Account connectors load again in new sessions.',
  protective: true,
});

defineSetting({
  key: SETTING_KEYS.mcpPoolOnly,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'mcp',
  order: 20,
  label: 'Pool MCP only',
  help: 'Only servers from the MCP pool may load. A server added by a user, a repository (.mcp.json) or Claude itself is blocked, and so is “claude mcp add”. Claude can propose one for a person to approve. With no pool servers, no MCP loads at all.',
  confirmText: 'Users, repositories and Claude can add MCP servers again.',
  protective: true,
});

/** What an allowlist source reports: the matchers of the servers a part of the portal delivers into this workspace. */
export type MatcherSource = (workspaceId: string) => McpMatcher[];

const json = (v: unknown) => JSON.stringify(v);
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * The MCP lockdown as a fragment provider (it has no pools), plus each workspace's status: Locked once the
 * change is in place and no running session predates it, Pending while it's on its way or such sessions run
 * (✅ A3c: Claude Code never applies managed settings to a session that started before the managed folder
 * existed, so those must be restarted), Not protected with the reason when delivery can't hold it.
 */
export class McpLockdown implements FragmentProvider {
  readonly type = 'settings' as const;
  readonly #sources: MatcherSource[] = [];
  /** What the last compile of each workspace asked for (a hash of the settings, null for none), for `delivered`. */
  readonly #compiled = new Map<string, string | null>();

  /** Asks for another delivery pass of a workspace soon (set by the settings module): the one after a change reads the sessions' ages. */
  recheck: ((workspaceId: string) => void) | null = null;

  constructor(
    private readonly store: Store,
    private readonly settings: Settings,
  ) {}

  /**
   * A part of the portal that delivers MCP servers registers what to allow for each workspace: the MCP sets'
   * launchers and URLs (registered here), the browser pool's servers, the portal's own MCP endpoint that a chat
   * session is given at launch (`--mcp-config`: ✅ blocked unless its URL is listed).
   */
  addMatcherSource(source: MatcherSource): void {
    this.#sources.push(source);
  }

  /** Every source's matchers for the workspace, each once, in a stable order. */
  matchers(workspaceId: string): McpMatcher[] {
    const seen = new Map<string, McpMatcher>();
    for (const source of this.#sources) {
      try {
        for (const m of source(workspaceId)) seen.set(json(m), m);
      } catch (e) {
        // A source that fails must not widen the allowlist or break delivery: its servers are just not admitted.
        console.error(`[settings] an MCP matcher source failed for ${workspaceId}: ${(e as Error).message}`);
      }
    }
    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, m]) => m);
  }

  /** The settings the lockdown asks of a workspace, or null when both switches are off. */
  desired(workspaceId: string): Record<string, unknown> | null {
    const accountOff = this.settings.get<boolean>(SETTING_KEYS.mcpAccountOff);
    const poolOnly = this.settings.get<boolean>(SETTING_KEYS.mcpPoolOnly);
    if (!accountOff && !poolOnly) return null;
    return {
      ...(accountOff ? { disableClaudeAiConnectors: true } : {}),
      ...(poolOnly ? { allowManagedMcpServersOnly: true, allowedMcpServers: this.matchers(workspaceId) } : {}),
    };
  }

  /* ---------- Delivery ---------- */

  knownPools(): string[] {
    return [];
  }

  fragments(workspaceId: string): Fragment[] {
    const settings = this.desired(workspaceId);
    this.#compiled.set(workspaceId, settings ? sha(json(settings)) : null);
    return settings ? [{ owner: 'settings', settings, minClaudeVersion: MIN_CLAUDE_VERSION }] : [];
  }

  /**
   * After a successful delivery: remember when the lockdown last changed here, and how many running sessions
   * predate that. Conservative on purpose, since "Locked" is a security claim:
   * - the change counts from when the write finished, not from when the pass began;
   * - the ages a pass reads are from before its own write, so the pass that changed the lockdown can't say
   *   which sessions it missed (-1, "checking") and asks for another pass a moment later, which reads them again;
   * - a process counts as older when it could be (ages are whole seconds, so one more second is allowed).
   */
  delivered(workspaceId: string, ctx: { running: boolean; now: Date; delivered: Set<string>; claudeAges?: number[] | null; landedAt?: number }): void {
    const hash = this.#compiled.get(workspaceId);
    this.#compiled.delete(workspaceId);
    const db = this.store.db;
    if (hash === undefined || !db || !this.store.writable) return;
    try {
      if (hash === null) {
        db.prepare('DELETE FROM lockdown_state WHERE workspace_id = ?').run(workspaceId);
        return;
      }
      // The drop-in was skipped (Claude Code too old): nothing landed, so nothing to record.
      const file = dropInPath('settings');
      if (file && !ctx.delivered.has(file)) return;
      const row = db.prepare('SELECT hash, changed_at, old_sessions FROM lockdown_state WHERE workspace_id = ?').get(workspaceId) as { hash: string; changed_at: string; old_sessions: number } | undefined;
      const changed = !row || row.hash !== hash;
      const changedAt = changed ? new Date(ctx.landedAt ?? ctx.now.getTime()).toISOString() : row.changed_at;
      const since = ctx.now.getTime() - new Date(changedAt).getTime();
      const old = !ctx.running ? 0 : changed ? -1 : ctx.claudeAges ? ctx.claudeAges.filter((a) => (a + 1) * 1000 > since).length : row.old_sessions;
      db.prepare(
        `INSERT INTO lockdown_state (workspace_id, hash, changed_at, old_sessions, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET hash = excluded.hash, changed_at = excluded.changed_at, old_sessions = excluded.old_sessions, updated_at = excluded.updated_at`,
      ).run(workspaceId, hash, changedAt, old, ctx.now.toISOString());
      if (old < 0) this.recheck?.(workspaceId);
    } catch (e) {
      console.error(`[settings] recording the lockdown state of ${workspaceId} failed: ${(e as Error).message}`);
    }
  }

  /* ---------- Status ---------- */

  status(workspaceId: string): LockdownStatus {
    const accountOff = this.settings.get<boolean>(SETTING_KEYS.mcpAccountOff);
    const poolOnly = this.settings.get<boolean>(SETTING_KEYS.mcpPoolOnly);
    const base = { workspaceId, accountOff, poolOnly, restart: 0 };
    const desired = this.desired(workspaceId);
    if (!desired) return { ...base, state: 'off', reason: null };
    try {
      const db = this.store.db;
      const row = db?.prepare('SELECT status, reason, claude_version, applied_at FROM workspace_delivery WHERE workspace_id = ?').get(workspaceId) as
        | { status: string; reason: string | null; claude_version: string | null; applied_at: string | null }
        | undefined;
      if (!row || !row.applied_at) return { ...base, state: 'pending', reason: 'Not delivered yet.' };
      const version = row.claude_version?.replace(/\s*\(Claude Code\)/, '') ?? null;
      if (version && !versionAtLeast(version, MIN_CLAUDE_VERSION)) return { ...base, state: 'not_protected', reason: `Claude Code ${version} is too old (needs ${MIN_CLAUDE_VERSION}).` };
      if (row.status === 'locked') return { ...base, state: 'not_protected', reason: 'The portal is Locked: nothing is delivered.' };
      if (row.status === 'frozen') return { ...base, state: 'not_protected', reason: 'Delivery is frozen for this workspace.' };
      if (row.status === 'failed') return { ...base, state: 'not_protected', reason: row.reason ? `Delivery failed: ${row.reason}` : 'The last delivery failed.' };
      if (row.status === 'unsupported') return { ...base, state: 'not_protected', reason: row.reason ?? 'Delivery isn’t available for this target yet.' };
      if (row.status !== 'synced') return { ...base, state: 'pending', reason: 'Delivering.' };
      const state = db?.prepare('SELECT hash, old_sessions FROM lockdown_state WHERE workspace_id = ?').get(workspaceId) as { hash: string; old_sessions: number } | undefined;
      if (!state || state.hash !== sha(json(desired))) return { ...base, state: 'pending', reason: 'A change is on its way.' };
      if (state.old_sessions < 0) return { ...base, state: 'pending', reason: 'Checking the running sessions.' };
      if (state.old_sessions > 0)
        return { ...base, state: 'pending', restart: state.old_sessions, reason: `${state.old_sessions} running session${state.old_sessions === 1 ? '' : 's'} started before the change: restart ${state.old_sessions === 1 ? 'it' : 'them'}.` };
      return { ...base, state: 'locked', reason: null };
    } catch {
      return { ...base, state: 'not_protected', reason: 'The state couldn’t be read.' };
    }
  }

  /** A workspace was removed: nothing to remember about it. */
  forgetWorkspace(workspaceId: string): void {
    this.#compiled.delete(workspaceId);
    if (this.store.writable) {
      try {
        this.store.db!.prepare('DELETE FROM lockdown_state WHERE workspace_id = ?').run(workspaceId);
      } catch {
        // The table may not exist on an older schema.
      }
    }
  }
}
