import { AppError } from '@isnanme/core';
import {
  workspaceRef,
  type Actor,
  type CreatePortalTokenRequest,
  type CreatedPortalToken,
  type McpMatcher,
  type PortalLockdownResult,
  type PortalMcpState,
  type PortalToken,
  type PortalToolInfo,
} from '@portal/contracts';
import { actorOfPrincipal, can, requireCan } from '../authz/seam.js';
import { isWorkspaceId } from '../names.js';
import type { Store } from '../store/store.js';
import { AgentAccess } from './agents.js';
import { ManagerTokens } from './managers.js';
import { PortalAudit } from './audit.js';
import { connectFor } from './connect.js';
import type { PortalLimits } from './limits.js';
import { agentCallable, portalTools, type PortalToolDefinition, type ToolRegistry } from './registry.js';
import { PortalMcp } from './server.js';
import { PortalMcpSettingsStore } from './settings.js';
import { PortalTokens, type ClientTokenOrigin } from './tokens.js';
import { loop } from '../platform/loops.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export interface PortalMcpModuleOptions {
  registry?: ToolRegistry;
  /** `Origin` values `/mcp` accepts besides its own and https://claude.ai. */
  extraOrigins?: string[];
  /** How workspaces reach this portal (`PORTAL_INTERNAL_URL`), shown in Access → MCP. */
  internalUrl?: string | null;
  /** What agent tokens need from the rest of the portal (interface I8): whether a session is still running, and the portal's address as a workspace reaches it. */
  agentHost?: {
    alive: (sessionId: string) => boolean;
    url: (workspaceId: string) => Promise<string | null> | string | null;
    /** The address already known for a workspace, without asking it (for a lockdown's allowlist). */
    known?: (workspaceId: string) => string | null;
  };
  /** Whether a General Manager session still runs (T-968); unset, no manager token passes. */
  managerAlive?: (sessionId: string) => boolean;
  /** T-968 review M4: whether a person is signed in now (their manager's token passes only while they are). */
  managerSignedIn?: (userId: string) => boolean;
  /** Rate limits (tests use small ones). */
  limits?: PortalLimits;
  version?: string;
  now?: () => Date;
  /** Live admin-scope tokens one label may have (the setting `mcp.tokens.maxActivePerLabel`, read on every mint). Default 3. */
  maxActivePerLabel?: () => number;
}

/**
 * Portal MCP in one place (portal-mcp PRD): the switches, the access tokens, the audit trail and the
 * `/mcp` endpoint, around the tool registry every area adds to. Made once in index.ts.
 */
export class PortalMcpModule {
  readonly registry: ToolRegistry;
  readonly settings: PortalMcpSettingsStore;
  readonly tokens: PortalTokens;
  readonly audit: PortalAudit;
  /** Agents' per-session tokens and the per-workspace opt-in (interface I8). */
  readonly agents: AgentAccess;
  /** The General Manager's tokens (cpmt_, T-968 S1). */
  readonly managers: ManagerTokens;
  readonly mcp: PortalMcp;
  readonly internalUrl: string | null;
  #timer: NodeJS.Timeout | undefined;
  readonly #agentHost: PortalMcpModuleOptions['agentHost'];
  readonly #warming = new Set<string>();
  readonly #maxActivePerLabel: () => number | undefined;
  /** Called after anything Access → MCP shows changed. */
  onChange?: () => void;
  /** Called when what a lockdown allowlist must admit for a workspace changed: its agent access, or the address its agents use. */
  onAgentAddress?: (workspaceId: string) => void;

  constructor(
    private readonly store: Store,
    opts: PortalMcpModuleOptions = {},
  ) {
    const now = opts.now ?? (() => new Date());
    this.registry = opts.registry ?? portalTools;
    this.internalUrl = opts.internalUrl ?? null;
    this.#agentHost = opts.agentHost;
    this.#maxActivePerLabel = opts.maxActivePerLabel ?? (() => undefined);
    this.settings = new PortalMcpSettingsStore(store, now);
    this.tokens = new PortalTokens(store, now);
    this.audit = new PortalAudit(store, now);
    this.agents = new AgentAccess(store, {
      alive: opts.agentHost?.alive ?? (() => false),
      url: opts.agentHost?.url ?? (() => (opts.internalUrl ? `${opts.internalUrl.replace(/\/+$/, '')}/mcp` : null)),
      mcpEnabled: () => this.settings.get().enabled,
      now,
    });
    this.managers = new ManagerTokens(store, { alive: opts.managerAlive, signedIn: opts.managerSignedIn, now });
    this.mcp = new PortalMcp({
      registry: this.registry,
      settings: this.settings,
      tokens: this.tokens,
      agents: this.agents,
      managers: this.managers,
      audit: this.audit,
      extraOrigins: opts.extraOrigins,
      limits: opts.limits,
      version: opts.version,
    });
    const changed = () => this.onChange?.();
    this.settings.onChange = changed;
    this.tokens.onChange = changed;
    this.audit.onChange = changed;
    this.agents.onChange = changed;
    this.managers.onChange = changed;
    this.agents.onAccessChange = (workspaceId) => this.onAgentAddress?.(workspaceId);
  }

  /**
   * What a lockdown allowlist (`mcp.poolOnly`) must admit for a workspace so its agents can reach this endpoint:
   * exactly the URL their session's `--mcp-config` names, and only while MCP is on and the workspace opted in. The
   * address of a Docker workspace is worked out by asking it, so when it is not known yet this answers nothing,
   * starts working it out, and `onAgentAddress` says when to compile again.
   */
  agentMatchers(workspaceId: string): McpMatcher[] {
    if (!this.settings.get().enabled || !this.agents.enabled(workspaceId)) return [];
    const url = this.#agentHost?.known?.(workspaceId) ?? null;
    if (url) return [{ serverUrl: url }];
    const resolve = this.#agentHost?.url;
    if (resolve && !this.#warming.has(workspaceId)) {
      this.#warming.add(workspaceId);
      Promise.resolve(resolve(workspaceId)).then(
        (found) => {
          if (found) this.onAgentAddress?.(workspaceId);
        },
        () => undefined,
      ).finally(() => this.#warming.delete(workspaceId));
    }
    return [];
  }

  /**
   * Prunes the audit trail now and every few hours. Skipped unless the portal trusts its database: on a frozen or
   * newer-schema one the tables may not exist, and a portal that can't write must still start and explain itself.
   */
  start(): void {
    if (!this.store.writable || !this.store.deliveryAllowed) return;
    this.#prune();
    this.#timer = setInterval(loop('portalmcp.prune', SIX_HOURS_MS, 'Portal MCP: prune expired tokens and old audit rows').wrap(() => this.#prune()), SIX_HOURS_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    void this.mcp.close().catch(() => undefined);
  }

  #prune() {
    try {
      if (!this.store.writable || !this.store.deliveryAllowed) return;
      this.audit.prune(this.settings.get().auditDays);
    } catch (e) {
      console.error(`[portal-mcp] pruning the audit trail failed: ${(e as Error).message}`);
    }
  }

  /** What an unbound token is offered right now: each tool, and whether it is listed (its switch is on). */
  toolInfos(): PortalToolInfo[] {
    const sessionControl = this.settings.get().sessionControl;
    return this.registry.list().map((t: PortalToolDefinition) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      scope: t.scope,
      agent: agentCallable(t),
      readOnly: t.hints?.readOnly ?? t.scope === 'read',
      destructive: t.hints?.destructive ?? false,
      requires: t.requires ?? null,
      listed: !(t.requires === 'session_control' && !sessionControl),
    }));
  }

  /** `GET /api/portal-mcp`. `url` is the `/mcp` URL as the admin reached the portal. */
  state(url: string): PortalMcpState {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return {
      settings: this.settings.get(),
      url,
      tokens: this.tokens.list(),
      activity: this.audit.list({ limit: 20, callsOnly: true }),
      callsToday: this.audit.countSince(midnight.toISOString()),
      tools: this.toolInfos(),
      internalUrl: this.internalUrl,
    };
  }

  /**
   * Mints an admin's token. `by` is who asked (`actorString`), written in every audit row: the mint, and one `token_revoked` row per token a
   * `replace` revoked. The label rules and the cap are the admin tokens' only (T-258); agents' per-session tokens are minted by `agents.mint`.
   */
  createToken(req: Partial<CreatePortalTokenRequest>, url: string, by = 'ui', origin?: ClientTokenOrigin): CreatedPortalToken {
    const { token, secret, replaced } = this.tokens.create(req, { maxAdminPerLabel: this.#maxActivePerLabel() }, origin);
    for (const id of replaced) {
      this.mcp.confirmations.forget(id);
      this.audit.event('token_revoked', id, { reason: 'replaced by a new token with this label', by, replacedBy: token.id });
    }
    this.audit.event('token_created', token.id, { label: token.label, scope: token.scope, expiresAt: token.expiresAt, by, ...(replaced.length ? { replaced: replaced.length } : {}) });
    return { token, secret, connect: connectFor(url, secret) };
  }

  revokeToken(id: string, reason?: string, by = 'ui'): boolean {
    const done = this.tokens.revoke(id, reason);
    if (done) {
      this.mcp.confirmations.forget(id);
      this.audit.event('token_revoked', id, { reason: reason ?? 'revoked in the portal', by });
    }
    return done;
  }

  /**
   * T-1105: a person sets (or with null clears) the workspace a token's tickets go to when a call names none. `actor` is the person (the route
   * checked their manage on the token); `known` is every workspace there is, when the caller can list them. Refused: a token that is not live,
   * a read token (it makes no tickets), a workspace that is not there, or one the person or the token may not operate.
   */
  setTokenDefaultWorkspace(id: string, raw: unknown, actor: Actor, known?: readonly string[], by = 'ui'): PortalToken {
    const token = this.tokens.get(id);
    if (!token) throw new AppError('NOT_FOUND', 'No such token.');
    if (token.revokedAt) throw new AppError('CONFLICT', 'This token has ended.');
    let workspaceId: string | null = null;
    if (raw !== null && raw !== '') {
      if (!isWorkspaceId(raw)) throw new AppError('VALIDATION_FAILED', 'A workspace is `<target>/<name>`.', { details: { defaultWorkspaceId: 'Pick a workspace.' } });
      if (token.scope === 'read') throw new AppError('VALIDATION_FAILED', 'A read token makes no tickets: give it operate or admin.', { details: { defaultWorkspaceId: 'Not for a read token.' } });
      requireCan(actor, 'operate', workspaceRef(raw));
      if (known && !known.includes(raw)) throw new AppError('NOT_FOUND', 'No such workspace.');
      const self = actorOfPrincipal({ kind: 'user', tokenId: token.id, scope: token.scope, workspaceId: null, sessionId: null });
      if (!can(self, 'operate', workspaceRef(raw)).allow) throw new AppError('FORBIDDEN', 'This token may not operate that workspace.', { details: { defaultWorkspaceId: 'Not one this token may operate.' } });
      workspaceId = raw;
    }
    if (!this.tokens.setDefaultWorkspace(id, workspaceId)) throw new AppError('CONFLICT', 'This token has ended.');
    this.audit.event('token_default_workspace', id, { workspace: workspaceId, from: token.defaultWorkspaceId, by });
    return this.tokens.get(id)!;
  }

  /** Revokes a label's live tokens (all, or all but the newest), one audit row each that says who. */
  revokeLabel(label: string, keepNewest: boolean, by = 'ui'): number {
    const reason = keepNewest ? 'older token with this label, revoked in the portal' : 'every token with this label, revoked in the portal';
    const ids = this.tokens.revokeLabel(label, keepNewest, reason);
    for (const id of ids) {
      this.mcp.confirmations.forget(id);
      this.audit.event('token_revoked', id, { reason, by });
    }
    return ids.length;
  }

  /** Revokes every live token, agents' included; with `turnOff`, MCP answers 404 until an admin turns it back on (`mcp_lockdown`). */
  lockdown(reason: string, opts: { turnOff?: boolean } = {}): PortalLockdownResult {
    const revoked = this.tokens.revokeAll(reason) + this.agents.revokeAll(reason) + this.managers.revokeAll(reason);
    if (opts.turnOff) this.settings.update({ enabled: false });
    this.audit.event(opts.turnOff ? 'lockdown' : 'revoke_all', null, { reason, revoked });
    return { revoked, enabled: this.settings.get().enabled };
  }
}
