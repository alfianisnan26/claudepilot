import { useEffect, useRef, type ReactNode } from 'react';

// No UI-kit import: the Admin console and the reporter panel (two small bundles of their own) draw their sheets with this. Portal pages use
// the kit's Dialog, FormDialog and ConfirmDialog (docs/coord/UI-STANDARD.md §5).
const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** Open sheets, the top last: Escape closes only the top one (a confirmation over a detail sheet). */
const open: object[] = [];
/** How many sheets are open (a side panel's Escape waits for them). */
export const sheetsOpen = () => open.length;

export interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * `sheet` (default): a bottom sheet on a phone, centred from 640 px. `bottom`: a bottom sheet at every width (the reporter panel is a narrow
   * frame). `page`: the whole window, with a back row (the reporter's Context).
   */
  variant?: 'sheet' | 'bottom' | 'page';
  /** The title row; the default is the title and a Close button. */
  head?: ReactNode;
  /** Under the scrolling body, always in view (a sheet's actions). */
  footer?: ReactNode;
  /** More classes on the dialog box (its motion, its height). */
  className?: string;
  bodyClassName?: string;
}

/**
 * THE kit-free sheet (docs/coord/UI-STANDARD.md §5): a modal dialog with its title, a body that scrolls inside and an optional footer. Escape
 * closes the top one only (and goes no further: the reporter panel's own Escape closes the panel), the backdrop closes it, focus moves into it
 * and returns to what opened it.
 */
export function Sheet({ title, onClose, children, variant = 'sheet', head, footer, className, bodyClassName = 'flex flex-col gap-4 p-4' }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest onClose, so a parent's re-render (a new arrow each time) neither re-focuses the sheet nor reorders the stack.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const me = {};
    open.push(me);
    const prev = document.activeElement as HTMLElement | null;
    // A field that took focus itself (autoFocus) keeps it.
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || open.at(-1) !== me) return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      open.splice(open.indexOf(me), 1);
      prev?.focus?.();
    };
  }, []);

  const header = head ?? (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-4">
      <h2 className="min-w-0 flex-1 py-3 text-base font-semibold [overflow-wrap:anywhere]">{title}</h2>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-line bg-surface outline-hidden hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
  const body = <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', bodyClassName)}>{children}</div>;

  if (variant === 'page')
    return (
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={cn('fixed inset-0 z-50 flex flex-col bg-bg outline-hidden', className)}>
        {header}
        {body}
        {footer}
      </div>
    );
  return (
    <div className={cn('fixed inset-0 z-40 flex flex-col items-center justify-end', variant === 'sheet' && 'sm:justify-center sm:p-4')}>
      <button type="button" aria-label={`Close ${title}`} tabIndex={-1} onClick={onClose} className="absolute inset-0 cursor-default bg-black/40" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[90dvh] w-full flex-col rounded-t-2xl bg-bg pb-[env(safe-area-inset-bottom)] shadow-lg outline-hidden',
          variant === 'sheet' && 'sm:max-w-lg sm:rounded-2xl sm:pb-0',
          className,
        )}
      >
        {header}
        {body}
        {footer}
      </div>
    </div>
  );
}
