// Who a portal-sent message is "From" in the transcript (chat PRD FR14): a pure function, so it can be tested without a browser.

export interface PortalSender {
  kind: 'ticket' | 'session' | 'ci' | 'crew' | 'mcp' | 'account';
  /** The id after the colon (a ticket id, a session id, a CI run id); empty for an MCP client. */
  id: string;
  /** What follows "From". */
  who: string;
}

/**
 * `actor` is `ticket:<id>`, `session:<id>`, `ci:<run id>` (or `portal:ci-<run id>`) or `portal-mcp:<token id>`; `label` is what the
 * portal stored with the event. An MCP client is named by its token's label (the owner typed it when making the token), so it is
 * "anonymous" only for an event stored before labels travelled with it.
 */
export function portalSender(actor: string, label: string | undefined): PortalSender {
  const sep = actor.indexOf(':');
  const ci = actor.startsWith('ci:') || actor.startsWith('portal:ci-');
  const head = ci ? 'ci' : actor.slice(0, sep);
  const id = ci ? actor.slice(actor.startsWith('ci:') ? 3 : 'portal:ci-'.length) : actor.slice(sep + 1);
  if (head === 'ticket') return { kind: 'ticket', id, who: `ticket ${label ?? id}` };
  if (head === 'session') return { kind: 'session', id, who: label ? `session “${label}”` : 'another session' };
  // A bumped run is labelled by its number ("From CI #12"); a report says just "CI".
  if (ci) return { kind: 'ci', id, who: !label || label === 'CI' ? 'CI' : label.startsWith('#') ? `CI ${label}` : `CI · ${label}` };
  // Session delegation: a person the session was shared with, named by their account's email.
  if (head === 'account') return { kind: 'account', id, who: label ?? 'a shared account' };
  if (head === 'manager') return { kind: 'account', id, who: 'your General Manager' };
  // T-294: the portal's one-line news about a lead's workers (actor portal:crew), not an MCP client.
  if (actor === 'portal:crew') return { kind: 'crew', id: '', who: 'your crew' };
  return { kind: 'mcp', id: '', who: label ? `MCP client “${label}”` : 'an MCP client' };
}
