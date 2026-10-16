import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Which side of its chip the popover opens on (it keeps inside the screen either way). */
export type PopoverSide = 'below' | 'above' | 'left' | 'right';

const WIDTH = 344;
const MARGIN = 12;
const GAP = 8;

/** Where the popover goes for a chip's box: fixed, so no clipped parent or page transform moves it. Pure, so it is easy to check. */
export function placePopover(chip: { left: number; right: number; top: number; bottom: number }, side: PopoverSide, view: { w: number; h: number }, edge?: number): { left?: number; right?: number; top?: number; bottom?: number; width: number; maxHeight: number } {
  const width = Math.min(WIDTH, view.w - MARGIN * 2);
  const clampLeft = (x: number) => Math.min(Math.max(x, MARGIN), view.w - width - MARGIN);
  if (side === 'left') {
    const top = Math.max(MARGIN, Math.min(chip.top, view.h - 160));
    return { right: view.w - chip.left + GAP, top, width, maxHeight: view.h - top - MARGIN };
  }
  if (side === 'right') {
    const bottom = Math.max(MARGIN, view.h - chip.bottom);
    return { left: Math.min((edge ?? chip.right) + GAP, view.w - width - MARGIN), bottom, width, maxHeight: view.h - bottom - MARGIN };
  }
  const leftAligned = chip.left + (chip.right - chip.left) / 2 <= view.w / 2;
  const left = clampLeft(leftAligned ? chip.left : chip.right - width);
  if (side === 'above') return { left, bottom: view.h - chip.top + GAP, width, maxHeight: Math.max(160, chip.top - GAP - MARGIN) };
  return { left, top: chip.bottom + GAP, width, maxHeight: Math.max(160, view.h - chip.bottom - GAP - MARGIN) };
}

/**
 * The full form on a larger screen: a panel beside the chip that opened it. Not modal: Escape or a tap elsewhere closes it and
 * focus goes back to the chip. A tap inside a dialog or an ⓘ note that a widget opened does not count as elsewhere.
 */
export function GlancePopover({ anchor, side, label, onClose, children }: { anchor: HTMLElement; side: PopoverSide; label: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });

  useLayoutEffect(() => {
    const measure = () => {
      const r = anchor.getBoundingClientRect();
      const edge = side === 'right' ? (anchor.closest('aside')?.getBoundingClientRect().right ?? r.right) : undefined;
      const next: CSSProperties = { position: 'fixed', ...placePopover(r, side, { w: window.innerWidth, h: window.innerHeight }, edge) };
      // A scroll inside the popover itself fires this too: keep the same object when nothing moved.
      setStyle((cur) => (cur && (Object.keys(next) as (keyof CSSProperties)[]).every((k) => cur[k] === next[k]) ? cur : next));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchor, side]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || panel.current?.contains(t) || anchor.contains(t)) return;
      if (t.closest('[aria-modal="true"], [role="note"], [data-glance-keep]')) return;
      close.current();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      close.current();
      anchor.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [anchor]);

  // Keyboard users land inside once it is placed (a hidden element cannot take focus, and it is hidden until it has a position).
  const placed = style !== null;
  useEffect(() => {
    if (placed) panel.current?.focus({ preventScroll: true });
  }, [placed]);

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-focus-container
      style={style ?? { position: 'fixed', visibility: 'hidden' }}
      className="z-[45] flex flex-col overflow-hidden rounded-[20px] border border-line bg-surface shadow-lift outline-none"
    >
      {children}
    </div>,
    document.body,
  );
}
