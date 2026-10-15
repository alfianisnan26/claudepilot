// The slash commands a portal actor (Portal MCP client, ticket, CI, another session) may make Claude Code run.
// One set, used by session_send (to refuse the rest) and by the controller's send() (to write these bare, not framed).

export const SLASH_ALLOWED: ReadonlySet<string> = new Set(['/compact', '/context', '/reload-plugins']);

/** The first whitespace-delimited word of a text, when it starts with `/` (else ''). */
export function slashWord(text: string): string {
  const first = text.trimStart().split(/\s/, 1)[0] ?? '';
  return first.startsWith('/') ? first : '';
}

/** Whether a portal text is an allowed slash command, to reach Claude Code as the bare command and not as framed prose. */
export function bareSlashCommand(text: string): boolean {
  return SLASH_ALLOWED.has(slashWord(text));
}
