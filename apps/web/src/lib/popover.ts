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
 * T-1825: a popover beside an element (the Agents tree's failed list next to the lead's card, not over its row): on its right when the
 * visible width has room for all of it, else on its left, else null (the caller falls back to {@link placePopover}). Its top lines up with
 * the element's; taller than the element, its bottom does instead (it grows upwards, so it never hangs over what is below the element),
 * kept inside the visible height; taller than that, it scrolls inside. `avoid` is what it must never cover (the control that opened it):
 * a side that would cover it is passed over for one that does not; when every side would, it ends just above `avoid` when that has room
 * (so it never hangs over what is below the element), else it starts just below it.
 */
export function placeBeside(i: {
  target: { top: number; bottom: number; left: number; right: number };
  width: number;
  height: number;
  view: Box;
  safe: Insets;
  avoid?: { top: number; bottom: number; left: number; right: number } | null;
  margin?: number;
  gap?: number;
}): { top: number; left: number; width: number; maxHeight: number | null; side: 'right' | 'left' } | null {
  const margin = i.margin ?? 12;
  const gap = i.gap ?? 12;
  const minX = i.view.left + i.safe.left + margin;
  const maxX = i.view.left + i.view.width - i.safe.right - margin;
  const minY = i.view.top + i.safe.top + margin;
  const maxY = i.view.top + i.view.height - i.safe.bottom - margin;
  const room = Math.max(0, maxY - minY);
  const height = Math.min(i.height, room);
  const want = height > i.target.bottom - i.target.top ? i.target.bottom - height : i.target.top;
  const top = Math.min(Math.max(want, minY), maxY - height);
  const sides: { side: 'right' | 'left'; left: number }[] = [];
  if (maxX - (i.target.right + gap) >= i.width) sides.push({ side: 'right', left: i.target.right + gap });
  if (i.target.left - gap - minX >= i.width) sides.push({ side: 'left', left: i.target.left - gap - i.width });
  if (sides.length === 0) return null;
  const a = i.avoid;
  const covers = (left: number, t: number) => !!a && left < a.right && left + i.width > a.left && t < a.bottom && t + height > a.top;
  const clear = sides.find((x) => !covers(x.left, top));
  if (clear) return { top, left: clear.left, width: i.width, maxHeight: height < i.height ? room : null, side: clear.side };
  // Every side covers it: above it when there is room, else below it.
  const above = a!.top - 6 - height;
  if (above >= minY && height === i.height) return { top: above, left: sides[0]!.left, width: i.width, maxHeight: null, side: sides[0]!.side };
  const below = Math.max(top, a!.bottom + 6);
  const fit = Math.max(0, maxY - below);
  const h = Math.min(i.height, fit);
  return { top: below, left: sides[0]!.left, width: i.width, maxHeight: h < i.height ? fit : null, side: sides[0]!.side };
}

/** T-1825: the visible area cut to an element's width (a page's content column), so a popover stays off a sidebar; the view when they miss. */
export function narrowTo(view: Box, el: { left: number; right: number }): Box {
  const left = Math.max(view.left, el.left);
  const right = Math.min(view.left + view.width, el.right);
  return right - left > 0 ? { ...view, left, width: right - left } : view;
}

/** The visible area: the visual viewport where there is one (the keyboard and a zoom shrink it), else the window. */
export function visibleBox(): Box {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (vv) return { top: vv.offsetTop, left: vv.offsetLeft, width: vv.width, height: vv.height };
  return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
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
