import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { guards, placePopover, safeInsets, visibleBox } from '@/lib/popover';

/**
 * A small panel anchored to the control that opened it (T-102): on the side `prefer` asks when it fits, inside the visible viewport and the
 * safe areas, never over the composer (`[data-popover-floor]`) or under the session header (`[data-popover-ceiling]`). Rendered into <body>,
 * so no card's overflow clips it. It closes on a tap outside, Escape, a scroll of the page under it, and a resize. For a laptop; a phone
 * gets a sheet instead.
 */
export function Popover({
  anchor,
  open,
  onClose,
  label,
  width = 340,
  prefer = 'above',
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  label: string;
  width?: number;
  prefer?: 'above' | 'below';
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden', top: 0, left: 0, width });

  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return;
    const place = () => {
      if (!anchor.current || !panel.current) return;
      const r = anchor.current.getBoundingClientRect();
      const height = panel.current.scrollHeight;
      const p = placePopover({ anchor: r, width, height, view: visibleBox(), safe: safeInsets(), prefer, ...guards(anchor.current) });
      setStyle({ position: 'fixed', top: p.top, left: p.left, width: p.width, maxHeight: p.maxHeight ?? undefined, overflowY: p.maxHeight ? 'auto' : undefined });
    };
    place();
  }, [open, anchor, width, prefer, children]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchor.current?.contains(t) && !panel.current?.contains(t)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const scrolled = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open, anchor, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      style={style}
      className="z-[60] rounded-2xl border border-line bg-surface p-3 text-[13.5px] break-words text-ink-soft shadow-lift [overflow-wrap:anywhere]"
    >
      {children}
    </div>,
    document.body,
  );
}
