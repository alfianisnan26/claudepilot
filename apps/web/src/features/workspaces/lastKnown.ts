import type { Workspace } from '@portal/contracts';
import { timeAgo } from '../../lib/format';

/**
 * The one line the InfoTip of an `unavailable` workspace says (T-515): why its target's list failed (the server's short, redacted reason)
 * and when it last answered. Null for any other state. Pure, so it is tested.
 */
export function unavailableNote(w: Pick<Workspace, 'status' | 'detail' | 'lastSeenAt'>, now = Date.now()): string | null {
  if (w.status !== 'unavailable') return null;
  const reason = (w.detail ?? '').trim().replace(/[.\s]+$/, '') || 'No answer';
  const seen = w.lastSeenAt ? `last seen ${timeAgo(w.lastSeenAt, now)}` : 'never seen';
  return `${reason} · ${seen}`;
}
