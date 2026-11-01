import type { AdminAuditEntry, AdminMe, AdminOrg, AdminSsoProvider, AdminUserDetail, AdminUserRow } from '@portal/contracts';
import { Building2, KeyRound, LogOut, RefreshCw, ScrollText, Users, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AdminApiError, api } from './api';
import { TABS, ago, tabFromHash, type Tab } from './model';

/*
 * The Admin console (docs/prd/organizations.md §6.11): Sign in, Users, Organizations, SSO, Audit. Phone first (390 px: icon-only bottom bar),
 * 44 px targets, light and dark from the system, titles of one word. Actions marked step-up ask for the password again when the server says
 * REAUTH_REQUIRED, then run once more.
 */

const btn = 'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium disabled:opacity-50';
const btnPlain = `${btn} border border-line bg-surface hover:bg-surface-2`;
const btnDanger = `${btn} border border-line bg-surface text-danger hover:bg-danger-soft`;
const btnPrimary = `${btn} bg-primary text-primary-ink`;
const field = 'min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink';
const chip = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs';

const ICONS: Record<Tab, typeof Users> = { users: Users, orgs: Building2, sso: KeyRound, audit: ScrollText };
const LABELS: Record<Tab, string> = { users: 'Users', orgs: 'Orgs', sso: 'SSO', audit: 'Audit' };

type Run = <T>(action: () => Promise<T>) => Promise<T | undefined>;

export function Console() {
  const [me, setMe] = useState<AdminMe | null | 'loading'>('loading');
  const [tab, setTab] = useState<Tab>(() => tabFromHash(window.location.hash));
  const [stepUp, setStepUp] = useState<{ retry: () => void; cancel: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
    const onHash = () => setTab(tabFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

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
  if (!me) return <SignIn onIn={setMe} />;

  const go = (t: Tab) => {
    window.location.hash = t;
    setTab(t);
  };

  return (
    <div className="flex min-h-dvh flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] sm:pb-0">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/95 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-4">
          <h1 className="min-w-0 flex-1 truncate py-3 text-base font-semibold">Admin</h1>
          <nav className="hidden gap-1 sm:flex" aria-label="Sections">
            {TABS.map((t) => (
              <TabButton key={t} tab={t} active={tab === t} onClick={() => go(t)} wide />
            ))}
          </nav>
          <span className="hidden max-w-48 truncate text-xs text-muted sm:inline" title={me.email}>
            {me.email}
          </span>
          <button
            type="button"
            className={btnPlain}
            aria-label="Sign out"
            title="Sign out"
            onClick={() => void api.signOut().finally(() => setMe(null))}
          >
            <LogOut size={18} aria-hidden />
          </button>
        </div>
      </header>
      {error && (
        <div role="alert" className="mx-auto mt-3 w-full max-w-4xl px-4">
          <p className="break-any rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
        </div>
      )}
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-4">
        {tab === 'users' && <UsersView run={run} meId={me.userId} />}
        {tab === 'orgs' && <OrgsView run={run} />}
        {tab === 'sso' && <SsoView run={run} />}
        {tab === 'audit' && <AuditView run={run} />}
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
        aria-label="Sections"
      >
        {TABS.map((t) => (
          <TabButton key={t} tab={t} active={tab === t} onClick={() => go(t)} />
        ))}
      </nav>
      {stepUp && <StepUp onDone={stepUp.retry} onCancel={stepUp.cancel} />}
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
      aria-current={active ? 'page' : undefined}
      className={`${wide ? 'min-h-11 rounded-lg px-3' : 'min-h-14 flex-1'} inline-flex items-center justify-center gap-2 text-sm ${active ? 'text-ink font-semibold' : 'text-muted'}`}
    >
      <Icon size={20} aria-hidden />
      {wide && <span>{LABELS[tab]}</span>}
    </button>
  );
}

function SignIn({ onIn }: { onIn: (me: AdminMe) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
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
        <button type="submit" className={btnPrimary} disabled={busy}>
          Sign in
        </button>
      </form>
    </main>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="max-h-[90dvh] w-full overflow-y-auto overscroll-contain rounded-t-2xl bg-bg pb-[env(safe-area-inset-bottom)] outline-hidden sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center gap-2 border-b border-line bg-bg px-4">
          <h2 className="break-any min-w-0 flex-1 py-3 text-base font-semibold">{title}</h2>
          <button type="button" className={btnPlain} aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="flex flex-col gap-4 p-4">{children}</div>
      </div>
    </div>
  );
}

function StepUp({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
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
        <button type="submit" className={btnPrimary} disabled={busy}>
          Confirm
        </button>
      </form>
    </Sheet>
  );
}

function useList<T>(run: Run, load: () => Promise<T[]>) {
  const [items, setItems] = useState<T[] | null>(null);
  const reload = useCallback(() => void run(load).then((v) => v && setItems(v)), [run, load]);
  useEffect(reload, [reload]);
  return { items, reload };
}

function Section({ title, onReload, children }: { title: string; onReload: () => void; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-lg font-semibold">{title}</h2>
        <button type="button" className={btnPlain} aria-label="Reload" title="Reload" onClick={onReload}>
          <RefreshCw size={18} aria-hidden />
        </button>
      </div>
      {children}
    </section>
  );
}

const Empty = ({ items }: { items: unknown[] | null }) =>
  items === null ? <p className="text-sm text-muted">Loading</p> : items.length === 0 ? <p className="text-sm text-muted">None</p> : null;

function UsersView({ run, meId }: { run: Run; meId: string }) {
  const { items, reload } = useList(run, api.users);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section title="Users" onReload={reload}>
      <Empty items={items} />
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
        {items?.map((u) => (
          <li key={u.id}>
            <button type="button" className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left" onClick={() => setOpen(u.id)}>
              <span className="min-w-0 flex-1">
                <span className="break-any block text-sm font-medium">{u.email}</span>
                <span className="block text-xs text-muted">{u.lastLoginAt ? ago(u.lastLoginAt) : 'never'}</span>
              </span>
              <UserChips u={u} />
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <UserSheet
          id={open}
          self={open === meId}
          run={run}
          onClose={() => {
            setOpen(null);
            reload();
          }}
        />
      )}
    </Section>
  );
}

function UserChips({ u }: { u: AdminUserRow }) {
  return (
    <span className="flex shrink-0 flex-wrap justify-end gap-1">
      <span className={`${chip} bg-surface-2`}>{u.role}</span>
      {u.state !== 'active' && <span className={`${chip} bg-danger-soft text-danger`}>{u.state}</span>}
      {u.abilities.includes('orgs.create') && <span className={`${chip} bg-accent-soft`}>orgs</span>}
    </span>
  );
}

function UserSheet({ id, self, run, onClose }: { id: string; self: boolean; run: Run; onClose: () => void }) {
  const [u, setU] = useState<AdminUserDetail | null>(null);
  const load = useCallback(() => void run(() => api.user(id)).then((v) => v && setU(v)), [run, id]);
  useEffect(load, [load]);
  const act = (fn: () => Promise<unknown>) => void run(fn).then(load);
  if (!u)
    return (
      <Sheet title="User" onClose={onClose}>
        <p className="text-sm text-muted">Loading</p>
      </Sheet>
    );
  const canCreate = u.role === 'admin' || u.abilities.includes('orgs.create');
  return (
    <Sheet title={u.email} onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Role</dt>
        <dd>{u.role}</dd>
        <dt className="text-muted">State</dt>
        <dd>{u.state}</dd>
        <dt className="text-muted">Last</dt>
        <dd>{u.lastLoginAt ? ago(u.lastLoginAt) : 'never'}</dd>
        <dt className="text-muted">Sessions</dt>
        <dd>
          {u.sessions.portal} portal, {u.sessions.admin} admin
        </dd>
      </dl>
      <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
        <span>Create orgs</span>
        <input
          type="checkbox"
          className="size-6"
          checked={canCreate}
          disabled={u.role === 'admin'}
          title={u.role === 'admin' ? 'Admins always can' : undefined}
          onChange={(e) => act(() => api.setAbility(u.id, 'orgs.create', e.target.checked))}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        {u.state === 'active' ? (
          <button type="button" className={btnDanger} disabled={self} onClick={() => act(() => api.suspend(u.id))}>
            Suspend
          </button>
        ) : (
          <button type="button" className={btnPlain} onClick={() => act(() => api.resume(u.id))}>
            Resume
          </button>
        )}
        <button type="button" className={btnPlain} onClick={() => act(() => api.endSessions(u.id))}>
          End sessions
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Tokens</h3>
        {u.tokens.length === 0 && <p className="text-sm text-muted">None</p>}
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
          {u.tokens.map((t) => (
            <li key={`${t.kind}:${t.id}`} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 text-sm">
                <span className="break-any block">{t.label}</span>
                <span className="block text-xs text-muted">
                  {t.kind} · {t.revokedAt ? 'revoked' : `until ${new Date(t.expiresAt).toLocaleDateString()}`}
                </span>
              </span>
              {!t.revokedAt && (
                <button type="button" className={btnDanger} onClick={() => act(() => api.revokeToken(u.id, t.id))}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}

function OrgsView({ run }: { run: Run }) {
  const { items, reload } = useList(run, api.orgs);
  const [recover, setRecover] = useState<AdminOrg | null>(null);
  return (
    <Section title="Orgs" onReload={reload}>
      <Empty items={items} />
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
        {items?.map((o) => (
          <li key={o.id} className="flex flex-col gap-2 px-3 py-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="break-any block text-sm font-medium">{o.name}</span>
                <span className="break-any block text-xs text-muted">
                  {o.slug} · {o.members} members
                </span>
              </span>
              {o.state !== 'active' && <span className={`${chip} bg-surface-2`}>{o.state}</span>}
              {o.needsOwner && <span className={`${chip} bg-danger-soft text-danger`}>no owner</span>}
            </div>
            <p className="break-any text-xs text-muted">{o.owners.length ? o.owners.map((w) => `${w.email ?? w.userId}${w.active ? '' : ' (off)'}`).join(', ') : 'No owners'}</p>
            {o.needsOwner && (
              <button type="button" className={`${btnPlain} self-start`} onClick={() => setRecover(o)}>
                Recover owner
              </button>
            )}
          </li>
        ))}
      </ul>
      {recover && (
        <RecoverSheet
          org={recover}
          run={run}
          onClose={() => {
            setRecover(null);
            reload();
          }}
        />
      )}
    </Section>
  );
}

function RecoverSheet({ org, run, onClose }: { org: AdminOrg; run: Run; onClose: () => void }) {
  const { items } = useList(run, api.users);
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const done = await run(() => api.recoverOwner(org.id, userId, reason));
    if (done) onClose();
  };
  return (
    <Sheet title={org.name} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          New owner
          <select className={field} required value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Pick an account</option>
            {items
              ?.filter((u) => u.state === 'active')
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Reason
          <textarea className={`${field} min-h-24 py-2`} required minLength={10} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button type="submit" className={btnPrimary} disabled={!userId || reason.trim().length < 10}>
          Recover
        </button>
      </form>
    </Sheet>
  );
}

function SsoView({ run }: { run: Run }) {
  const { items, reload } = useList<AdminSsoProvider>(run, api.sso);
  return (
    <Section title="SSO" onReload={reload}>
      <Empty items={items} />
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
        {items?.map((p) => (
          <li key={p.id} className="flex flex-col gap-1 px-3 py-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="break-any min-w-0 flex-1 font-medium">{p.name}</span>
              <span className={`${chip} ${p.enabled ? 'bg-accent-soft' : 'bg-surface-2'}`}>{p.enabled ? 'on' : 'off'}</span>
            </div>
            <span className="break-any text-xs text-muted">{p.issuer}</span>
            <span className="break-any text-xs text-muted">{p.domains.join(', ') || 'no domains'}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function AuditView({ run }: { run: Run }) {
  const [kind, setKind] = useState('');
  const [severity, setSeverity] = useState<'' | 'info' | 'medium' | 'high'>('');
  const [rows, setRows] = useState<AdminAuditEntry[] | null>(null);
  const load = useCallback(
    (before?: number) =>
      void run(() => api.audit({ kind: kind.trim() || undefined, severity: severity || undefined, before, limit: 50 })).then(
        (v) => v && setRows((prev) => (before && prev ? [...prev, ...v] : v)),
      ),
    [run, kind, severity],
  );
  useEffect(() => load(), [load]);
  return (
    <Section title="Audit" onReload={() => load()}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className={field} placeholder="Kind" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} />
        <select className={`${field} sm:max-w-40`} aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
          <option value="">Any</option>
          <option value="info">info</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </div>
      <Empty items={rows} />
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
        {rows?.map((r) => (
          <li key={r.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="break-any min-w-0 flex-1 font-medium">{r.kind}</span>
              {r.severity !== 'info' && <span className={`${chip} bg-danger-soft text-danger`}>{r.severity}</span>}
            </div>
            <span className="break-any text-xs text-muted">
              {ago(r.at)} · {r.actor}
              {r.subject ? ` → ${r.subject}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {rows && rows.length > 0 && rows.length % 50 === 0 && (
        <button type="button" className={btnPlain} onClick={() => load(rows.at(-1)!.id)}>
          More
        </button>
      )}
    </Section>
  );
}
