import { ADMIN_API, type AdminMe, type AdminSignInMethods } from '@portal/contracts';
import { Boxes, Building2, KeyRound, LogIn, LogOut, ScrollText, SlidersHorizontal, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AdminApiError, api } from './api';
import { AuditView } from './AuditView';
import { TABS, oidcOutcome, oidcStartHref, tabFromHash, type Tab } from './model';
import { OrgsView } from './OrgsView';
import { SettingsView } from './SettingsView';
import { SignInView } from './SignInView';
import { btnPlain, btnPrimary, field, Sheet, type Run } from './ui';
import { UsersView } from './UsersView';
import { WorkspacesView } from './WorkspacesView';

/*
 * The Admin console (docs/prd/organizations.md §6.11): the one place where the instance is controlled (owner, 2026-11-01). Users, Orgs,
 * Workspaces, Sign-in, Settings, Audit. Phone first (390 px: an icon-only bottom bar), 44 px targets, light and dark from the system, titles of
 * one word, explanations behind an ⓘ. Writes ask for the password again when the server says REAUTH_REQUIRED, then run once more. With the
 * console's OIDC provider configured (git.isnan.me), Sign in leads with its button and the step-up dialog offers it too; both are full
 * navigations that come back to the console (`?oidc=refused` on a refusal).
 */

const ICONS: Record<Tab, typeof Users> = { users: Users, orgs: Building2, workspaces: Boxes, signin: KeyRound, settings: SlidersHorizontal, audit: ScrollText };
const LABELS: Record<Tab, string> = { users: 'Users', orgs: 'Orgs', workspaces: 'Workspaces', signin: 'Sign-in', settings: 'Settings', audit: 'Audit' };

export function Console() {
  const [me, setMe] = useState<AdminMe | null | 'loading'>('loading');
  const [tab, setTab] = useState<Tab>(() => tabFromHash(window.location.hash));
  const [stepUp, setStepUp] = useState<{ retry: () => void; cancel: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [methods, setMethods] = useState<AdminSignInMethods | null>(null);
  // Read once: what an OIDC sign-in or step-up came back with; the query is dropped from the address so a reload does not repeat it.
  const [outcome] = useState(() => oidcOutcome(window.location.search));

  useEffect(() => {
    if (outcome) window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    api.me().then(setMe, () => setMe(null));
    api.methods().then(setMethods, () => setMethods(null));
    const onHash = () => setTab(tabFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [outcome]);

  useEffect(() => {
    if (me && me !== 'loading' && outcome) setError(outcome === 'refused' ? 'Re-auth refused.' : 'Sign-in provider unavailable.');
  }, [me, outcome]);

  /** Runs an action; a step-up refusal asks for the password and runs it again; an ended session goes back to sign-in. */
  const run: Run = useCallback(async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    try {
      return await action();
    } catch (e) {
      if (e instanceof AdminApiError && e.code === 'REAUTH_REQUIRED')
        return new Promise<T | undefined>((resolve) =>
          setStepUp({
            retry: () => {
              setStepUp(null);
              void attempt(action).then(resolve);
            },
            cancel: () => {
              setStepUp(null);
              resolve(undefined);
            },
          }),
        );
      if (e instanceof AdminApiError && e.status === 401) setMe(null);
      else setError(e instanceof Error ? e.message : 'Something went wrong.');
      return undefined;
    }
  }, []);

  if (me === 'loading') return <div className="p-4 text-muted" aria-busy="true" />;
  if (!me) return <SignIn onIn={setMe} oidc={methods?.oidc ?? null} outcome={outcome} />;

  const go = (t: Tab) => {
    window.location.hash = t;
    setTab(t);
  };

  return (
    <div className="flex min-h-dvh flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-0">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/95 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4">
          <h1 className="min-w-0 flex-1 truncate py-3 text-base font-semibold">Admin</h1>
          <nav className="hidden gap-1 lg:flex" aria-label="Sections">
            {TABS.map((t) => (
              <TabButton key={t} tab={t} active={tab === t} onClick={() => go(t)} wide />
            ))}
          </nav>
          <span className="hidden max-w-48 truncate text-xs text-muted xl:inline" title={me.email}>
            {me.email}
          </span>
          <button type="button" className={btnPlain} aria-label="Sign out" title="Sign out" onClick={() => void api.signOut().finally(() => setMe(null))}>
            <LogOut size={18} aria-hidden />
          </button>
        </div>
      </header>
      {error && (
        <div role="alert" className="mx-auto mt-3 w-full max-w-5xl px-4">
          <p className="break-any rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
        </div>
      )}
      <main className="mx-auto w-full max-w-5xl min-w-0 flex-1 px-4 py-4">
        {tab === 'users' && <UsersView run={run} meId={me.userId} />}
        {tab === 'orgs' && <OrgsView run={run} meId={me.userId} />}
        {tab === 'workspaces' && <WorkspacesView run={run} />}
        {tab === 'signin' && <SignInView run={run} />}
        {tab === 'settings' && <SettingsView run={run} />}
        {tab === 'audit' && <AuditView run={run} />}
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label="Sections">
        {TABS.map((t) => (
          <TabButton key={t} tab={t} active={tab === t} onClick={() => go(t)} />
        ))}
      </nav>
      {stepUp && <StepUp onDone={stepUp.retry} onCancel={stepUp.cancel} oidc={methods?.oidc ?? null} tab={tab} />}
    </div>
  );
}

function TabButton({ tab, active, onClick, wide }: { tab: Tab; active: boolean; onClick: () => void; wide?: boolean }) {
  const Icon = ICONS[tab];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={LABELS[tab]}
      title={LABELS[tab]}
      aria-current={active ? 'page' : undefined}
      className={`${wide ? 'min-h-11 rounded-lg px-3' : 'min-h-14 min-w-11 flex-1'} inline-flex items-center justify-center gap-2 text-sm ${active ? 'text-ink font-semibold' : 'text-muted'}`}
    >
      <Icon size={20} aria-hidden />
      {wide && <span>{LABELS[tab]}</span>}
    </button>
  );
}

function SignIn({ onIn, oidc, outcome }: { onIn: (me: AdminMe) => void; oidc: AdminSignInMethods['oidc']; outcome: 'refused' | 'unavailable' | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(outcome === 'refused' ? 'Sign-in refused.' : outcome === 'unavailable' ? 'Sign-in provider unavailable.' : null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onIn(await api.signIn(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-4 px-4">
      <h1 className="text-xl font-semibold">Admin</h1>
      {oidc && (
        <>
          <a className={`${btnPrimary} break-any text-center`} href={oidcStartHref(ADMIN_API.oidcStart)}>
            <LogIn size={18} aria-hidden />
            Sign in with {oidc.name}
          </a>
          <p className="text-center text-xs text-muted" aria-hidden>
            or
          </p>
        </>
      )}
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input className={field} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input className={field} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="break-any text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" className={oidc ? btnPlain : btnPrimary} disabled={busy}>
          Sign in
        </button>
      </form>
    </main>
  );
}

function StepUp({ onDone, onCancel, oidc, tab }: { onDone: () => void; onCancel: () => void; oidc: AdminSignInMethods['oidc']; tab: Tab }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.stepUp(password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Confirm" onClose={onCancel}>
      {oidc && (
        // Leaves the page: the provider sends the browser back here, fresh for 5 minutes; the action is then done once more by hand.
        <a className={`${btnPrimary} break-any text-center`} href={oidcStartHref(ADMIN_API.oidcStart, { stepUp: true, next: tab })}>
          <LogIn size={18} aria-hidden />
          Re-auth with {oidc.name}
        </a>
      )}
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input className={field} type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" className={oidc ? btnPlain : btnPrimary} disabled={busy}>
          Confirm
        </button>
      </form>
    </Sheet>
  );
}
