// The standard for a list that grows (owner, 2026-11-01: "I really don't like the too-much-scrolling approach, especially on growable
// lists"; docs/prd/ui-layout.md). A list in a card never pushes the page taller and taller: on a desktop it has a height bound and scrolls
// inside itself, with a soft fade at an edge that has more behind it; on a phone (where the page is the one scroll container) it shows a
// first part and "Show all". Pure, so the edges and the cut are tested without a browser; components/BoundedBody.tsx draws it.

/** Where a bounded body has more content than it shows: above (scrolled down), below (more to scroll), cut (it overflows at all). */
export interface Edges {
  top: boolean;
  bottom: boolean;
  cut: boolean;
}

/** A pixel of slack, so sub-pixel layout never shows a fade over nothing. */
const SLACK = 1;

export function edgesOf(m: { scrollTop: number; scrollHeight: number; clientHeight: number }): Edges {
  const cut = m.scrollHeight - m.clientHeight > SLACK;
  return {
    cut,
    top: cut && m.scrollTop > SLACK,
    bottom: cut && m.scrollTop + m.clientHeight < m.scrollHeight - SLACK,
  };
}

/** On a phone a bounded body shows this much before "Show all" (about six list rows). */
export const PHONE_CUT_REM = 22;
/** On a desktop a bounded body that does not fill a tile stops at this height and scrolls inside. */
export const DESKTOP_MAX = 'min(32rem, 60dvh)';
