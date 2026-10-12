import { cn } from '@isnanme/ui';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type CSSProperties, type FocusEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeTop } from './escape';

/**
 * Text that came out of a workspace (a repo's name, a branch, a commit's subject, a session's title) never decides how wide
 * anything is: it is one line cut with an ellipsis (`Clamp`), and when it is cut its owner (the row's button, a link) shows the
 * whole of it in a tooltip, on pointer hover and on keyboard focus (`tipProps`, `ClampTipHost`). Where the text may run to several
 * lines it breaks anywhere instead (`BREAK`). Right-to-left text reads right (`dir="auto"`).
 * (Until the shared dynamic-text component lands in components/; then this is a call to replace.)
 */
export const BREAK = '[overflow-wrap:anywhere]';

/** The id of the one tooltip there is, for the owner's `aria-describedby`. */
export const TIP_ID = 'repo-clamp-tip';

interface Tip {
  owner: HTMLElement;
  lines: string[];
}

let tip: Tip | null = null;
const subscribers = new Set<() => void>();
const publish = (t: Tip | null) => {
  tip = t;
  subscribers.forEach((fn) => fn());
};
const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
};

/** One line of user-written text, cut with an ellipsis. Mark: `data-clamp`, which the owner looks for to see whether it was cut. */
export function Clamp({ children, className }: { children: string; className?: string }) {
  return (
    <span data-clamp="" dir="auto" className={cn('block min-w-0 truncate', className)}>
      {children}
    </span>
  );
}

/** What is cut inside an owner, whole. */
export function cutText(root: Element): string[] {
  return [...root.querySelectorAll<HTMLElement>('[data-clamp]')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent ?? '');
}

function show(el: Element) {
  const owner = (el.closest('[data-clamp-owner]') ?? el) as HTMLElement;
  const lines = cutText(owner);
  publish(lines.length ? { owner, lines } : null);
}

/**
 * Handlers for what owns clamped text: spread them on the focusable element (focus and blur) and on the row around it (hover). The
 * row carries `data-clamp-owner`. A touch has no hover: it opens the thing, which shows the text in full.
 */
export const tipProps = {
  onFocus: (e: FocusEvent<Element>) => show(e.currentTarget),
  onBlur: () => publish(null),
  onPointerEnter: (e: PointerEvent<Element>) => e.pointerType !== 'touch' && show(e.currentTarget),
  onPointerLeave: () => publish(null),
};

/** Where the tooltip is drawn: once, inside the tab. It is a note, never in the way (no pointer events), gone on scroll and on Escape. */
export function ClampTipHost() {
  const t = useSyncExternalStore(subscribe, () => tip);
  const [style, setStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!t) return;
    const r = t.owner.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(320, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(r.left + 8, margin), window.innerWidth - width - margin);
    const flip = window.innerHeight - r.bottom < 96 && r.top > 96;
    setStyle({ position: 'fixed', width, left, ...(flip ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  }, [t]);
  useEscapeTop(!!t, () => publish(null));
  useEffect(() => {
    if (!t) return;
    const hide = () => publish(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [t]);
  // The tab went away with a tooltip showing.
  useEffect(() => () => publish(null), []);
  if (!t) return null;
  return createPortal(
    <span id={TIP_ID} role="tooltip" style={style} className={cn('pointer-events-none z-[80] block rounded-xl border border-line bg-surface px-3 py-2 text-[13px] leading-snug text-ink-soft shadow-lift', BREAK)}>
      {t.lines.map((line, i) => (
        <span key={i} dir="auto" className="block">
          {line}
        </span>
      ))}
    </span>,
    document.body,
  );
}
