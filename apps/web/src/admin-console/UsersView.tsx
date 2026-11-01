import type { AdminUserDetail, AdminUserRow } from '@portal/contracts';
import { UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { TabBar } from '../components/TabBar';
import { ago, USER_FILTER_LABEL, USER_FILTERS, userShows, type UserFilter } from './model';
import { btnDanger, btnPlain, btnPrimary, chip, Confirm, Empty, field, Field, InfoTip, list, Secret, Section, Sheet, useList, type Run } from './ui';

/*
 * Users: every account, new account (the server makes a one-time password, shown once), and per account its role, state, abilities, sessions
 * and tokens, with Suspend/Resume, End sessions, Reset password, Remove. Every write is a step-up action and writes a platform audit row.
 */

export function UsersView({ run, meId }: { run: Run; meId: string }) {
  const { items, reload } = useList(run, api.users);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [show, setShow] = useState<UserFilter>('all');
  const shown = items?.filter((u) => userShows(u, show)) ?? null;
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  return (
    <Section
      title="Users"
      onReload={reload}
      tip="Accounts that sign in to the portal. Admins run the instance; they hold no right on other people’s things."
      actions={
        <button type="button" className={btnPrimary} aria-label="New user" title="New user" onClick={() => setAdding(true)}>
          <UserPlus size={18} aria-hidden />
          <span className="hidden sm:inline">New</span>
        </button>
      }
    >
      {/* Pill tabs (docs/coord/UI-STANDARD.md §2), the same bar as the portal's: All, Admins, Members, Disabled with their counts. */}
      <TabBar
        label="Users"
        tabs={USER_FILTERS.map((f) => ({ id: f, label: USER_FILTER_LABEL[f], badge: f === 'all' || !items ? undefined : items.filter((u) => userShows(u, f)).length || undefined, badgeTone: 'info' as const }))}
        active={show}
        onSelect={(id) => setShow(id as UserFilter)}
        className="sticky top-[calc(env(safe-area-inset-top)+3rem)] z-[5] -mx-4 lg:top-0 lg:-mx-8"
        innerClassName="px-3 lg:px-7"
      />
      <Empty items={shown} />
      <ul className={list}>
        {shown?.map((u) => (
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
          onSecret={setSecret}
          onClose={() => {
            setOpen(null);
            reload();
          }}
        />
      )}
      {adding && (
        <NewUser
          run={run}
          onDone={(email, password) => {
            setAdding(false);
            reload();
            setSecret({ title: email, value: password });
          }}
          onClose={() => setAdding(false)}
        />
      )}
      {secret && <Secret title={secret.title} value={secret.value} onClose={() => setSecret(null)} />}
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

function NewUser({ run, onDone, onClose }: { run: Run; onDone: (email: string, password: string) => void; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.createUser({ email, displayName: name.trim() || undefined, role }));
    if (r) onDone(r.user.email, r.password);
  };
  return (
    <Sheet title="New user" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="Email">
          <input className={field} type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Name">
          <input className={field} maxLength={60} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role">
          <select className={field} value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </Field>
        <p className="flex items-center gap-1 text-xs text-muted">
          One-time password
          <InfoTip label="About the password">The portal makes a password and shows it once. Hand it over; they change it after signing in.</InfoTip>
        </p>
        <button type="submit" className={btnPrimary} disabled={!email}>
          Create
        </button>
      </form>
    </Sheet>
  );
}

type Ask = { kind: 'suspend' | 'remove' | 'reset' | 'sessions' | 'demote' };

function UserSheet({ id, self, run, onSecret, onClose }: { id: string; self: boolean; run: Run; onSecret: (s: { title: string; value: string }) => void; onClose: () => void }) {
  const [u, setU] = useState<AdminUserDetail | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
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
  const done = async (fn: () => Promise<unknown>) => {
    const r = await run(fn);
    if (r !== undefined) load();
    return r !== undefined;
  };
  return (
    <Sheet title={u.email} onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Name</dt>
        <dd className="break-any">{u.displayName}</dd>
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
        <span>Role</span>
        <select
          className={`${field} max-w-40`}
          value={u.role}
          disabled={self}
          title={self ? 'Not your own' : undefined}
          onChange={(e) => (e.target.value === 'member' ? setAsk({ kind: 'demote' }) : act(() => api.updateUser(u.id, { role: 'admin' })))}
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-1">
          Create orgs
          <InfoTip label="About creating orgs">Lets this account create organizations. Admins always can.</InfoTip>
        </span>
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
          <button type="button" className={btnDanger} disabled={self} onClick={() => setAsk({ kind: 'suspend' })}>
            Suspend
          </button>
        ) : (
          <button type="button" className={btnPlain} onClick={() => act(() => api.resume(u.id))}>
            Resume
          </button>
        )}
        <button type="button" className={btnPlain} onClick={() => setAsk({ kind: 'sessions' })}>
          End sessions
        </button>
        <button type="button" className={btnPlain} disabled={self} onClick={() => setAsk({ kind: 'reset' })}>
          Reset password
        </button>
        <button type="button" className={btnDanger} disabled={self} onClick={() => setAsk({ kind: 'remove' })}>
          Remove
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
                  {t.lastUsedAt ? ` · used ${ago(t.lastUsedAt)}` : ''}
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
      {ask?.kind === 'suspend' && (
        <Confirm
          title="Suspend"
          body={`${u.email} is signed out everywhere and their tokens end.`}
          action="Suspend"
          danger
          reason={{ label: 'Reason', min: 0 }}
          onConfirm={(reason) => done(() => api.suspend(u.id, reason || undefined))}
          onClose={() => setAsk(null)}
        />
      )}
      {ask?.kind === 'sessions' && (
        <Confirm title="End sessions" body={`${u.email} is signed out of the portal and this console.`} action="End" onConfirm={() => done(() => api.endSessions(u.id))} onClose={() => setAsk(null)} />
      )}
      {ask?.kind === 'demote' && (
        <Confirm title="Make member" body={`${u.email} loses admin rights; their sessions and tokens end.`} action="Make member" danger onConfirm={() => done(() => api.updateUser(u.id, { role: 'member' }))} onClose={() => setAsk(null)} />
      )}
      {ask?.kind === 'reset' && (
        <Confirm
          title="Reset password"
          body={`A new one-time password for ${u.email}. Their sessions end.`}
          action="Reset"
          onConfirm={async () => {
            const r = await run(() => api.resetPassword(u.id));
            if (r) onSecret({ title: r.user.email, value: r.password });
            return !!r;
          }}
          onClose={() => setAsk(null)}
        />
      )}
      {ask?.kind === 'remove' && (
        <Confirm
          title="Remove"
          body={`${u.email} is removed for good. What they own stays where it is.`}
          action="Remove"
          danger
          onConfirm={async () => {
            const r = await run(() => api.removeUser(u.id));
            if (r) onClose();
            return !!r;
          }}
          onClose={() => setAsk(null)}
        />
      )}
    </Sheet>
  );
}
