// Claude usage: the probe (docs/prd/claude-usage.md §11). One short-lived `claude -p` process in the workspace, run as
// that Claude, asked one thing over the stream-json control protocol: `get_usage {skip_behaviors: true}`. No user
// message is sent, so no model request is made. Only the reply to our request id is read; the rest is dropped.
// The portal never reads, passes or logs a login: Claude Code finds its own in the Claude's directory.

import { randomUUID } from 'node:crypto';
import type { ClaudeRunsOn, UsageProblem } from '@portal/contracts';
import type { ExecSession } from '../workspaces/runtime.js';
import { parseAuthStatus, parseUsageReply, type AuthState, type ExtraReading, type WindowReading } from './parse.js';

/** A Claude's directory under ~/.claudepilot, or '' for Default (Claude Code's own home). Same check as Workspace Claudes. */
export const CLAUDE_DIR = /^(claudes\/[a-f0-9]{16})?$/;

/** `timeout` inside the workspace, so a hung Claude Code can never be left running. */
export const PROBE_LIMIT_S = 25;
const AUTH_LIMIT_S = 15;
/** The portal's own limit on a probe: a little over the one inside. */
export const PROBE_HARD_MS = 30_000;
const AUTH_HARD_MS = 20_000;
/** Unfinished-line and output caps: a reply is one short line. */
const MAX_TAIL = 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;

/**
 * Network plumbing a workspace may need to reach Anthropic (a proxy, its CA). Passed on only when set. Everything else
 * of the workspace's environment is dropped: an API key, an auth token or a base URL there would turn this into an
 * API-key session and read "no plan limits" for a Claude that has a plan.
 */
export const PASS_THROUGH = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const;

/**
 * `sh -c SCRIPT sh <dir> <command…>`: the Claude's directory is `$1` (never part of a command line the shell parses) and
 * the command follows it. The command runs under `env -i` with HOME, PATH, the pass-through variables, the Claude's own
 * `CLAUDE_CONFIG_DIR` (none for Default) and three switches that keep the process quiet: no telemetry, no error
 * reporting, no self-update. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is never set: it stops the usage fetch.
 */
export const PROBE_SCRIPT = [
  'PATH="$HOME/.local/bin:$PATH"; export PATH',
  'dir="$1"; shift',
  `for v in ${PASS_THROUGH.join(' ')}; do`,
  '  eval "val=\\${$v-}"',
  '  if [ -n "$val" ]; then set -- "$v=$val" "$@"; fi',
  'done',
  'if [ -n "$dir" ]; then set -- "CLAUDE_CONFIG_DIR=$HOME/.claudepilot/$dir" "$@"; fi',
  'exec env -i "HOME=$HOME" "PATH=$PATH" LANG=C.UTF-8 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1 "$@"',
].join('\n');

export function inClaude(dir: string, ...command: string[]): string[] {
  if (!CLAUDE_DIR.test(dir)) throw new Error('That Claude’s directory isn’t valid.');
  return ['sh', '-c', PROBE_SCRIPT, 'sh', dir, ...command];
}

/**
 * What keeps a probe from running anything the workspace, the Claude's settings or the project say to run (docs §11, "Hooks never run"): Claude Code's safe
 * mode starts with every customization off, hooks above all. Without it a probe fired the SessionStart and SessionEnd hooks of the Claude's `settings.json` and
 * of the project's `.claude/settings.json` on every poll, with no message sent (observed on 2.1.296). The sign-in, admin-managed (policy) settings and the
 * usage reply are unaffected (observed). Claude Code 2.1.169 added the flag; an older one answers `error: unknown option '--safe-mode'` and exits before it
 * starts anything, so a probe fails closed (and none of those versions answers `get_usage` anyway: 2.1.168 replies with an error). The environment variable
 * `CLAUDE_CODE_SAFE_MODE` is NOT a substitute: set alone it stopped no hook (observed), and an older Claude Code would ignore it and run them.
 */
export const SAFE_MODE_FLAG = '--safe-mode';

/**
 * The usage probe. `--safe-mode` keeps it from running hooks, loading CLAUDE.md, skills or plugins, or starting MCP servers; `--strict-mcp-config` and
 * `--disable-slash-commands` stay as a second line; `--no-session-persistence` writes no session. Never `--bare`: it skips the sign-in, so a plan reads signed out.
 */
export const probeCommand = (dir: string): string[] =>
  inClaude(dir, 'timeout', String(PROBE_LIMIT_S), 'claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', SAFE_MODE_FLAG);

/** Claude Code's own sign-in state. Its output names the account; `parseAuthStatus` keeps two fields and the rest is dropped. */
export const authCommand = (dir: string): string[] => inClaude(dir, 'timeout', String(AUTH_LIMIT_S), 'claude', 'auth', 'status', '--json');

/** What the portal needs from a runtime: a command in a running workspace. */
export interface ProbeIo {
  exec(target: string, name: string, command: string[]): Promise<ExecSession>;
  newId?: () => string;
  hardMs?: number;
}

/** `unsupported`: this Claude Code does not know `--safe-mode` (before 2.1.169), so it started nothing and no usage is read there. */
export type UsageReply = { ok: true; response: unknown } | { ok: false; problem: UsageProblem; unsupported?: boolean };

/** What Claude Code's argument parser says to a flag it does not have. Only this is looked for in what the process prints, and nothing of it is kept. */
const NO_SAFE_MODE = /unknown option\b.*--safe-mode/i;

/** The `control_response` for `id` in one stdout line, or null. Other lines (and merged stderr) are not ours. */
function replyIn(line: string, id: string): UsageReply | null {
  if (!line.startsWith('{')) return null;
  try {
    const o = JSON.parse(line) as { type?: unknown; response?: { subtype?: unknown; request_id?: unknown; response?: unknown } };
    if (o.type !== 'control_response' || o.response?.request_id !== id) return null;
    return o.response.subtype === 'success' ? { ok: true, response: o.response.response } : { ok: false, problem: 'unreadable' };
  } catch {
    return null;
  }
}

/** Runs the probe and returns Claude Code's reply to `get_usage`, or why there is none. */
export async function askUsage(io: ProbeIo, target: string, name: string, dir: string): Promise<UsageReply> {
  const id = (io.newId ?? randomUUID)();
  let session: ExecSession;
  try {
    session = await io.exec(target, name, probeCommand(dir));
  } catch {
    return { ok: false, problem: 'unreadable' };
  }
  return new Promise<UsageReply>((resolve) => {
    let tail = '';
    let unsupported = false;
    let settled = false;
    const finish = (r: UsageReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        session.close();
      } catch {
        // already gone
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, problem: 'timeout' }), io.hardMs ?? PROBE_HARD_MS);
    session.onData((d) => {
      tail += d.toString('utf8');
      let nl: number;
      while ((nl = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, nl).trim();
        const reply = replyIn(line, id);
        tail = tail.slice(nl + 1);
        if (reply) return finish(reply);
        if (NO_SAFE_MODE.test(line)) unsupported = true;
      }
      if (tail.length > MAX_TAIL) tail = '';
    });
    session.onExit((code) =>
      finish({
        ok: false,
        problem: code === 127 ? 'not_installed' : code === 124 ? 'timeout' : 'unreadable',
        ...(unsupported || NO_SAFE_MODE.test(tail) ? { unsupported: true } : {}),
      }),
    );
    try {
      session.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'get_usage', skip_behaviors: true } })}\n`);
    } catch {
      finish({ ok: false, problem: 'unreadable' });
    }
  });
}

/** Claude Code's sign-in state for a Claude (`loggedIn`, `authMethod`), or null when it couldn't be read. */
export async function askAuth(io: ProbeIo, target: string, name: string, dir: string): Promise<AuthState | null> {
  let session: ExecSession;
  try {
    session = await io.exec(target, name, authCommand(dir));
  } catch {
    return null;
  }
  return new Promise<AuthState | null>((resolve) => {
    let output = '';
    let settled = false;
    const finish = (state: AuthState | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        session.close();
      } catch {
        // already gone
      }
      resolve(state);
    };
    const timer = setTimeout(() => finish(null), AUTH_HARD_MS);
    session.onData((d) => (output = (output + d.toString('utf8')).slice(-MAX_OUTPUT)));
    session.onExit((code) => finish(code === 0 || code === 1 ? parseAuthStatus(output) : null));
  });
}

/** What one probe of a Claude found (the service stores it). */
export interface ProbeResult {
  runsOn: ClaudeRunsOn;
  plan: string | null;
  windows: WindowReading[];
  extra: ExtraReading | null;
  problem: UsageProblem | null;
  /** No settled answer: retry with backoff, and keep the last numbers. */
  failed: boolean;
  /** This Claude Code has no `--safe-mode` (before 2.1.169): nothing was started, and nothing will be read there until it is updated. */
  unsupported?: boolean;
}

const none = (over: Partial<ProbeResult>): ProbeResult => ({ runsOn: 'unknown', plan: null, windows: [], extra: null, problem: null, failed: false, ...over });

/**
 * Probes one Claude: `get_usage`, and only when that says there are no plan limits, `auth status` to tell signed out
 * (nothing to show), an API key (no plan limits) and a plan login that can't report them (`no_scope`).
 */
export async function probeClaude(io: ProbeIo, target: string, name: string, dir: string): Promise<ProbeResult> {
  const reply = await askUsage(io, target, name, dir);
  if (!reply.ok) return none({ problem: reply.problem, failed: true, ...(reply.unsupported ? { unsupported: true } : {}) });
  const parsed = parseUsageReply(reply.response);
  switch (parsed.kind) {
    case 'plan':
      return none({ runsOn: 'plan', plan: parsed.plan, windows: parsed.windows, extra: parsed.extra });
    case 'unavailable':
      return none({ runsOn: 'plan', plan: parsed.plan, problem: 'unavailable', failed: true });
    case 'unreadable':
      return none({ problem: 'unreadable', failed: true });
    case 'no_limits': {
      const auth = await askAuth(io, target, name, dir);
      if (!auth) return none({ problem: 'unreadable', failed: true });
      if (!auth.loggedIn) return none({ runsOn: 'none' });
      if (auth.method === 'claude.ai' || auth.method === 'oauth_token') return none({ runsOn: 'plan', plan: parsed.plan, problem: 'no_scope' });
      return none({ runsOn: 'key' });
    }
  }
}
