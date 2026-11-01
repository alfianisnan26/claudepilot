// Where an app page scrolls (owner, 2026-11-01: "only the content pane scrolls" on a desktop). On a desktop the app frame is fixed and the
// content pane (`#main-scroll`, AppShell) is the scroll container; on a phone the document scrolls as before (lib/viewport.ts pins it).
// Code that scrolls "the page" asks here instead of using window.

export const PANE_ID = 'main-scroll';

/** The pane when it is the scroll container (a desktop), else null (the document scrolls). */
export function scrollPane(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(PANE_ID);
  if (!el) return null;
  const y = getComputedStyle(el).overflowY;
  return y === 'auto' || y === 'scroll' ? el : null;
}

/** The page's scroll offset and a scroll to `top`, on the pane or the window. */
export function pageScrollTop(): number {
  return scrollPane()?.scrollTop ?? window.scrollY;
}

export function scrollPageTo(top: number): void {
  const pane = scrollPane();
  if (pane) pane.scrollTo({ top });
  else window.scrollTo({ top });
}
