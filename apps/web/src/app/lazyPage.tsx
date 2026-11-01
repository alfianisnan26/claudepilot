import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';

// Pages loaded on first use (owner request 2026-11-01, performance): the first load of the app carries Home, the frame and the sign-in;
// every other page is its own chunk. Once the first page has painted, `preloadPages` fetches them while the browser is idle, so a tap on
// the nav still opens a page without a wait on the network.

const loaders: (() => Promise<unknown>)[] = [];

/** `lazy()` for a named export, remembered for `preloadPages`. */
export function lazyPage<M>(load: () => Promise<M>, pick: (m: M) => ComponentType<any>) {
  loaders.push(load);
  return lazy(() => load().then((m) => ({ default: pick(m) })));
}

/** A lazily loaded page inside the app frame: a skeleton where the page goes while its chunk loads (the frame stays). */
export function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="skeleton h-28 rounded-[24px]" aria-busy="true" />}>{children}</Suspense>;
}

let preloaded = false;

/**
 * Fetches every page's chunk once the browser is idle (one at a time, so the page in use keeps the network). Safe to call more than once.
 * A chunk that fails (a deploy replaced it) is ignored here: opening that page shows the error boundary's Reload as before.
 */
export function preloadPages(): void {
  if (preloaded || typeof window === 'undefined') return;
  preloaded = true;
  const idle = (fn: () => void) =>
    'requestIdleCallback' in window ? window.requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500);
  const next = (i: number) => {
    if (i >= loaders.length) return;
    idle(
      () =>
        void loaders[i]!()
          .catch(() => undefined)
          .finally(() => next(i + 1)),
    );
  };
  next(0);
}
