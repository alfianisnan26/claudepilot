// A page that "sometimes cannot be scrolled" (Settings, anywhere). The kit's Dialog and the command palette each lock the page by
// saving body.style.overflow, setting it to hidden, and putting the saved value back when they close. When two of them overlap (a
// dialog still leaving while the next one opens, the palette opened over a dialog that then closes first) the later one saves
// "hidden" and puts "hidden" back: nothing holds the lock any more, and the page stays stuck until a reload.
//
// This heals it: when no modal is on screen, an inline overflow:hidden on body is cleared. A modal is anything with aria-modal
// (the kit's Dialog panel and the palette both have it). The check waits a moment after a change, so a dialog's exit animation
// is never cut short, and it looks again while the lock is still set.

export const MODAL_SELECTOR = '[aria-modal="true"]';

/** Longer than a dialog's exit animation (0.18 s) and the frame it needs to unmount. */
export const GRACE_MS = 400;

/** A lock nobody holds: hidden on body with no modal on screen. */
export function lockIsStale(overflow: string, modals: number): boolean {
  return overflow.trim() === 'hidden' && modals === 0;
}

export interface GuardEnv {
  overflow(): string;
  clear(): void;
  modals(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface ScrollGuard {
  /** Something may have changed (body's style, the page showing again): look soon. */
  poke(): void;
  stop(): void;
}

export function createScrollGuard(env: GuardEnv, graceMs = GRACE_MS): ScrollGuard {
  let timer: unknown;
  let armed = false;
  const check = () => {
    armed = false;
    if (lockIsStale(env.overflow(), env.modals())) {
      env.clear();
      return;
    }
    // Still locked by a modal that is open: look again when it may be gone.
    if (env.overflow().trim() === 'hidden') arm();
  };
  const arm = () => {
    if (armed) return;
    armed = true;
    timer = env.setTimer(check, graceMs);
  };
  return {
    poke: arm,
    stop() {
      if (armed) env.clearTimer(timer);
      armed = false;
    },
  };
}

/** Watches the page's body for the rest of its life; returns a function that stops it. */
export function installScrollGuard(doc: Document = document, win: Window = window): () => void {
  const guard = createScrollGuard({
    overflow: () => doc.body.style.overflow,
    clear: () => {
      doc.body.style.overflow = '';
    },
    modals: () => doc.querySelectorAll(MODAL_SELECTOR).length,
    setTimer: (fn, ms) => win.setTimeout(fn, ms),
    clearTimer: (h) => win.clearTimeout(h as number),
  });
  const observer = new MutationObserver(() => guard.poke());
  observer.observe(doc.body, { attributes: true, attributeFilter: ['style'] });
  const again = () => guard.poke();
  doc.addEventListener('visibilitychange', again);
  win.addEventListener('pageshow', again);
  guard.poke();
  return () => {
    observer.disconnect();
    doc.removeEventListener('visibilitychange', again);
    win.removeEventListener('pageshow', again);
    guard.stop();
  };
}
