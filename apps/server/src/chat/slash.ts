// The slash commands a portal actor (Portal MCP client, ticket, CI, another session) may make Claude Code run.
// One set, used by session_send (to refuse the rest) and by the controller's send() (to write these bare, not framed).

export const SLASH_ALLOWED: ReadonlySet<string> = new Set(['/compact', '/context', '/reload-plugins']);

/** The first whitespace-delimited word of a text, when it starts with `/` (else ''). */
export function slashWord(text: string): string {
  const first = text.trimStart().split(/\s/, 1)[0] ?? '';
  return first.startsWith('/') ? first : '';
}

/** `/compact` may carry a same-line argument of at most this many characters (T-597 S1b). */
export const COMPACT_ARG_MAX = 500;

/**
 * Whether a text holds a line break of any kind (LF, CR, VT, FF, NEL, the Unicode line and paragraph separators) or another control
 * character (a tab is allowed). Checked by character code so no invisible character sits in this source.
 */
function notOneLine(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 8 || (c >= 10 && c <= 31) || c === 127 || c === 0x85 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/**
 * Whether a portal text may reach Claude Code as the bare command and not as framed prose (T-597 S1b; QA 5727 F1: whatever follows the
 * first word is read by Claude Code as the user's own line, so a bare text must be small enough to hold no instruction block). ALL of:
 * the actor is a session or a Portal MCP token (a ticket, CI run or portal actor carries outside text and always stays framed); exactly
 * one line (no line break of any kind); no leading whitespace and the first word exactly `/compact`, `/context` or `/reload-plugins`
 * (case-sensitive, ASCII); only `/compact` takes an argument, after one space, of at most COMPACT_ARG_MAX characters; no attachment.
 */
export function bareSlashCommand(text: string, actor: string | null, hasAttachment: boolean): boolean {
  if (hasAttachment || !actor || !(actor.startsWith('session:') || actor.startsWith('portal-mcp:'))) return false;
  if (notOneLine(text)) return false;
  if (text === '/context' || text === '/reload-plugins' || text === '/compact') return true;
  return text.startsWith('/compact ') && text.length - '/compact '.length <= COMPACT_ARG_MAX;
}
