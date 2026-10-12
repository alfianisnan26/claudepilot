// Re-auth for sensitive actions (web-app-pwa PRD §12.5, FR17): a check of the server code within 10 minutes, enforced
// by the server. The portal has one credential, the server code, so that is the check (passkeys come later). A
// successful check marks that signed-in session; sign-out or a new code ends the session and the mark with it.

import type { Portal, Session } from '../portal.js';

/** How long a check counts. */
export const REAUTH_WINDOW_MS = 10 * 60_000;

export class Reauth {
  readonly #at = new WeakMap<Session, number>();

  constructor(
    private readonly portal: Pick<Portal, 'session' | 'matches'>,
    private readonly windowMs = REAUTH_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Checks the code for this sign-in and starts the window. False when the code is wrong or the sign-in is gone. */
  confirm(token: string | undefined, code: unknown): boolean {
    const session = this.portal.session(token);
    if (!session || typeof code !== 'string' || !code.trim()) return false;
    if (!this.portal.matches(code)) return false;
    this.#at.set(session, this.now());
    return true;
  }

  /** Whether this sign-in checked the code within the window. */
  fresh(token: string | undefined): boolean {
    const session = this.portal.session(token);
    const at = session ? this.#at.get(session) : undefined;
    return at !== undefined && this.now() - at <= this.windowMs;
  }
}
