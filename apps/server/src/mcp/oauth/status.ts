import type { McpAuthEntry, McpAuthState, McpServerAuth } from '@portal/contracts';
import { redact } from '../../chat/redact.js';
import type { WorkspaceStep, StepResult } from '../../delivery/steps.js';
import type { Compiled } from '../kind.js';
import { initState, parseMcpGet, scrubOAuth, splitChecks } from './parse.js';

/**
 * Where each OAuth server stands in a workspace (MCP set PRD §13.3, M2). The answer is Claude Code's own: the
 * portal runs `claude mcp get <name>` in the workspace (after a delivery, on demand) and reads a chat session's
 * `system/init`, and keeps the word it got in memory. It never opens the credential file or holds a token, and
 * a restart of the portal only means "unknown" until the next check.
 */

/** A server whose sign-in this tracks: a delivered `oauth` remote server, as Claude Code names it. */
export interface OAuthServer {
  plugin: string;
  key: string;
  /** The catalog entry's name, for a person. */
  name: string;
}

/** The name Claude Code gives a plugin's server (✅). */
export const serverName = (s: { plugin: string; key: string }) => `plugin:${s.plugin}:${s.key}`;

/** `''` is Default (Claude Code's own folders); another Claude is `claudes/<16 hex>` under `~/.claudepilot`. */
export const CLAUDE_DIR = /^(claudes\/[a-f0-9]{16})?$/;
const PLUGIN = /^cpm-[a-z0-9-]{1,12}$/;
const KEY = /^[a-z0-9-]{1,16}$/;
export const validServer = (s: { plugin: string; key: string }) => PLUGIN.test(s.plugin) && KEY.test(s.key);

/** A checked server is asked again after this long, so a token that stopped working shows up. */
const RECHECK_MS = 15 * 60_000;
/** "Can't tell" is asked again sooner. */
const RETRY_UNKNOWN_MS = 2 * 60_000;
/** One server's `claude mcp get`; it connects (and refreshes a token) with the managed `MCP_TIMEOUT` of 60 s. */
const GET_TIMEOUT_S = 45;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The `export` that points Claude Code at one Claude's folders (Workspace Claudes FR2); nothing for Default. */
export const asClaude = (dir: string) => {
  // Inlined into a script: only a folder the portal itself made (a hostile one would be a command).
  if (!CLAUDE_DIR.test(dir)) throw new Error('Not a Claude folder.');
  return dir ? `export CLAUDE_CONFIG_DIR="$HOME/.claudepilot/${dir}"` : ':';
};

/** `claude mcp get` for each server, with markers to split the output; nothing here is a secret. */
export function checkScript(servers: OAuthServer[], dir: string): string {
  return [
    'PATH="$HOME/.local/bin:$PATH"; export PATH',
    'cd "$HOME" 2>/dev/null || cd /',
    asClaude(dir),
    ...servers.flatMap((s) => [
      `echo ${q(`<<<cp-auth>>>${serverName(s)}`)}`,
      `timeout -k 3 ${GET_TIMEOUT_S} claude mcp get ${q(serverName(s))} 2>&1`,
      'echo "<<<cp-exit>>>$?"',
    ]),
  ].join('\n');
}

/** What a whole check may take: one `get` per server, a little slack. */
export const checkTimeoutMs = (n: number) => (GET_TIMEOUT_S * Math.max(1, n) + 15) * 1000;

interface Held extends McpServerAuth {
  /** The plugin folder the check saw; a new one (the server changed) is asked again. */
  hash12: string | null;
}

export class AuthStatus {
  /** Something a status page shows changed. */
  onChange: () => void = () => {};
  readonly #held = new Map<string, Held>();

  #id = (ws: string, dir: string, s: { plugin: string; key: string }) => `${ws}\0${dir}\0${s.plugin}/${s.key}`;

  /** The server's state as last seen, or "unknown" before anything was. */
  get(ws: string, dir: string, s: { plugin: string; key: string }): McpServerAuth {
    const h = this.#held.get(this.#id(ws, dir, s));
    return h ? { mode: 'oauth', state: h.state, detail: h.detail, checkedAt: h.checkedAt } : { mode: 'oauth', state: 'unknown', detail: null, checkedAt: null };
  }

  entries(ws: string, dir: string, servers: OAuthServer[]): McpAuthEntry[] {
    return servers.map((s) => ({ plugin: s.plugin, key: s.key, auth: this.get(ws, dir, s) }));
  }

  set(ws: string, dir: string, s: { plugin: string; key: string }, state: McpAuthState, detail: string | null, now = new Date(), hash12: string | null = null): McpServerAuth {
    const id = this.#id(ws, dir, s);
    const before = this.#held.get(id);
    const held: Held = { mode: 'oauth', state, detail: detail ? redact(scrubOAuth(detail)).slice(0, 300) : null, checkedAt: now.toISOString(), hash12: hash12 ?? before?.hash12 ?? null };
    this.#held.set(id, held);
    if (!before || before.state !== state || before.detail !== held.detail) this.onChange();
    return this.get(ws, dir, s);
  }

  forget(ws: string, dir?: string) {
    const prefix = dir === undefined ? `${ws}\0` : `${ws}\0${dir}\0`;
    for (const k of [...this.#held.keys()]) if (k.startsWith(prefix)) this.#held.delete(k);
  }

  /** After a delivery: the delivered OAuth servers whose state is new, changed, old or was a guess. Default Claude only. */
  due(c: Compiled, servers: OAuthServer[], now: Date): OAuthServer[] {
    const hashes = new Map(c.plugins.map((p) => [p.plugin, p.hash12]));
    return servers.filter((s) => {
      const h = this.#held.get(this.#id(c.workspaceId, '', s));
      if (!h || !h.checkedAt) return true;
      const age = now.getTime() - Date.parse(h.checkedAt);
      if (h.hash12 !== (hashes.get(s.plugin) ?? null)) return true;
      return age >= (h.state === 'unknown' ? RETRY_UNKNOWN_MS : RECHECK_MS);
    });
  }

  /** The check as a delivery step (queued with the verify): its answer lands in `apply`. */
  step(ws: string, dir: string, servers: OAuthServer[], hashes: Map<string, string>): WorkspaceStep {
    return {
      owner: 'mcpset',
      key: `auth:${dir || 'default'}`,
      label: 'oauth status',
      script: checkScript(servers, dir),
      timeoutMs: checkTimeoutMs(servers.length),
      done: (res) => this.apply(ws, dir, servers, res, new Date(), hashes),
    };
  }

  /** Reads a check's output into the state of each server. A check that didn't run changes nothing. */
  apply(ws: string, dir: string, servers: OAuthServer[], res: Pick<StepResult, 'code' | 'stdout' | 'stderr' | 'skipped'>, now: Date, hashes = new Map<string, string>()): McpAuthEntry[] {
    const blocks = splitChecks(res.stdout);
    for (const s of servers) {
      const hash = hashes.get(s.plugin) ?? null;
      if (res.skipped) continue;
      const block = blocks.get(serverName(s));
      if (!block) {
        const why = res.code === 127 || /claude: (command )?not found/i.test(res.stderr) ? 'Claude Code isn’t installed in this workspace.' : 'Claude Code didn’t answer in time.';
        this.set(ws, dir, s, 'unknown', why, now, hash);
      } else if (block.code === 124 || block.code === 137) this.set(ws, dir, s, 'unknown', 'Claude Code didn’t answer in time.', now, hash);
      else {
        const r = parseMcpGet(block.text);
        this.set(ws, dir, s, r.state, r.detail, now, hash);
      }
    }
    return this.entries(ws, dir, servers);
  }

  /**
   * A chat session's `system/init` lists every server's status (✅). It is the most exact word there is, for that
   * session's Claude. Returns the servers it says need a sign-in.
   */
  seen(ws: string, dir: string, known: OAuthServer[], reported: { name: string; status: string }[], now = new Date()): OAuthServer[] {
    const needs: OAuthServer[] = [];
    for (const r of reported) {
      const s = known.find((k) => serverName(k) === r.name);
      const state = initState(r.status);
      if (!s || !state) continue;
      this.set(ws, dir, s, state, state === 'failed' ? 'Claude Code couldn’t connect.' : null, now);
      if (state === 'needs_sign_in') needs.push(s);
    }
    return needs;
  }
}
