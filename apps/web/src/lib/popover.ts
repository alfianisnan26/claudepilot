// Where a small popover goes (T-102): next to the control that opened it, inside what is visible (the visual viewport, so the keyboard and
// a pinch zoom count, less the safe areas), and never over the composer or under the session header. Pure placement plus the two DOM reads it
// needs, so the rule is tested without a browser.

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PlaceInput {
  /** The control's rectangle (client coordinates). */
  anchor: { top: number; bottom: number; left: number; right: number };
  /** The popover's natural size. */
  width: number;
  height: number;
  /** What is visible: the visual viewport (offset and size), in client coordinates. */
  view: Box;
  safe: Insets;
  /** The top of what must stay uncovered below the control (the composer), when there is one. */
  floor?: number | null;
  /** The bottom of what must stay uncovered above the control (the session header), when there is one. */
  ceiling?: number | null;
  /** Which side to try first. Below, unless the screen says otherwise. */
  prefer?: 'above' | 'below';
  margin?: number;
  gap?: number;
}

export interface Placement {
  top: number;
  left: number;
  width: number;
  /** Set when neither side has room for all of it: it scrolls inside. */
  maxHeight: number | null;
  side: 'above' | 'below';
}

/**
 * The popover's place: as wide as asked but never wider than the visible width; centred on the control and kept inside the edges; on the
 * preferred side when it fits there between the control and the floor (or the ceiling), else on the other side, else on the roomier one,
 * cut to fit (it scrolls).
 */
export function placePopover(i: PlaceInput): Placement {
  const margin = i.margin ?? 12;
  const gap = i.gap ?? 6;
  const minX = i.view.left + i.safe.left + margin;
  const maxX = i.view.left + i.view.width - i.safe.right - margin;
  const width = Math.max(0, Math.min(i.width, maxX - minX));
  const centre = (i.anchor.left + i.anchor.right) / 2;
  const left = Math.min(Math.max(centre - width / 2, minX), maxX - width);

  let bottomLimit = i.view.top + i.view.height - i.safe.bottom - margin;
  if (i.floor != null && i.floor >= i.anchor.bottom) bottomLimit = Math.min(bottomLimit, i.floor - gap);
  let topLimit = i.view.top + i.safe.top + margin;
  if (i.ceiling != null && i.ceiling <= i.anchor.top) topLimit = Math.max(topLimit, i.ceiling + gap);

  const below = bottomLimit - (i.anchor.bottom + gap);
  const above = i.anchor.top - gap - topLimit;
  const order: ('above' | 'below')[] = i.prefer === 'above' ? ['above', 'below'] : ['below', 'above'];
  const room = (side: 'above' | 'below') => (side === 'above' ? above : below);
  const side = order.find((s) => room(s) >= i.height) ?? (above > below ? 'above' : 'below');
  const height = Math.min(i.height, Math.max(0, room(side)));
  const top = side === 'below' ? i.anchor.bottom + gap : i.anchor.top - gap - height;
  return { top, left, width, maxHeight: height < i.height ? Math.max(0, room(side)) : null, side };
}

/**
 * The visible box, cut at the page's own content edge (T-1988): `contentWidth` is the root's clientWidth, which leaves out a classic
 * scrollbar and the gutter `scrollbar-gutter: stable` keeps for it; the window's width counts them, so a popover kept 12 px inside it sat
 * flush against the scrollbar. An overlay scrollbar (phones, macOS) takes no room and changes nothing.
 */
export function clipToContent(view: Box, contentWidth: number): Box {
  if (!(contentWidth > 0)) return view;
  return { ...view, width: Math.max(0, Math.min(view.width, contentWidth - view.left)) };
}

/** The visible area: the visual viewport where there is one (the keyboard and a zoom shrink it), else the window; never the scrollbar. */
export function visibleBox(): Box {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  const view = vv ? { top: vv.offsetTop, left: vv.offsetLeft, width: vv.width, height: vv.height } : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  return clipToContent(view, document.documentElement.clientWidth);
}

/** The safe-area insets in pixels, read through the app's own `--safe-*` variables (index.css). */
export function safeInsets(): Insets {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const px = (v: string) => Number.parseFloat(v) || 0;
  const out = { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  probe.remove();
  return out;
}

/**
 * What must stay uncovered around a control: the nearest `[data-popover-floor]` below it (the composer) and `[data-popover-ceiling]` above it
 * (the session header). A control inside the floor itself (a chip in the composer) has none below.
 */
export function guards(anchor: Element): { floor: number | null; ceiling: number | null } {
  const r = anchor.getBoundingClientRect();
  let floor: number | null = null;
  let ceiling: number | null = null;
  for (const el of document.querySelectorAll('[data-popover-floor]')) {
    if (el.contains(anchor)) continue;
    const b = el.getBoundingClientRect();
    if (b.height > 0 && b.top >= r.bottom - 1) floor = floor === null ? b.top : Math.min(floor, b.top);
  }
  for (const el of document.querySelectorAll('[data-popover-ceiling]')) {
    if (el.contains(anchor)) continue;
    const b = el.getBoundingClientRect();
    if (b.height > 0 && b.bottom <= r.top + 1) ceiling = ceiling === null ? b.bottom : Math.max(ceiling, b.bottom);
  }
  return { floor, ceiling };
}
