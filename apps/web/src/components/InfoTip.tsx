import { Info } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { guards, placePopover, safeInsets, visibleBox } from '@/lib/popover';

const WIDTH = 256;

/**
 * A small ⓘ that opens a note on tap (title tooltips never show on touch screens). The note is placed next to the ⓘ inside what is
 * visible (the visual viewport, so the keyboard counts, less the safe areas: lib/popover.ts), never over the composer or under the
 * session header; in the stack above the composer it opens upwards (T-102). Its text wraps anywhere. It closes on a tap elsewhere,
 * Escape, or scrolling. For the explanations a page shouldn't spell out in full. `text` shows a word instead of the ⓘ ("est." beside an
 * estimated number), `icon` a mark of its own (a session row's Bypass dot). On a phone the button is 44 px (the tap target) with negative margins, so it takes the room it took before.
 */
export function InfoTip({ label, children, className, text, icon }: { label: string; children: ReactNode; className?: string; text?: string; icon?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden', top: 0, left: 0, width: WIDTH });
  const button = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Rendered into <body>, so no card's overflow or a page transition's transform can clip or shift it. Measured first (hidden), then placed.
  useLayoutEffect(() => {
    if (!open || !button.current || !note.current) return;
    const r = button.current.getBoundingClientRect();
    const prefer = button.current.closest('[data-session-dock]') ? 'above' : 'below';
    const p = placePopover({ anchor: r, width: WIDTH, height: note.current.offsetHeight, view: visibleBox(), safe: safeInsets(), prefer, ...guards(button.current) });
    setStyle({ position: 'fixed', top: p.top, left: p.left, width: p.width, maxHeight: p.maxHeight ?? undefined, overflowY: p.maxHeight ? 'auto' : undefined });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !note.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const close = () => setOpen(false);
    // A scroll anywhere but inside the note itself (a long one scrolls) moves what it points at: it closes. So does the keyboard moving the view.
    const scrolled = (e: Event) => !note.current?.contains(e.target as Node) && setOpen(false);
    const vv = window.visualViewport;
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', close);
    vv?.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', close);
      vv?.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`press inline-flex shrink-0 items-center justify-center text-muted hover:bg-surface-2 hover:text-ink ${text ? 'h-6 min-w-6 rounded-md px-1 text-[11px] font-semibold underline decoration-dotted underline-offset-2 tap:h-11 tap:min-w-11 tap:-mx-2 tap:-my-2.5' : 'size-6 rounded-full tap:size-11 tap:-m-2.5'} ${className ?? ''}`}
      >
        {text ?? icon ?? <Info className="size-4" />}
      </button>
      {open &&
        createPortal(
          <span
            ref={note}
            id={id}
            role="note"
            style={style}
            className="z-[60] block rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-[13px] leading-snug font-normal break-words whitespace-normal text-ink-soft normal-case shadow-lift [overflow-wrap:anywhere]"
          >
            {children}
          </span>,
          document.body,
        )}
    </>
  );
}
