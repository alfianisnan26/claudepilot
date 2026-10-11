import { Info } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const WIDTH = 256;
const MARGIN = 16;

/**
 * A small ⓘ that opens a note on tap (title tooltips never show on touch screens). The note is placed
 * under the ⓘ and kept inside the screen; it closes on a tap elsewhere, Escape, or scrolling. For the
 * explanations a page shouldn't spell out in full.
 */
export function InfoTip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Rendered into <body>, so no card's overflow or a page transition's transform can clip or shift it.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
    const left = Math.min(Math.max(r.left + r.width / 2 - width / 2, MARGIN), window.innerWidth - width - MARGIN);
    setStyle({ position: 'fixed', top: r.bottom + 6, left, width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !note.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
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
        className={`press inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink ${className ?? ''}`}
      >
        <Info className="size-4" />
      </button>
      {open &&
        createPortal(
          <span
            ref={note}
            id={id}
            role="note"
            style={style}
            className="z-[60] block rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-[13px] leading-snug font-normal text-ink-soft shadow-lift"
          >
            {children}
          </span>,
          document.body,
        )}
    </>
  );
}
