import { cn, Segmented, useTheme, type ThemeChoice } from '@isnanme/ui';
import { LogOut, ShieldCheck } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * The admin's menu: who is signed in, the theme, and sign out. `row` sits at the foot of the
 * sidebar and opens upward; `avatar` is the round button in the phone app bar.
 */
export function AccountMenu({ variant = 'avatar', onLogout }: { variant?: 'avatar' | 'row'; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const avatar = (
    <span
      aria-hidden="true"
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink ring-1 ring-line"
    >
      <ShieldCheck className="size-[18px]" />
    </span>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'press',
          variant === 'row'
            ? 'flex w-full items-center justify-center gap-3 rounded-2xl p-1 text-left hover:bg-surface-2 lg:justify-start lg:p-2'
            : 'rounded-full hover:opacity-80',
        )}
      >
        {avatar}
        {variant === 'row' && (
          <span className="hidden min-w-0 flex-1 lg:block">
            <span className="block truncate text-sm font-semibold">Admin</span>
            <span className="block truncate text-[12px] text-muted">Signed in with server code</span>
          </span>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14 }}
            className={cn(
              'absolute z-40 w-64 rounded-2xl border border-line bg-surface p-1.5 shadow-lift',
              variant === 'row' ? 'bottom-full left-0 mb-2 origin-bottom-left' : 'right-0 mt-2 origin-top-right',
            )}
          >
            <div className="px-2.5 pt-1.5 pb-2.5">
              <p className="truncate text-sm font-bold">Admin</p>
              <p className="truncate text-[13px] text-muted">Signed in with server code</p>
            </div>
            <div className="my-1 h-px bg-line" />
            <div className="px-2.5 py-2">
              <p id="theme-label" className="mb-2 text-[12px] font-semibold text-muted">
                Theme
              </p>
              <Segmented label="Theme" labelledBy="theme-label" value={theme} options={THEMES} onChange={setTheme} />
            </div>
            <div className="my-1 h-px bg-line" />
            <button
              type="button"
              role="menuitem"
              onClick={() => (setOpen(false), onLogout())}
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm font-medium text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <LogOut className="size-4" /> Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
