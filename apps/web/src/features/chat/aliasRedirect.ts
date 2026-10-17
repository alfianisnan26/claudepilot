/**
 * Where the session page sends an old link (an id an earlier move made, now an alias of the chat): to the chat's own id. Only for a
 * session loaded for THIS route: on the render where the route's id has just changed (the crew line's lead pill, a worker in its list,
 * any link to another session), the session is still the previous route's until the new one loads, and redirecting then sent the person
 * straight back to where they came from (owner, 2026-10-17: "back button to root sessions seems not working").
 */
export function aliasRedirect(previousId: string, id: string, sessionId: string | null | undefined): string | null {
  if (previousId !== id) return null;
  if (!sessionId || sessionId === id) return null;
  return `/admin/sessions/${sessionId}`;
}
