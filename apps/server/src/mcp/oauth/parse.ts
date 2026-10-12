import type { McpAuthState } from '@portal/contracts';

/**
 * What Claude Code prints around an MCP server's OAuth (MCP set PRD §13.3), read as text: `claude mcp get`,
 * `claude mcp login --no-browser` and a chat session's `system/init`. All of it was observed on 2.1.296 (the
 * fixtures in parse.test.ts are real output). Nothing here talks to a workspace, and nothing keeps a code: the
 * redirect address a person pastes is checked, handed on once and dropped.
 */

/** Claude Code's own limit: a sign-in nobody completes ends with "Authentication timeout" after 5 minutes. */
export const SIGN_IN_MS = 5 * 60_000;

const DETAIL_MAX = 200;
const URL_MAX = 4096;

/* eslint-disable no-control-regex */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ESC_OTHER = /\x1b[()][A-Za-z0-9]|\x1b[=>78MDEHc]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/** Terminal escapes (colours, the hyperlink Claude Code wraps a URL in, cursor moves) and carriage returns out. */
export function stripTerminal(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(ESC_OTHER, '').replace(/\r/g, '').replace(CONTROL, '');
}

/** Query values that are credentials or one-time codes of an OAuth flow, wherever an address shows up. */
const OAUTH_PARAM = /([?&#](?:code|state|access_token|refresh_token|id_token|client_secret|code_verifier|token|assertion)=)[^&\s"'<>]*/gi;

/**
 * Text that may go into an error message or a log: the OAuth parameters of any address are cut, and so is
 * every address in `addresses` (the one a person pasted), whatever shape it printed in.
 */
export function scrubOAuth(text: string, ...addresses: string[]): string {
  let out = text;
  for (const a of addresses) if (a.length >= 8) out = out.split(a).join('[address]');
  return out.replace(OAUTH_PARAM, '$1[redacted]');
}

const clip = (s: string, max = DETAIL_MAX) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/* ---------- claude mcp get ---------- */

export interface McpGetResult {
  state: McpAuthState;
  detail: string | null;
  /** Claude Code doesn't list the server (`No MCP server named …`): the plugin isn't loaded there yet. */
  absent: boolean;
}

/**
 * `claude mcp get <name>` (✅ 2.1.296):
 *
 *     plugin:cpm-lab:gitea:
 *       Scope: Dynamic config (from command line)
 *       Status: ! Needs authentication          (or `✔ Connected`, or `✘ Failed to connect`)
 *       Issue: <why it failed>                  (failed only)
 *       Type: http
 *       URL: https://…
 *       OAuth: client_id configured, callback_port 24819
 *
 * A server Claude Code doesn't list answers `No MCP server named "<name>". Configured servers: …` (exit 1).
 */
export function parseMcpGet(output: string): McpGetResult {
  const text = stripTerminal(output);
  if (/No MCP server named/i.test(text)) return { state: 'unknown', detail: 'Claude Code hasn’t loaded this server yet.', absent: true };
  const status = /^\s*Status:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (!status) return { state: 'unknown', detail: 'Claude Code printed something unexpected.', absent: false };
  if (/needs authentication/i.test(status)) return { state: 'needs_sign_in', detail: null, absent: false };
  if (/failed to connect/i.test(status)) {
    const issue = /^\s*Issue:\s*(.+)$/m.exec(text)?.[1] ?? /failed to connect\s*[—-]\s*(.+)$/i.exec(status)?.[1] ?? '';
    return { state: 'failed', detail: issue ? clip(scrubOAuth(issue)) : 'Claude Code couldn’t connect.', absent: false };
  }
  if (/connected/i.test(status)) return { state: 'connected', detail: null, absent: false };
  return { state: 'unknown', detail: clip(`Claude Code reports “${scrubOAuth(status)}”.`), absent: false };
}

/** A chat session's `system/init` `mcp_servers[].status` (✅ `connected`, `needs-auth`, `failed`; others carry no sign-in news). */
export function initState(status: unknown): McpAuthState | null {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'needs-auth':
      return 'needs_sign_in';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

/** The check step's output, split per server by the markers `authScript` prints. */
export function splitChecks(stdout: string): Map<string, { code: number | null; text: string }> {
  const out = new Map<string, { code: number | null; text: string }>();
  for (const m of stdout.matchAll(/<<<cp-auth>>>(\S+)\n([\s\S]*?)<<<cp-exit>>>(\d*)/g)) out.set(m[1]!, { code: m[3] ? Number(m[3]) : null, text: m[2]! });
  return out;
}

/* ---------- claude mcp login --no-browser ---------- */

export interface LoginOutput {
  /** The shell's PID, printed first (`cp-pid:<n>`), to stop the process by. */
  pid: number | null;
  /** The text after "Visit this URL to authorize:", joined if the terminal wrapped it. */
  url: string | null;
  /** It waits for a pasted address. */
  prompting: boolean;
  /** How many pasted addresses it turned down ("That doesn't look like a redirect URL for this sign-in"). */
  refused: number;
  /** `Authenticated with "<name>"` (exit 0). */
  authenticated: boolean;
  /** `Couldn't complete authentication for "<name>": <reason>` (exit 1): the reason. */
  failure: string | null;
  /** Claude Code doesn't list the server. */
  absent: boolean;
}

/**
 * Reads what the login printed so far (✅ 2.1.296):
 *
 *     Starting authentication for "plugin:cpm-lab:gitea"…
 *     Visit this URL to authorize:
 *       https://git.example.com/login/oauth/authorize?response_type=code&client_id=…&redirect_uri=http%3A%2F%2Flocalhost%3A24819%2Fcallback&state=…
 *
 *     Waiting for authorization… (^C to cancel)
 *     Or paste the redirect URL here:
 *
 * then `Authenticated with "…". Its tools are now available in Claude Code.`, or `Couldn't complete authentication for
 * "…": <reason>` (a provider's refusal, "Authentication timeout" after 5 minutes, no TTY). A pasted address it can't use
 * gets "That doesn't look like a redirect URL for this sign-in" and the prompt again. Without a terminal on stdin it
 * prints the URL and gives up, which is why the portal runs it in a pty.
 */
export function parseLogin(output: string): LoginOutput {
  const text = stripTerminal(output);
  const pid = /cp-pid:(\d+)/.exec(text)?.[1];
  let url: string | null = null;
  const at = text.indexOf('Visit this URL to authorize:');
  if (at >= 0) {
    // Only lines that ended: the URL may still be arriving.
    const lines = text.slice(at).split('\n').slice(1, -1);
    const parts: string[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        if (parts.length) break;
        continue;
      }
      parts.push(line.trim());
    }
    url = parts.join('') || null;
  }
  const failure = /Couldn't complete authentication for "[^"]*":\s*(.+)/.exec(text)?.[1];
  return {
    pid: pid ? Number(pid) : null,
    url,
    prompting: /Or paste the redirect URL here:/.test(text),
    refused: (text.match(/doesn't look like a redirect URL/g) ?? []).length,
    authenticated: /Authenticated with "/.test(text),
    failure: failure ? clip(scrubOAuth(failure)) : null,
    absent: /No MCP server named/.test(text),
  };
}

/** The last thing a login said that isn't bookkeeping (its PID line, the SDK's notices), scrubbed, for an error nobody planned for. */
export function lastLine(output: string): string | null {
  const lines = stripTerminal(output)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('cp-pid:') && !l.startsWith('[mcp-sdk]') && !/^(Starting authentication|Visit this URL|Waiting for authorization|Or paste the redirect URL)/.test(l));
  const last = lines.at(-1);
  return last ? clip(scrubOAuth(last), 160) : null;
}

/* ---------- The addresses ---------- */

export class AddressError extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopback = (host: string) => LOOPBACK.has(host.toLowerCase());
const PRINTABLE = /^[\x21-\x7e]+$/; // eslint-disable-line no-control-regex

export interface AuthUrl {
  /** The provider's authorization page, as Claude Code printed it. */
  url: string;
  /** `http://localhost:<port>/callback`, where Claude Code listens. */
  callback: string;
}

/**
 * The URL Claude Code printed is workspace text, shown to a person who will type their password at the other
 * end: only https (or loopback http, a test provider), no credentials, printable ASCII, and a loopback
 * `redirect_uri`, since that is the only kind the paste flow can finish.
 */
export function checkAuthUrl(raw: string): AuthUrl {
  if (raw.length > URL_MAX || !PRINTABLE.test(raw)) throw new AddressError('Claude Code printed an address the portal won’t show.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AddressError('Claude Code printed an address the portal can’t read.');
  }
  if (url.username || url.password || !url.hostname) throw new AddressError('Claude Code printed an address the portal won’t show.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) throw new AddressError('The sign-in page isn’t https, so the portal won’t show it.');
  const redirect = url.searchParams.get('redirect_uri');
  let back: URL | null = null;
  try {
    back = redirect ? new URL(redirect) : null;
  } catch {
    back = null;
  }
  if (!back || back.protocol !== 'http:' || !isLoopback(back.hostname) || !back.port) throw new AddressError('This server signs in somewhere the portal can’t follow (no local callback).');
  return { url: url.href, callback: `${back.protocol}//${back.host}${back.pathname}` };
}

/**
 * What a person pasted, made into the one line Claude Code's prompt takes. The address the browser ended on:
 * `http://localhost:<port>/callback?code=…&state=…`, the host may be any loopback name (a browser or a phone
 * may show 127.0.0.1), the port and path must be the ones Claude Code listens on. A bare query string
 * (`code=…&state=…`) is accepted too: on a phone that is often all that can be copied. Whatever else it is,
 * it never reaches the terminal.
 */
export function checkRedirect(pasted: unknown, callback: string): string {
  if (typeof pasted !== 'string') throw new AddressError('Paste the address the browser ended on.');
  const text = pasted.trim().replace(/^[<"']+|[>"']+$/g, '');
  if (!text) throw new AddressError('Paste the address the browser ended on.');
  if (text.length > URL_MAX || !PRINTABLE.test(text)) throw new AddressError('That isn’t an address.');
  const base = new URL(callback);
  let query: string;
  if (/^[?]?[A-Za-z0-9_.~%+-]+=/.test(text) && !/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    query = text.replace(/^\?/, '');
  } else {
    let given: URL;
    try {
      given = new URL(text);
    } catch {
      throw new AddressError('That isn’t an address.');
    }
    if (given.protocol !== 'http:' || !isLoopback(given.hostname) || given.port !== base.port || given.pathname !== base.pathname)
      throw new AddressError(`It should start with ${callback}`);
    query = given.search.replace(/^\?/, '');
  }
  const params = new URLSearchParams(query);
  if (!params.get('state') || !(params.get('code') || params.get('error'))) throw new AddressError('That address has no sign-in code. Copy the whole address, after the page fails to load.');
  return `${callback}?${query}`;
}
