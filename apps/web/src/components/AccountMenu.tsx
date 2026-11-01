import { cn, Segmented, useTheme, type ThemeChoice } from '@isnanme/ui';
import { ChevronsUpDown, LogOut, UserRound } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { accountView, type AccountView } from '@/features/profile/model';
import { useOrgs } from '@/features/orgs/OrgsProvider';
import { useMe } from '@/lib/me';
import { Avatar } from './Avatar';
import { InfoTip } from './InfoTip';

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export const PROFILE_PATH = '/admin/profile';

/** The platform role as a small chip beside the name. */
export function RoleChip({ role }: { role: AccountView['role'] }) {
  if (!role) return null;
  return (
    <span
      data-role-chip={role}
      className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-4 font-semibold', role === 'Admin' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-soft')}
    >
      {role}
    </span>
  );
}

/** Why the server code is not an account (shown wherever a server-code session is named). */
export const SERVER_CODE_NOTE = 'The server code is the break-glass sign-in: it acts as the owner. Sign in with your account for everyday use.';

/**
 * Who is signed in, the theme, the Profile and sign out (owner request 2026-11-01: an account shows the person, the server code says it is
 * the server code). `row` sits at the foot of the sidebar and opens upward; `avatar` is the round button in the phone app bar, where it also
 * holds the Context row (`onContext` opens the org switcher's sheet; owner, 2026-11-01).
 */
export function AccountMenu({ variant = 'avatar', onLogout, onContext }: { variant?: 'avatar' | 'row'; onLogout: () => void; onContext?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { theme, setTheme } = useTheme();
  const me = useMe();
  const { currentOrg } = useOrgs();
  const v = accountView(me, currentOrg);

  useEffect(() => {
    if (!open) return;
    // A tap in the InfoTip's note (drawn into <body>) is still inside the menu.
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest?.('[role="note"]')) setOpen(false);
    };
    // Escape closes and hands focus back to the button that opened it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Opening by keyboard moves focus into the panel, so Tab continues through its controls.
  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div ref={ref} className="relative" data-account-menu={v.serverCode ? 'code' : me ? 'account' : 'loading'}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label="Account menu"
        onClick={() => setOpen((x) => !x)}
        className={cn(
          'press',
          variant === 'row'
            ? 'flex min-h-11 w-full items-center justify-center gap-3 rounded-2xl p-1 text-left hover:bg-surface-2 lg:justify-start lg:p-2'
            : // 36 px to look at, 44 px to tap (the padding is taken back with the margin, so nothing moves).
              '-m-1 rounded-full p-1 hover:opacity-80',
        )}
      >
        <Avatar src={v.avatar} initials={v.initials} className="size-9 text-[13px]" />
        {variant === 'row' && (
          <span className="hidden min-w-0 flex-1 lg:block">
            <span className="block truncate text-sm font-semibold">{v.title}</span>
            <span className="block truncate text-[12px] text-muted">{v.org ?? v.subtitle ?? v.signIn ?? ''}</span>
          </span>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panel}
            id={panelId}
            // Not a menu: it holds text and a theme choice as well as the links.
            role="dialog"
            aria-label="Account"
            tabIndex={-1}
            data-focus-container
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14 }}
            className={cn(
              'absolute z-40 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-surface p-1.5 shadow-lift outline-hidden',
              variant === 'row' ? 'bottom-full left-0 mb-2 origin-bottom-left' : 'right-0 mt-2 origin-top-right',
            )}
          >
            <div className="flex items-start gap-3 px-2.5 pt-1.5 pb-2.5" data-account-who="">
              <Avatar src={v.avatar} initials={v.initials} className="size-10 text-[14px]" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <p className="min-w-0 truncate text-sm font-bold">{v.title}</p>
                  {v.serverCode ? <InfoTip label="About the server code">{SERVER_CODE_NOTE}</InfoTip> : <RoleChip role={v.role} />}
                </div>
                {v.subtitle && <p className="truncate text-[13px] text-muted">{v.subtitle}</p>}
                {v.org && <p className="truncate text-[12px] font-semibold text-ink-soft">{v.org}</p>}
              </div>
            </div>
            <div className="my-1 h-px bg-line" />
            <Link
              to={PROFILE_PATH}
              onClick={() => setOpen(false)}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm font-medium text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <UserRound className="size-4" /> Profile
            </Link>
            {onContext && (
              <button
                type="button"
                data-context-switcher="menu"
                aria-label={`Context: ${currentOrg?.name ?? 'Personal'}`}
                onClick={() => (setOpen(false), onContext())}
                className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm font-medium text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <ChevronsUpDown className="size-4" />
                <span className="min-w-0 flex-1 truncate">{currentOrg?.name ?? 'Personal'}</span>
              </button>
            )}
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
              onClick={() => (setOpen(false), onLogout())}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm font-medium text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <LogOut className="size-4" /> Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
