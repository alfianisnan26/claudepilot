// Claude usage: the prime (T-1707, docs/prd/claude-usage.md §10.5). Claude Code reads 0 % with no reset time both for a session window nobody
// has opened yet and for an account already at its limit (2026-10-13), so such a Claude is unknown and auto move never prefers it. One tiny
// request on that Claude tells the two apart: it opens the window (the next probe reads a reset time and a number) or it is refused with the
// limit message (the Claude is used up, until the time it states). One short `claude -p` in the workspace, as that Claude, the same way the
// probe starts (probe.ts `inClaude`: its own CLAUDE_CONFIG_DIR, `env -i`, safe mode), on the cheapest model, every tool off, one user line
// "ok". Nothing of what it prints is kept: each line is only looked at for Claude Code's limit refusal (chat/protocol.ts `parseLine`, the same
// reading a chat's limit gets) and for the `result` that ends it.

import { parseLine } from '../chat/protocol.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { parseRateLimitInfo } from './parse.js';
import { inClaude, SAFE_MODE_FLAG, type ProbeIo } from './probe.js';

/** The cheapest model Claude Code knows by alias. */
export const PRIME_MODEL = 'haiku';
/** `timeout` inside the workspace, so a hung Claude Code is never left running; the portal's own limit is a little over it. */
export const PRIME_LIMIT_S = 40;
export const PRIME_HARD_MS = 45_000;
/** `--max-budget-usd`: far above what one "ok" costs on Haiku (well under a tenth of a cent), so it only ever stops a runaway. */
export const PRIME_MAX_USD = 0.02;
/** The whole system prompt: fixed text, so the request stays a few dozen tokens. */
export const PRIME_SYSTEM_PROMPT = 'Reply with the single word ok.';
const MAX_TAIL = 1024 * 1024;

/**
 * The prime. `--tools ""` sends no tools, `--safe-mode` runs no hook and loads no CLAUDE.md, skill or plugin, `--strict-mcp-config` starts no
 * MCP server, `--no-session-persistence` writes no session (so no transcript anywhere), `ENABLE_CLAUDEAI_MCP_SERVERS=false` keeps claude.ai's
 * connectors out. The same flags the side questions use (chat/btwRun.ts), measured there.
 */
export const primeCommand = (dir: string): string[] =>
  inClaude(
    dir,
    'ENABLE_CLAUDEAI_MCP_SERVERS=false',
    'timeout',
    String(PRIME_LIMIT_S),
    'claude',
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    PRIME_MODEL,
    '--tools',
    '',
    SAFE_MODE_FLAG,
    '--strict-mcp-config',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--max-budget-usd',
    String(PRIME_MAX_USD),
    '--system-prompt',
    PRIME_SYSTEM_PROMPT,
  );

/** The one stdin line: a stream-json user message "ok". */
export const PRIME_INPUT = `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ok' }] } })}\n`;

/**
 * What a prime came to. `ok`: the request was answered (the window is open now). `limited`: refused for a plan limit, with Claude Code's own
 * `rate_limit_info` for it (the usage module's passive reading takes it as it is). `failed`: anything else; nothing is learnt.
 */
export type PrimeOutcome = { outcome: 'ok' } | { outcome: 'limited'; info: Record<string, unknown> } | { outcome: 'failed'; why: 'timeout' | 'error' | 'not_installed' };

/** A `rate_limit_info` that refuses a window (a limit message, `usage_limit_reached`, a rejected `rate_limit_event`), or null. */
export function refusalIn(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) return null;
  const info = parseLine(line).rateLimitInfo;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const reading = parseRateLimitInfo(info);
  return reading && reading.rejected.length ? (info as Record<string, unknown>) : null;
}

/** Whether a line is the `result` that ends the turn, and whether it succeeded. */
function resultIn(line: string): { ok: boolean } | null {
  if (!line.startsWith('{')) return null;
  try {
    const o = JSON.parse(line) as { type?: unknown; subtype?: unknown; is_error?: unknown };
    return o.type === 'result' ? { ok: o.is_error !== true && o.subtype === 'success' } : null;
  } catch {
    return null;
  }
}

/** Runs one prime in a running workspace as the Claude in `dir`. Never throws. */
export async function runPrime(io: ProbeIo, target: string, name: string, dir: string): Promise<PrimeOutcome> {
  let session: ExecSession;
  try {
    session = await io.exec(target, name, primeCommand(dir));
  } catch {
    return { outcome: 'failed', why: 'error' };
  }
  return new Promise<PrimeOutcome>((resolve) => {
    let tail = '';
    let refused: Record<string, unknown> | null = null;
    let settled = false;
    const finish = (r: PrimeOutcome) => {
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
    const timer = setTimeout(() => finish(refused ? { outcome: 'limited', info: refused } : { outcome: 'failed', why: 'timeout' }), io.hardMs ?? PRIME_HARD_MS);
    session.onData((d) => {
      tail += d.toString('utf8');
      let nl: number;
      while ((nl = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, nl).trim();
        tail = tail.slice(nl + 1);
        refused ??= refusalIn(line);
        const result = resultIn(line);
        if (result) return finish(refused ? { outcome: 'limited', info: refused } : result.ok ? { outcome: 'ok' } : { outcome: 'failed', why: 'error' });
      }
      if (tail.length > MAX_TAIL) tail = '';
    });
    session.onExit((code) => finish(refused ? { outcome: 'limited', info: refused } : { outcome: 'failed', why: code === 127 ? 'not_installed' : code === 124 ? 'timeout' : 'error' }));
    try {
      session.write(PRIME_INPUT);
    } catch {
      finish({ outcome: 'failed', why: 'error' });
    }
  });
}
