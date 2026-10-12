import type { LivePresence } from '@portal/contracts';

/** Input within this long counts as "in use" (PWA PRD 11.2). */
export const ACTIVE_MS = 2 * 60_000;

/** The session id of a `/admin/sessions/:id` path, else null: no notification for what is already on screen. */
export function sessionOfPath(pathname: string): string | null {
  const m = /^\/admin\/sessions\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/** What this tab reports. `lastInput` and `now` are epoch ms; a tab that is hidden is never active, whatever its last input. */
export function presenceOf(o: { visible: boolean; lastInput: number; now: number; device: string | null; pathname: string }): Omit<LivePresence, 'type'> {
  const visible = o.visible;
  return { device: o.device, visible, active: visible && o.now - o.lastInput < ACTIVE_MS, session: visible ? sessionOfPath(o.pathname) : null };
}

export const samePresence = (a: Omit<LivePresence, 'type'> | null, b: Omit<LivePresence, 'type'>) => !!a && a.device === b.device && a.visible === b.visible && a.active === b.active && a.session === b.session;
