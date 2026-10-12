import { cn, Dialog, ease, spring } from '@isnanme/ui';
import { motion } from 'motion/react';
import { Ellipsis } from 'lucide-react';
import { Fragment, Suspense, useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { BAR_ITEMS, HOME, MORE_ITEMS, NAV, NAV_GROUPS, type NavItem } from '@/app/nav';
import { useAuth } from '@/lib/auth';
import { AccountMenu } from './AccountMenu';
import { BRAND_NAME, Logo, LogoMark } from './Logo';

/** A phone tab bar only earns its place with two or more sections. */
const showTabBar = NAV.length > 1;

/**
 * pay's dashboard frame. Phones: an app bar on top (and a tab bar once there are several
 * sections). Tablets: a slim icon rail. Laptops: a full sidebar with labels and the account at
 * the foot.
 */
export function AppShell() {
  const { logout } = useAuth();
  const { pathname } = useLocation();

  return (
    <div className={cn('min-h-dvh pb-10 sm:pb-16 sm:pl-20 lg:pl-64', showTabBar && 'pb-[calc(5rem+env(safe-area-inset-bottom))]')}>
      {/* The first Tab stop: past the sidebar and the account menu, to the page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70] focus:rounded-xl focus:border focus:border-line focus:bg-surface focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-lift"
      >
        Skip to content
      </a>
      <Sidebar pathname={pathname} onLogout={() => void logout()} />

      <header className="sticky top-0 z-40 border-b border-line bg-bg/80 pt-[env(safe-area-inset-top)] backdrop-blur-md sm:hidden">
        <div className="mx-auto flex h-16 max-w-4xl items-center gap-6 px-4">
          <Logo to={HOME} />
          <div className="ml-auto flex items-center gap-1.5">
            <AccountMenu onLogout={() => void logout()} />
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto max-w-4xl px-4 pt-6 outline-none sm:px-6 sm:pt-10">
        {/* Enter-only page transition: navigation never waits for an exit animation. */}
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease }}
        >
          <Suspense fallback={<div className="skeleton h-40 rounded-[24px]" aria-busy="true" />}>
            <Outlet />
          </Suspense>
        </motion.div>
      </main>

      {showTabBar && <TabBar pathname={pathname} />}
    </div>
  );
}

function Sidebar({ pathname, onLogout }: { pathname: string; onLogout: () => void }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-20 flex-col border-r border-line bg-bg sm:flex lg:w-64">
      <div className="flex h-16 shrink-0 items-center justify-center px-3 lg:justify-start lg:px-5">
        <Link to={HOME} aria-label={BRAND_NAME} className="inline-flex items-center gap-2 rounded-lg font-extrabold tracking-tight">
          <LogoMark className="size-8" />
          <span className="hidden text-lg lg:inline">{BRAND_NAME}</span>
        </Link>
      </div>
      <nav aria-label="Main" className="mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-4 [scrollbar-width:thin] lg:px-4">
        <ul className="flex flex-col gap-1">
          {NAV_GROUPS.map((items, g) => (
            <Fragment key={items[0]!.group}>
              {/* A quiet divider between work and admin, no headings. */}
              {g > 0 && <li aria-hidden="true" className="mx-3 my-2 h-px bg-line" />}
              {items.map(({ id, to, label, icon: Icon }) => {
                const active = pathname.startsWith(to);
                return (
                  <li key={id}>
                    <Link
                      to={to}
                      aria-current={active ? 'page' : undefined}
                      aria-label={label}
                      title={label}
                      className={cn(
                        'press relative isolate flex flex-col items-center gap-1 rounded-2xl px-1 py-3 text-[10.5px] font-semibold transition-colors lg:flex-row lg:gap-3 lg:px-3 lg:py-2.5 lg:text-[14.5px]',
                        active ? 'text-ink' : 'text-muted hover:bg-surface-2/60 hover:text-ink',
                      )}
                    >
                      {active && (
                        <motion.span layoutId="side-pill" transition={spring} className="absolute inset-0 -z-10 rounded-2xl bg-surface-2" />
                      )}
                      <Icon className="size-5 shrink-0" strokeWidth={active ? 2.4 : 2} />
                      <span className="hidden max-w-full truncate lg:inline">{label}</span>
                    </Link>
                  </li>
                );
              })}
            </Fragment>
          ))}
        </ul>
      </nav>
      <div className="border-t border-line p-3 lg:p-4">
        <AccountMenu variant="row" onLogout={onLogout} />
      </div>
    </aside>
  );
}

/**
 * The phone bar: icons only (each with its name as aria-label and title), the current one on a pill. It shows the sections
 * flagged `bar` and, when there are others, a More button that opens a sheet listing them with their labels.
 */
function TabBar({ pathname }: { pathname: string }) {
  const [more, setMore] = useState(false);
  // Lets fixed things (the toast) sit just above the bar.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--tabbar-h', 'calc(4rem + 1px)');
    return () => void root.style.removeProperty('--tabbar-h');
  }, []);
  useEffect(() => setMore(false), [pathname]);
  const hasMore = MORE_ITEMS.length > 0;
  const inMore = MORE_ITEMS.some((i) => pathname.startsWith(i.to));
  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden"
      >
        <ul className="grid" style={{ gridTemplateColumns: `repeat(${BAR_ITEMS.length + (hasMore ? 1 : 0)}, minmax(0, 1fr))` }}>
          {BAR_ITEMS.map((item) => (
            <li key={item.id} className="min-w-0">
              <TabLink item={item} active={pathname.startsWith(item.to)} />
            </li>
          ))}
          {hasMore && (
            <li className="min-w-0">
              <button
                type="button"
                aria-label="More"
                title="More"
                aria-haspopup="dialog"
                aria-expanded={more}
                aria-current={inMore ? 'true' : undefined}
                onClick={() => setMore(true)}
                className={cn('press flex h-16 w-full items-center justify-center', inMore || more ? 'text-ink' : 'text-muted')}
              >
                <TabIcon active={inMore || more} icon={Ellipsis} />
              </button>
            </li>
          )}
        </ul>
      </nav>
      {hasMore && (
        <Dialog open={more} onClose={() => setMore(false)} title="More" size="sm">
          <MoreList pathname={pathname} onPick={() => setMore(false)} />
        </Dialog>
      )}
    </>
  );
}

function TabLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      aria-label={item.label}
      title={item.label}
      aria-current={active ? 'page' : undefined}
      className={cn('press flex h-16 items-center justify-center', active ? 'text-ink' : 'text-muted')}
    >
      <TabIcon active={active} icon={item.icon} />
    </Link>
  );
}

/** The icon on its pill; the pill is what marks the current section. */
function TabIcon({ active, icon: Icon }: { active: boolean; icon: NavItem['icon'] }) {
  return (
    <span className="relative flex h-10 w-14 items-center justify-center">
      {active && <motion.span layoutId="tab-pill" transition={spring} className="absolute inset-0 rounded-full bg-surface-2" />}
      <Icon className="relative size-[22px]" strokeWidth={active ? 2.4 : 2} />
    </span>
  );
}

/** The sections the bar has no room for, with their names (there is room here), work first and then admin. */
function MoreList({ pathname, onPick }: { pathname: string; onPick: () => void }) {
  const groups = NAV_GROUPS.map((items) => items.filter((i) => !i.bar)).filter((items) => items.length > 0);
  return (
    <ul className="flex flex-col pb-2">
      {groups.map((items, g) => (
        <Fragment key={items[0]!.group}>
          {g > 0 && <li aria-hidden="true" className="mx-3 my-1.5 h-px bg-line" />}
          {items.map(({ id, to, label, icon: Icon }) => {
            const active = pathname.startsWith(to);
            return (
              <li key={id}>
                <Link
                  to={to}
                  onClick={onPick}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'press flex min-h-12 items-center gap-3.5 rounded-2xl px-3 text-[15px] font-semibold',
                    active ? 'bg-surface-2 text-ink' : 'text-ink-soft hover:bg-surface-2/60',
                  )}
                >
                  <Icon className="size-5 shrink-0" strokeWidth={active ? 2.4 : 2} />
                  {label}
                </Link>
              </li>
            );
          })}
        </Fragment>
      ))}
    </ul>
  );
}
