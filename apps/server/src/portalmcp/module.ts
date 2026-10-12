import type {
  CreatePortalTokenRequest,
  CreatedPortalToken,
  McpMatcher,
  PortalLockdownResult,
  PortalMcpState,
  PortalToolInfo,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import { AgentAccess } from './agents.js';
import { PortalAudit } from './audit.js';
import { connectFor } from './connect.js';
import type { PortalLimits } from './limits.js';
import { agentCallable, portalTools, type PortalToolDefinition, type ToolRegistry } from './registry.js';
import { PortalMcp } from './server.js';
import { PortalMcpSettingsStore } from './settings.js';
import { PortalTokens } from './tokens.js';

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
  /** Rate limits (tests use small ones). */
  limits?: PortalLimits;
  version?: string;
  now?: () => Date;
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
  readonly mcp: PortalMcp;
  readonly internalUrl: string | null;
  #timer: NodeJS.Timeout | undefined;
  readonly #agentHost: PortalMcpModuleOptions['agentHost'];
  readonly #warming = new Set<string>();
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
    this.settings = new PortalMcpSettingsStore(store, now);
    this.tokens = new PortalTokens(store, now);
    this.audit = new PortalAudit(store, now);
    this.agents = new AgentAccess(store, {
      alive: opts.agentHost?.alive ?? (() => false),
      url: opts.agentHost?.url ?? (() => (opts.internalUrl ? `${opts.internalUrl.replace(/\/+$/, '')}/mcp` : null)),
      mcpEnabled: () => this.settings.get().enabled,
      now,
    });
    this.mcp = new PortalMcp({ registry: this.registry, settings: this.settings, tokens: this.tokens, agents: this.agents, audit: this.audit, extraOrigins: opts.extraOrigins, limits: opts.limits, version: opts.version });
    const changed = () => this.onChange?.();
    this.settings.onChange = changed;
    this.tokens.onChange = changed;
    this.audit.onChange = changed;
    this.agents.onChange = changed;
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
    this.#timer = setInterval(() => this.#prune(), SIX_HOURS_MS);
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

  createToken(req: Partial<CreatePortalTokenRequest>, url: string): CreatedPortalToken {
    const { token, secret } = this.tokens.create(req);
    this.audit.event('token_created', token.id, { label: token.label, scope: token.scope });
    return { token, secret, connect: connectFor(url, secret) };
  }

  revokeToken(id: string, reason?: string): boolean {
    const done = this.tokens.revoke(id, reason);
    if (done) {
      this.mcp.confirmations.forget(id);
      this.audit.event('token_revoked', id, { reason: reason ?? 'revoked in the portal' });
    }
    return done;
  }

  /** Revokes every live token, agents' included; with `turnOff`, MCP answers 404 until an admin turns it back on (`mcp_lockdown`). */
  lockdown(reason: string, opts: { turnOff?: boolean } = {}): PortalLockdownResult {
    const revoked = this.tokens.revokeAll(reason) + this.agents.revokeAll(reason);
    if (opts.turnOff) this.settings.update({ enabled: false });
    this.audit.event(opts.turnOff ? 'lockdown' : 'revoke_all', null, { reason, revoked });
    return { revoked, enabled: this.settings.get().enabled };
  }
}
