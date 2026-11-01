import { ADMIN_API, ADMIN_STEP_UP_CHANNEL, type AdminMe, type AdminSignInMethods, type AdminStepUpMessage } from '@portal/contracts';
import { Boxes, Building2, KeyRound, Loader2, LogIn, LogOut, ScrollText, SlidersHorizontal, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
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
 * one word, explanations behind an ⓘ. Writes that the server answers REAUTH_REQUIRED ask once (StepUp: the password inline, or the console's
 * OIDC provider, git.isnan.me, in a popup window) and run by themselves when it is given. Sign in with the provider is a full navigation that
 * comes back to the console (`?oidc=refused` on a refusal).
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
    <div data-console-frame="" className="flex min-h-dvh flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] lg:h-dvh lg:min-h-0 lg:overflow-hidden lg:pb-0 lg:pl-60">
      {/* Desktop (owner, 2026-11-01: "make it as sidebar"): the sections in a side bar, the account at its foot. */}
      <aside className="fixed inset-y-0 left-0 z-10 hidden w-60 flex-col border-r border-line bg-bg lg:flex">
        <h1 className="truncate px-5 py-4 text-base font-semibold">Admin</h1>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-3" aria-label="Sections">
          {TABS.map((t) => (
            <TabButton key={t} tab={t} active={tab === t} onClick={() => go(t)} wide />
          ))}
        </nav>
        <div className="flex items-center gap-2 border-t border-line px-3 py-3">
          <span className="min-w-0 flex-1 truncate px-2 text-xs text-muted" title={me.email}>
            {me.email}
          </span>
          <button type="button" className={btnPlain} aria-label="Sign out" title="Sign out" onClick={() => void api.signOut().finally(() => setMe(null))}>
            <LogOut size={18} aria-hidden />
          </button>
        </div>
      </aside>
      {/* Phone: a slim top bar (title, sign out); the sections stay in the bottom bar. */}
      <header className="sticky top-0 z-10 border-b border-line bg-bg/95 pt-[env(safe-area-inset-top)] backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4">
          <h1 className="min-w-0 flex-1 truncate py-3 text-base font-semibold">Admin</h1>
          <button type="button" className={btnPlain} aria-label="Sign out" title="Sign out" onClick={() => void api.signOut().finally(() => setMe(null))}>
            <LogOut size={18} aria-hidden />
          </button>
        </div>
      </header>
      {/* The content pane (docs/coord/UI-STANDARD.md §1): on a desktop the only thing that scrolls, full width; on a phone the page scrolls. */}
      <div id="console-pane" className="flex min-w-0 flex-1 flex-col lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
      {error && (
        <div role="alert" className="mx-auto mt-3 w-full max-w-5xl px-4 lg:max-w-none lg:px-8">
          <p className="break-any rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
        </div>
      )}
      <main className="mx-auto w-full max-w-5xl min-w-0 flex-1 px-4 py-4 lg:max-w-none lg:px-8 lg:py-6">
        {tab === 'users' && <UsersView run={run} meId={me.userId} />}
        {tab === 'orgs' && <OrgsView run={run} meId={me.userId} />}
        {tab === 'workspaces' && <WorkspacesView run={run} />}
        {tab === 'signin' && <SignInView run={run} />}
        {tab === 'settings' && <SettingsView run={run} />}
        {tab === 'audit' && <AuditView run={run} />}
      </main>
      </div>
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
      className={`${wide ? `min-h-11 w-full justify-start rounded-lg px-3 ${active ? 'bg-surface' : 'hover:bg-surface'}` : 'min-h-14 min-w-11 flex-1 justify-center'} inline-flex items-center gap-3 text-sm ${active ? 'text-ink font-semibold' : 'text-muted'}`}
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

/** A message from the step-up popup (main.tsx), whatever carried it. */
const isStepUpMessage = (d: unknown): d is AdminStepUpMessage =>
  !!d && typeof d === 'object' && (d as AdminStepUpMessage).type === 'admin-step-up' && ['stepped', 'refused', 'unavailable'].includes((d as AdminStepUpMessage).outcome);

/**
 * The calm step-up (owner, 2026-11-01): an action that needs a fresh sign-in asks once, here, and RUNS BY ITSELF when it is given, never "do it
 * again". The password inline; with the console's provider (git.isnan.me) a re-auth in a POPUP window, so the page and the pending action stay:
 * the popup comes back to the console with `?oidc=stepped&popup=1`, tells this page (window.opener, else a BroadcastChannel: the provider's
 * pages can cut the opener) and closes. As a last resort the page asks the server every few seconds whether the session is fresh. A blocked
 * popup falls back to the full navigation of before (the action then has to be done again).
 */
function StepUp({ onDone, onCancel, oidc, tab }: { onDone: () => void; onCancel: () => void; oidc: AdminSignInMethods['oidc']; tab: Tab }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  // Once: the popup's message can come twice (opener and channel), and a poll can see the fresh session too.
  const finished = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    done.current();
  }, []);

  useEffect(() => {
    const hear = (d: unknown) => {
      if (!isStepUpMessage(d)) return;
      setWaiting(false);
      if (d.outcome === 'stepped') finish();
      else setError(d.outcome === 'refused' ? 'Re-auth refused.' : 'Sign-in provider unavailable.');
    };
    const onMessage = (e: MessageEvent) => e.origin === window.location.origin && hear(e.data);
    window.addEventListener('message', onMessage);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(ADMIN_STEP_UP_CHANNEL);
      channel.onmessage = (e) => hear(e.data);
    } catch {
      // no BroadcastChannel: the opener message or the poll below
    }
    return () => {
      window.removeEventListener('message', onMessage);
      channel?.close();
    };
  }, [finish]);

  // While the popup is out: is the session fresh yet? (The popup's message may never come: closed by hand, a browser without the channel.)
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(
      () =>
        void api.me().then(
          (me) => me.freshUntil && Date.parse(me.freshUntil) > Date.now() && finish(),
          () => undefined,
        ),
      2500,
    );
    return () => window.clearInterval(t);
  }, [waiting, finish]);

  const popup = (e: MouseEvent<HTMLAnchorElement>) => {
    const w = window.open(oidcStartHref(ADMIN_API.oidcStart, { stepUp: true, popup: true, next: tab }), 'pilot-admin-reauth', 'popup,width=520,height=720');
    // Blocked: the link's own navigation (the page leaves and comes back) is the fallback.
    if (!w) return;
    e.preventDefault();
    setError(null);
    setWaiting(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.stepUp(password);
      finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Confirm it’s you" onClose={onCancel}>
      <p className="text-sm text-muted">The action goes on by itself once you confirm.</p>
      {oidc && (
        <a
          data-step-up-oidc=""
          className={`${btnPrimary} break-any text-center`}
          href={oidcStartHref(ADMIN_API.oidcStart, { stepUp: true, next: tab })}
          onClick={popup}
          aria-busy={waiting || undefined}
        >
          {waiting ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <LogIn size={18} aria-hidden />}
          {waiting ? `Waiting for ${oidc.name}` : `Re-auth with ${oidc.name}`}
        </a>
      )}
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input className={field} type="password" autoComplete="current-password" required autoFocus={!oidc} value={password} onChange={(e) => setPassword(e.target.value)} />
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
