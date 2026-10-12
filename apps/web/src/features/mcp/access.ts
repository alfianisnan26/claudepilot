/**
 * Rights (multi-user, light touch): the catalogue UI never assumes an action is allowed. When the portal answers 403 the
 * action is shown disabled with the portal's own reason, instead of failing again on every tap. Today's single owner is
 * never refused, so none of this shows; it is what a member without the right will see. Nothing here stores anything in
 * the browser: there are no per-user UI preferences to key (when one is added it takes the `userId` prefix, `u_owner` today).
 */

/** The reason when a call was refused for lack of rights (HTTP 403), else null. Reads the failed call's status and message only. */
export function forbiddenReason(e: unknown): string | null {
  if (!e || typeof e !== 'object') return null;
  const { status, message } = e as { status?: unknown; message?: unknown };
  if (status !== 403) return null;
  return typeof message === 'string' && message && message !== 'Forbidden' ? message : 'You don’t have access to this.';
}
