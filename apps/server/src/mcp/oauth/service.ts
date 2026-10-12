import { AppError } from '@isnanme/core';
import type { McpAuthEntry, McpServerAuth, McpSignInRequest, McpSignInStart } from '@portal/contracts';
import type { WorkspaceStep } from '../../delivery/steps.js';
import type { DeliveryAccess } from '../../workspaces/runtime.js';
import type { Compiled } from '../kind.js';
import { scrubOAuth, stripTerminal } from './parse.js';
import { SignIns, type OAuthHost } from './signin.js';
import { asClaude, AuthStatus, checkScript, checkTimeoutMs, CLAUDE_DIR, serverName, validServer, type OAuthServer } from './status.js';

/**
 * OAuth for MCP servers, in one place (MCP set PRD §13.3, M2): each OAuth server's sign-in state per workspace
 * and Claude (`status`), and the guided sign-in and sign-out (`signIns`, `signOut`). Claude Code in the workspace
 * holds every token; this reads its answers and drives its own commands (D1).
 *
 * Multi-user (PLAN-10): a sign-in is a person's act on a Claude in a workspace, so every act takes the actor and
 * leaves an audit event with it (`oauth_signin_started`, `oauth_signed_in`, `oauth_signin_ended`,
 * `oauth_signed_out`: words and ids, never an address or a code). The workspace and the server are resolved in one
 * place each (`#workspace`, `#server`), which is where `can(actor, 'operate', workspace)` goes once it exists.
 */

/** Who acts when a person uses the portal's own screens: the one owner, until sessions carry a user. */
export const OWNER_ACTOR = 'u_owner';

export interface OAuthDeps {
  /** The OAuth servers delivered to a workspace now. */
  servers: (workspaceId: string) => OAuthServer[];
  /** Commands that run in a workspace and answer at once (the check, the sign-out). */
  access: (target: string) => DeliveryAccess | undefined;
  /** An audit event (the MCP event log, §17): what, where, and who, as words. */
  audit: (type: string, workspaceId: string, details: Record<string, unknown>) => void;
  onChange: () => void;
}

const split = (workspaceId: string) => {
  const slash = workspaceId.indexOf('/');
  return [workspaceId.slice(0, slash), workspaceId.slice(slash + 1)] as const;
};

export class McpOAuth {
  readonly status = new AuthStatus();
  readonly signIns: SignIns;
  /** The runtime's terminal and exec (the portal's workspaces), set when the portal is wired up. */
  host: OAuthHost | undefined;
  /** A Claude's folder (`claudes/<16 hex>`) from its id on this workspace; null when it has none. Set by the chat module's owner. */
  claudeDirectory: (workspaceId: string, claudeId: string) => string | null = () => null;

  constructor(private readonly deps: OAuthDeps) {
    this.status.onChange = () => deps.onChange();
    this.signIns = new SignIns(() => this.host);
    const mark = (s: OAuthServer, dir: string) => ({ server: `${s.plugin}/${s.key}`, claude: dir || 'default' });
    // A login that ended by itself (the browser reached Claude Code's listener): ask what Claude Code says now.
    this.signIns.onSignedIn = (ws, dir, server, actor) => {
      deps.audit('oauth_signed_in', ws, { actor, startedBy: actor, via: 'listener', ...mark(server, dir) });
      void this.check(ws, dir, server).catch(() => undefined);
    };
    this.signIns.onEnded = (e) => deps.audit('oauth_signin_ended', e.workspaceId, { actor: e.by ?? e.actor, startedBy: e.actor, reason: e.reason, ...mark(e.server, e.dir) });
  }

  /** `?claude=<id>`: the Claude's folder; '' is Default. */
  dirOf(workspaceId: string, claudeId: string | undefined | null): string {
    if (!claudeId) return '';
    const dir = this.claudeDirectory(workspaceId, claudeId);
    if (dir === null || !CLAUDE_DIR.test(dir)) throw new AppError('NOT_FOUND', 'That Claude isn’t on this workspace.');
    return dir;
  }

  /* ---------- The two lookups ---------- */

  /** The OAuth servers delivered to a workspace: the one place they are read. */
  #servers(workspaceId: string): OAuthServer[] {
    return this.deps.servers(workspaceId);
  }

  /** The delivered OAuth server a request names, or why not. */
  #server(workspaceId: string, req: Partial<McpSignInRequest> | null | undefined): OAuthServer {
    const { plugin, key } = req ?? {};
    if (typeof plugin !== 'string' || typeof key !== 'string' || !validServer({ plugin, key })) throw new AppError('VALIDATION_FAILED', 'Pick an OAuth server.');
    const found = this.#servers(workspaceId).find((s) => s.plugin === plugin && s.key === key);
    if (!found) throw new AppError('NOT_FOUND', 'That workspace has no such OAuth server.');
    return found;
  }

  /** The workspace a command runs in, which must be running: the one place one is resolved. (Multi-user: `can(actor, 'operate', workspace)` belongs here.) */
  async #workspace(workspaceId: string): Promise<{ access: DeliveryAccess; name: string }> {
    const [target, name] = split(workspaceId);
    const access = this.deps.access(target);
    if (!access) throw new AppError('CONFLICT', 'This workspace can’t be asked from the portal.');
    if (!(await access.state(name)).running) throw new AppError('CONFLICT', 'Start the workspace first.');
    return { access, name };
  }

  /* ---------- State ---------- */

  list(workspaceId: string, dir: string): McpAuthEntry[] {
    return this.status.entries(workspaceId, dir, this.#servers(workspaceId));
  }

  /** After a delivery: the check, as a step queued with the verify. Default Claude only. */
  steps(c: Compiled, now: Date): WorkspaceStep[] {
    const servers = this.#servers(c.workspaceId);
    if (!servers.length) return [];
    const due = this.status.due(c, servers, now);
    if (!due.length) return [];
    return [this.status.step(c.workspaceId, '', due, new Map(c.plugins.map((p) => [p.plugin, p.hash12])))];
  }

  /** Asks Claude Code now (a few seconds per server) and answers with the states. `only` limits it to one server. */
  async check(workspaceId: string, dir: string, only?: Partial<McpSignInRequest> | null): Promise<McpAuthEntry[]> {
    const servers = only?.plugin || only?.key ? [this.#server(workspaceId, only)] : this.#servers(workspaceId);
    if (!servers.length) return [];
    const { access, name } = await this.#workspace(workspaceId);
    let res: { code: number; stdout: string; stderr: string };
    try {
      res = await access.run(name, checkScript(servers, dir), { user: 'node', timeoutMs: checkTimeoutMs(servers.length) });
    } catch (e) {
      throw new AppError('SERVICE_UNAVAILABLE', `Couldn’t ask Claude Code: ${scrubOAuth(stripTerminal((e as Error).message)).slice(0, 160)}`, { expose: true });
    }
    return this.status.apply(workspaceId, dir, servers, res, new Date());
  }

  /** A chat session's `system/init`: the states it reports are Claude Code's own word. The servers that need a sign-in come back. */
  seen(workspaceId: string, dir: string, reported: { name: string; status: string }[]): OAuthServer[] {
    if (!CLAUDE_DIR.test(dir)) return [];
    const known = this.#servers(workspaceId);
    return known.length ? this.status.seen(workspaceId, dir, known, reported) : [];
  }

  /* ---------- Sign-in and sign-out ---------- */

  async signIn(workspaceId: string, dir: string, req: Partial<McpSignInRequest> | null | undefined, actor: string): Promise<McpSignInStart> {
    const server = this.#server(workspaceId, req);
    await this.#workspace(workspaceId);
    const start = await this.signIns.start(workspaceId, dir, server, actor);
    this.deps.audit('oauth_signin_started', workspaceId, { actor, server: `${server.plugin}/${server.key}`, claude: dir || 'default' });
    return start;
  }

  /** Hands the pasted address to Claude Code, then asks it where the server stands. */
  async complete(workspaceId: string, signInId: string, redirectUrl: unknown, actor: string): Promise<McpServerAuth> {
    const { server, dir, startedBy } = await this.signIns.complete(workspaceId, signInId, redirectUrl);
    const [entry] = await this.check(workspaceId, dir, server);
    this.deps.audit('oauth_signed_in', workspaceId, { actor, startedBy, via: 'paste', state: entry!.auth.state, server: `${server.plugin}/${server.key}`, claude: dir || 'default' });
    return entry!.auth;
  }

  cancel(workspaceId: string, signInId: string, actor: string): Promise<void> {
    return this.signIns.cancel(workspaceId, signInId, actor);
  }

  /** Claude Code's own `claude mcp logout`: it clears that Claude's stored token for the server. */
  async signOut(workspaceId: string, dir: string, req: Partial<McpSignInRequest> | null | undefined, actor: string): Promise<McpServerAuth> {
    const server = this.#server(workspaceId, req);
    const { access, name } = await this.#workspace(workspaceId);
    const script = ['PATH="$HOME/.local/bin:$PATH"; export PATH', 'cd "$HOME" 2>/dev/null || cd /', asClaude(dir), `timeout -k 3 30 claude mcp logout '${serverName(server)}' 2>&1`, 'echo "<<<cp-exit>>>$?"'].join('\n');
    const res = await access.run(name, script, { user: 'node', timeoutMs: 45_000 });
    const out = stripTerminal(res.stdout);
    if (!/Signed out of "/.test(out)) {
      const why = out.split('\n').find((l) => l.trim() && !l.startsWith('<<<')) ?? 'it didn’t answer';
      throw new AppError('SERVICE_UNAVAILABLE', `Claude Code didn’t sign out: ${scrubOAuth(why).slice(0, 160)}`, { expose: true });
    }
    this.deps.audit('oauth_signed_out', workspaceId, { actor, server: `${server.plugin}/${server.key}`, claude: dir || 'default' });
    // The server is a plain "needs sign-in" again; ask, so the state is Claude Code's word.
    const [entry] = await this.check(workspaceId, dir, server);
    return entry!.auth;
  }

  forget(workspaceId: string) {
    this.status.forget(workspaceId);
    void this.signIns.forgetWorkspace(workspaceId);
  }
}
