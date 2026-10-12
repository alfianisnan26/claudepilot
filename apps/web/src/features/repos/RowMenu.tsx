import { cn, ease, Spinner } from '@isnanme/ui';
import { Check, MoreHorizontal } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeTop } from './escape';

export interface RowMenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Why it is disabled, when that is something to tell (the portal refused it for this person): shown under the label. */
  note?: string;
  /** A setting: given, the item is a check box (a check mark shows while it is on). */
  checked?: boolean;
}

const WIDTH = 208;
const ROW = 44;
const GAP = 6;

/**
 * The ⋯ of a row. The kit's Menu opens inside its parent, so a row at the bottom of a sheet's scrolling list opens it out of
 * sight; this one is placed on the screen when it opens, below the button or above it where there's no room, and keeps inside the
 * edges. Escape closes only the menu (a sheet under it stays), a tap elsewhere, a scroll or Tab closes it, arrows move. The
 * button and the items are 44 px.
 */
export function RowMenu({ label, items, busy, className }: { label: string; items: RowMenuItem[]; busy?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  // Mounted only while it is open or on its way out: a long list has hundreds of these.
  const [present, setPresent] = useState(false);
  const [place, setPlace] = useState<{ style: CSSProperties; up: boolean }>({ style: {}, up: false });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const height = items.length * ROW + 12;
    const below = window.innerHeight - r.bottom - GAP;
    const up = below < height && r.top - GAP > below;
    const right = Math.max(8, Math.min(window.innerWidth - WIDTH - 8, window.innerWidth - r.right));
    // Always on the screen: at least 120 px of it, even for a button that is itself half out of view.
    const room = Math.max(120, (up ? r.top : window.innerHeight - r.bottom) - GAP - 8);
    setPlace({
      up,
      style: {
        position: 'fixed',
        width: WIDTH,
        right,
        ...(up ? { bottom: Math.max(8, window.innerHeight - r.top + GAP) } : { top: Math.min(r.bottom + GAP, window.innerHeight - room - 8) }),
        maxHeight: room,
      },
    });
  }, [open, items.length]);

  useEscapeTop(open, () => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  });

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Tab') setOpen(false);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
        if (list.length === 0) return;
        e.preventDefault();
        const at = list.indexOf(document.activeElement as HTMLElement);
        list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
      }
    };
    const scrolled = (e: Event) => !menu.current?.contains(e.target as Node) && setOpen(false);
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
  }, [open, place]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setPresent(true);
          setOpen((o) => !o);
        }}
        className={cn('press inline-flex size-11 shrink-0 items-center justify-center rounded-full disabled:opacity-100', open ? 'bg-surface-2 text-ink' : 'text-muted hover:bg-surface-2 hover:text-ink', className)}
      >
        {busy ? <Spinner className="size-4" /> : <MoreHorizontal className="size-[18px]" />}
      </button>
      {present &&
        createPortal(
        <AnimatePresence onExitComplete={() => setPresent(false)}>
          {open && (
            <motion.div
              ref={menu}
              role="menu"
              aria-label={label}
              style={place.style}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
              transition={{ duration: 0.14, ease }}
              className={cn('z-[70] overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-lift', place.up ? 'origin-bottom-right' : 'origin-top-right')}
            >
              {items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={it.checked}
                  aria-disabled={it.disabled || undefined}
                  title={it.disabled ? it.note : undefined}
                  onClick={() => {
                    if (it.disabled) return;
                    setOpen(false);
                    it.onSelect();
                  }}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 py-1 text-left text-sm font-medium transition-colors',
                    it.disabled && 'cursor-not-allowed',
                    it.danger ? 'text-danger' : 'text-ink-soft',
                    !it.disabled && (it.danger ? 'hover:bg-danger-soft focus:bg-danger-soft' : 'hover:bg-surface-2 hover:text-ink focus:bg-surface-2'),
                  )}
                >
                  {it.icon && <span className={cn('shrink-0', it.disabled && 'opacity-40')}>{it.icon}</span>}
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate', it.disabled && 'opacity-40')}>{it.label}</span>
                    {it.disabled && it.note && <span className="block text-[11.5px] leading-tight font-normal whitespace-normal text-muted [overflow-wrap:anywhere]">{it.note}</span>}
                  </span>
                  {it.checked && <Check className={cn('size-4 shrink-0 text-accent', it.disabled && 'opacity-40')} />}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
