import type { PortalConnect } from '@portal/contracts';

/** Single-quotes a value for a POSIX shell. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Ready-to-paste setups for a token (portal-mcp PRD §10.2). The portal never writes to the admin's machine:
 * it only shows these, once, next to the secret. The second keeps the token out of `~/.claude.json`: Claude
 * Code runs the headers helper at each connection and reads a file the admin saves with mode 0600.
 */
export function connectFor(url: string, secret: string, name = 'pilot'): PortalConnect {
  const header = JSON.stringify({ Authorization: `Bearer ${secret}` });
  const helperJson = JSON.stringify({ type: 'http', url, headersHelper: 'cat ~/.config/pilot/mcp-headers.json' });
  return {
    url,
    claudeCode: `claude mcp add --transport http --scope user ${name} ${sh(url)} --header ${sh(`Authorization: Bearer ${secret}`)}`,
    claudeCodeHelper: [
      `mkdir -p ~/.config/pilot && (umask 077; printf '%s' ${sh(header)} > ~/.config/pilot/mcp-headers.json)`,
      `claude mcp add-json --scope user ${name} ${sh(helperJson)}`,
    ].join('\n'),
    curl: [
      `curl -s ${sh(url)} \\`,
      `  -H ${sh(`Authorization: Bearer ${secret}`)} \\`,
      `  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \\`,
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    ].join('\n'),
  };
}
