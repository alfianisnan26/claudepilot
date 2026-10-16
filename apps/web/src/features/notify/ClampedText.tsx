import { cn } from '@isnanme/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

/**
 * Dynamic text (a name, a title, a body that a person or an agent wrote) in a fixed number of lines. The whole text is always in the
 * page (screen readers read it); when it is cut, the element can be focused and shows the full text in a tooltip on focus, hover or
 * tap. Unbroken values wrap anywhere, so the text never decides the width of its container (QA standard A9).
 */
export function ClampedText({ children, lines = 1, className }: { children: string; lines?: 1 | 2 | 3; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const id = useId();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children, lines]);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 32);
    setStyle({ position: 'fixed', top: r.bottom + 6, left: Math.min(Math.max(r.left, 16), window.innerWidth - width - 16), width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const close = () => setOpen(false);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const clamp = lines === 1 ? 'line-clamp-1' : lines === 2 ? 'line-clamp-2' : 'line-clamp-3';
  return (
    <>
      <span
        ref={ref}
        tabIndex={cut ? 0 : undefined}
        aria-describedby={cut && open ? id : undefined}
        onFocus={() => cut && setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => cut && setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className={cn('block min-w-0 [overflow-wrap:break-word]', clamp, cut && 'rounded focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden', className)}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <span id={id} role="tooltip" style={style} className="pointer-events-none z-[60] block rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] leading-snug break-words text-ink-soft shadow-lift">
            {children}
          </span>,
          document.body,
        )}
    </>
  );
}
