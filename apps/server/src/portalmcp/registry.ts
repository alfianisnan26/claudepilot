import type { PortalCallerScope, PortalScope } from '@portal/contracts';
import { z } from 'zod';
import { toolPolicyFor } from '../authz/seam.js';
import type { UntrustedText } from './sanitize.js';
import { UNDECLARED_TOOLS } from './undeclaredTools.js';

// The Portal MCP tool registry (interface I2). Every area adds the tools of its own feature from its own
// `portalTools.ts`, which index.ts calls once at startup:
//
//   import { registerPortalTool, z } from '../portalmcp/registry.js';
//
//   export function registerTicketTools(tickets: Tickets) {
//     registerPortalTool({
//       name: 'ticket_get',                     // snake_case noun_verb, no dots (Claude Code shows mcp__pilot__ticket_get)
//       title: 'Get a ticket',
//       description: 'One ticket with its timeline.',   // what it does, at most 1,000 characters, no instructions to Claude
//       scope: 'agent',                         // 'read' | 'operate' | 'admin' for an admin's tokens; 'agent' also for agents (see below)
//       hints: { readOnly: true },
//       input: z.object({ id: z.string().describe('Ticket id, e.g. T-12') }),
//       async handler(ctx, { id }) {            // args are validated against `input` before this runs
//         const t = tickets.get(ctx.actor, id);
//         return { summary: `${t.id}: ${t.status}`, ticket: { ...t, description: ctx.untrusted(t.description, 'ticket') } };
//       },
//     });
//   }
//
// Scopes (portal-mcp.md §12.4, interface I8):
// - An admin's token (cpat_) has `read`, `operate` or `admin`, each including the ones before it. A tool with one of those
//   scopes needs at least it.
// - An agent's token (cpst_) is minted for ONE chat session, bound to its workspace and session, and has the scope `agent`.
//   It reaches only tools that opt in: `scope: 'agent'`, or (older code) `audience: 'both'`. Never an operate or admin tool.
// - `scope: 'agent'` is the lowest tier: an admin's token reaches the tool too, with `read` when `hints.readOnly` is set and
//   `operate` otherwise. The handler MUST keep an agent to its own workspace and session: `ctx.workspaceId` and `ctx.sessionId`
//   are verified from the token (never from arguments or headers), `ctx.assertWorkspace(id)` and `ctx.assertSession(id)` check others.
//
// Rules a handler lives by (portal-mcp.md §6, §14):
// - Return a plain object. A top-level `summary` string becomes the one-line text the model reads first.
// - Never return a secret value: masked values, fingerprints, "set" or "missing" only. Every string in a
//   result is redacted and stripped of escape sequences as a backstop, but that is not a licence.
// - Text that came from an agent, a workspace, a runtime or a third party goes through `ctx.untrusted(text, source)`,
//   which labels it so the model can tell data from instructions, and never into a description.
// - Throw `AppError` (NOT_FOUND, VALIDATION_FAILED, CONFLICT, FORBIDDEN …) or `PortalToolError` for a failure the
//   caller can fix: it becomes a tool error with a code. Anything else is an internal error and says nothing.
// - Destructive tools ask first: `ctx.confirm(args, preview)` returns the `confirmation_required` result to
//   send back, or null once a valid `confirm_token` came with the call (add `confirm_token: z.string().optional()` to `input`).
// - A tool that PROPOSES something for a person to review (an MCP server, a persona change, a skill) is audited with its actor
//   like every call; give it `rate: { perHour: 10 }` and a `maxArgsBytes` so a looping or injected agent can't flood the queue.
//   Nothing an agent can call may approve, publish or deliver anything: that is a person's click in the portal.

export { z };
export type { PortalCallerScope, PortalScope };

/** Higher includes lower (PRD §12.4). */
export const SCOPE_RANK: Record<PortalScope, number> = { read: 0, operate: 1, admin: 2 };

export const scopeAllows = (granted: PortalScope, needed: PortalScope): boolean => SCOPE_RANK[granted] >= SCOPE_RANK[needed];

/** Who is calling: the token behind an authenticated request. */
export interface PortalPrincipal {
  /** `user`: an admin's token (cpat_). `agent`: a per-session token (cpst_) minted for one chat session. */
  kind: 'user' | 'agent';
  tokenId: string;
  label: string;
  scope: PortalCallerScope;
  /** Verified from an agent's token; null for an admin's. */
  workspaceId: string | null;
  /** Verified from an agent's token; null for an admin's. */
  sessionId: string | null;
  expiresAt: string;
  /** Unverified: what the client called itself (`name/version`). */
  client: string | null;
  /** The knowledge vaults this token may use, or null for whatever each vault's own policy allows. */
  vaults: string[] | null;
}

/** The portal-wide switches a tool may depend on. */
export interface PortalToolSettings {
  sessionControl: boolean;
  /** A change reaching more workspaces than this needs confirming (PRD §13: C*). */
  confirmAbove: number;
}

export interface PortalToolContext {
  readonly principal: PortalPrincipal;
  /** What events this call causes record as their actor: `session:<id>` for an agent, `portal-mcp:<token id>` otherwise. */
  readonly actor: string;
  /**
   * How the actor is named wherever it is shown (transcript, ticket timeline, CI run, repository events, audit): the label the owner gave
   * the token, as it is now (a later rename never changes what was stored). Undefined for an agent's per-session token, which is shown as
   * its session. Pass it as `actorLabel` with `actor` to anything that sends or starts something.
   */
  readonly actorLabel: string | undefined;
  /** The caller's scope: `read`, `operate`, `admin`, or `agent`. */
  readonly scope: PortalCallerScope;
  /** The caller is an agent's per-session token. */
  readonly isAgent: boolean;
  readonly requestId: string;
  /** The workspace an agent works in, verified from its token; null for an admin's token. */
  readonly workspaceId: string | null;
  /** The chat session an agent is, verified from its token; null for an admin's token. */
  readonly sessionId: string | null;
  /** The knowledge vaults this token may use, or null for whatever each vault's own policy allows. */
  readonly vaults: string[] | null;
  readonly settings: PortalToolSettings;
  /** Aborted when the client goes away. */
  readonly signal: AbortSignal;
  /** Throws FORBIDDEN unless the caller may act on `workspaceId` (an agent only on its own; an admin's token on any). */
  assertWorkspace(workspaceId: string): void;
  /** Throws FORBIDDEN unless the caller may act as `sessionId` (an agent only as its own; an admin's token as any). */
  assertSession(sessionId: string): void;
  /** Labels text from agents, workspaces, runtimes and third parties (§14.4): cleaned, capped at 2,000 characters (`maxChars` may raise it to 8,000 for a document-sized field). */
  untrusted(text: string | null | undefined, source: string, maxChars?: number): UntrustedText | null;
  /**
   * The confirmation gate (§14.1). Call it before a destructive change with a `preview` of what will happen:
   * it returns the result to send back (`confirmation_required` and a single-use `confirm_token`), or null when
   * `args.confirm_token` is one this principal was given for these exact arguments, and the preview is unchanged.
   * `target` pins what the token is for (an id plus its created_at or revision); if it changed, a new token is asked for.
   */
  confirm(args: { confirm_token?: string | undefined }, preview: Record<string, unknown>, target?: string): PortalToolResult | null;
  /** Names what the call changed (`workspace:docker/api`, `ticket:T-4`) for the audit row. */
  affected(...refs: string[]): void;
  /** Reports progress of a long call, when the client asked for it. Best effort; never throws. */
  progress(message: string): void;
}

/** What a handler returns: an object (it becomes `structuredContent`); `summary` is the one-line text. */
export type PortalToolResult = Record<string, unknown> & { summary?: string };

export interface PortalToolHints {
  /** Defaults to true for `read` tools. */
  readOnly?: boolean;
  /** Changes or removes something that can't simply be put back. Defaults to false. */
  destructive?: boolean;
  /** Calling twice with the same arguments has the same effect as once. Defaults to `readOnly`. */
  idempotent?: boolean;
  /** Reaches outside the portal (a network call). Defaults to false. */
  openWorld?: boolean;
}

export interface PortalToolDefinition<S extends z.ZodObject = z.ZodObject> {
  /** snake_case `<noun>_<verb>`, 3 to 48 characters. */
  name: string;
  title: string;
  /** What the tool does, at most 1,000 characters. Never instructions to the model, never workspace text. */
  description: string;
  /** What a token needs; `agent` also opens the tool to agents' per-session tokens (see the header). */
  scope: PortalCallerScope;
  /** Older spelling of "also for agents" on a tool with an admin scope: `both`. Prefer `scope: 'agent'`. */
  audience?: 'outside' | 'both';
  /** The tool is listed only while this portal switch is on (PRD FR15). */
  requires?: 'session_control';
  hints?: PortalToolHints;
  /** Per token: at most this many calls of this tool a minute and an hour (proposals, anything that fills a queue). */
  rate?: { perMinute?: number; perHour?: number };
  /** Refuses arguments larger than this many bytes of JSON. Agents' calls default to 32 KB. */
  maxArgsBytes?: number;
  /** The arguments. Use `z.object({})` for none. */
  input: S;
  /** The shape of `structuredContent`, when worth declaring; the SDK checks results against it. */
  output?: z.ZodType;
  handler(ctx: PortalToolContext, args: z.output<S>): PortalToolResult | Promise<PortalToolResult>;
}

/** Whether an agent's per-session token may call the tool. */
export const agentCallable = (t: Pick<PortalToolDefinition, 'scope' | 'audience'>): boolean => t.scope === 'agent' || t.audience === 'both';

/** The tier an admin's token needs for the tool: an `agent` tool is `read` when it only reads, `operate` otherwise. */
export function userTier(t: Pick<PortalToolDefinition, 'scope' | 'hints'>): PortalScope {
  return t.scope === 'agent' ? (t.hints?.readOnly ? 'read' : 'operate') : t.scope;
}

/** A failure the caller can act on: becomes a tool error (`isError: true`) with this code and these details. */
export class PortalToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PortalToolError';
  }
}

/** A change only the portal's UI may make (PRD §6): the call changes nothing and says where to do it. */
export const uiOnly = (what: string, where: string, details?: unknown) =>
  new PortalToolError('UI_ONLY', `${what} Do it in the portal: ${where}`, details);

const NAME = /^[a-z][a-z0-9_]{2,47}$/;
export const DESCRIPTION_MAX = 1_000;

/**
 * FR19 (T-356): with this set, the registry refuses a tool that has no declared access policy (`declareToolPolicies` in its module's `authz.ts`,
 * declared BEFORE the tool is registered) unless it is in `exempt`, the closed list of tools that predate the rule (`undeclaredTools.ts`; it only
 * ever shrinks). `isDeclared` is injected so the registry stays free of the seam.
 */
export interface RequireDeclared {
  isDeclared(name: string): boolean;
  exempt: ReadonlySet<string>;
}

/** The tools of this portal. One instance (`portalTools`) is the default; tests make their own. */
export class ToolRegistry {
  readonly #tools = new Map<string, PortalToolDefinition>();
  readonly #requireDeclared: RequireDeclared | undefined;

  constructor(opts: { requireDeclared?: RequireDeclared } = {}) {
    this.#requireDeclared = opts.requireDeclared;
  }

  register<S extends z.ZodObject>(tool: PortalToolDefinition<S>): void {
    if (!NAME.test(tool.name)) throw new Error(`portal tool name "${tool.name}" must be snake_case, 3 to 48 characters`);
    if (this.#requireDeclared && !this.#requireDeclared.isDeclared(tool.name) && !this.#requireDeclared.exempt.has(tool.name))
      throw new Error(`portal tool "${tool.name}" declares no access policy (FR19): declare it with declareToolPolicies in its module's authz.ts before registering it`);
    if (this.#tools.has(tool.name)) throw new Error(`portal tool "${tool.name}" is already registered`);
    if (!tool.title.trim()) throw new Error(`portal tool "${tool.name}" needs a title`);
    if (!tool.description.trim() || tool.description.length > DESCRIPTION_MAX)
      throw new Error(`portal tool "${tool.name}": the description must be 1 to ${DESCRIPTION_MAX} characters`);
    if (tool.scope !== 'agent' && !(tool.scope in SCOPE_RANK)) throw new Error(`portal tool "${tool.name}": unknown scope "${String(tool.scope)}"`);
    // What an agent may call can change little and can never be undone: no destructive tool, whatever its tier.
    if (agentCallable(tool) && tool.hints?.destructive) throw new Error(`portal tool "${tool.name}" is destructive, so it can't be offered to agents`);
    this.#tools.set(tool.name, tool as unknown as PortalToolDefinition);
  }

  get(name: string): PortalToolDefinition | undefined {
    return this.#tools.get(name);
  }

  /** Registration order. */
  list(): PortalToolDefinition[] {
    return [...this.#tools.values()];
  }

  get size(): number {
    return this.#tools.size;
  }
}

/**
 * The portal's registry: `registerPortalTool` adds to it, `/mcp` serves from it. FR19 (T-356) is on here: a tool with no declared access policy
 * and not on the closed list of tools that predate the rule is refused at registration, so the server does not start with it. The modules'
 * policies are declared first, by `declareAllToolPolicies` (portalmcp/declareAll.ts), which index.ts calls before any registration.
 */
export const portalTools = new ToolRegistry({ requireDeclared: { isDeclared: (name) => toolPolicyFor(name) !== undefined, exempt: UNDECLARED_TOOLS } });

/** Adds a tool to the portal's registry (interface I2). Throws on a bad or duplicate definition, at startup. */
export function registerPortalTool<S extends z.ZodObject>(tool: PortalToolDefinition<S>): void {
  portalTools.register(tool);
}
