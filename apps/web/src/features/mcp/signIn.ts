/**
 * The sign-in dialog's logic as pure functions (MCP set PRD §13.3): which addresses may become a link, and how the portal's
 * answers to a pasted address are read. Written for what the routes answer (`apps/server/src/mcp/oauth`): a refused address
 * is a 422 with the reason in `details.redirectUrl` and leaves the sign-in open; "an address is being checked" is a 409 that
 * does too; anything else (409 ended, 404, 503 Claude Code ended it) means the sign-in is over.
 */

/**
 * A web address the person may open: https, or http on this machine (a test provider). The address comes from Claude Code
 * in the workspace, so it is checked here too before it becomes a link: never `javascript:` or `data:`.
 */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return u.href;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return u.href;
  } catch {
    // not an address
  }
  return null;
}

export interface CompleteFailure {
  /** True: the same sign-in is still open, paste again. False: it is over, start again. */
  retry: boolean;
  message: string;
}

/** What went wrong when the pasted address was sent, from the failed call's status, message and `details`. */
export function classifyComplete(e: { status?: number; message: string; details?: unknown }): CompleteFailure {
  const detail = e.details && typeof e.details === 'object' ? (e.details as { redirectUrl?: unknown }).redirectUrl : undefined;
  if (e.status === 422) return { retry: true, message: typeof detail === 'string' && detail ? detail : e.message };
  if (e.status === 409 && /being checked/i.test(e.message)) return { retry: true, message: e.message };
  return { retry: false, message: e.message || 'The sign-in ended. Start again.' };
}
