import { Badge, Button, ConfirmDialog, Dialog, useToast } from '@isnanme/ui';
import { PASSWORD, type PortalUser } from '@portal/contracts';
import { KeyRound, Plus, Trash2, UserRound } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { api, errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';

const field = 'h-12 w-full rounded-2xl border border-line bg-surface px-4 text-[15px] outline-hidden focus-visible:ring-2 focus-visible:ring-accent';

/**
 * Sign-in accounts (T-118 MU1-min, owner 2026-10-17: "multi user feature login by email"): an email and a password that sign in to this
 * portal beside the server code. Every account acts as the owner for now; per-person permissions come later. Rows are 44 px targets.
 */
export function AccountsSection() {
  const toast = useToast();
  const [users, setUsers] = useState<PortalUser[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<PortalUser | null>(null);
  const [removing, setRemoving] = useState<PortalUser | null>(null);
  const [form, setForm] = useState<{ email: string; displayName: string; password: string; role: 'admin' | 'member' }>({ email: '', displayName: '', password: '', role: 'member' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await api.users());
    } catch (e) {
      toast(errorText(e, 'Couldn’t load the accounts.'), 'error');
    }
  }, [toast]);
  useEffect(() => void load(), [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      if (resetting) await api.updateUser(resetting.id, { password: form.password });
      else await api.createUser({ email: form.email.trim(), displayName: form.displayName.trim() || undefined, password: form.password, role: form.role });
      toast(resetting ? 'Password changed' : 'Account added');
      setAdding(false);
      setResetting(null);
      setForm({ email: '', displayName: '', password: '', role: 'member' });
      await load();
    } catch (err) {
      setProblem(errorText(err, 'Couldn’t save it.'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (u: PortalUser) => {
    try {
      await api.updateUser(u.id, { state: u.state === 'active' ? 'disabled' : 'active' });
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t change it.'), 'error');
    }
  };

  const setRole = async (u: PortalUser) => {
    try {
      await api.updateUser(u.id, { role: u.role === 'admin' ? 'member' : 'admin' });
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t change it.'), 'error');
    }
  };

  const remove = async () => {
    const u = removing;
    setRemoving(null);
    if (!u) return;
    try {
      await api.removeUser(u.id);
      toast('Account removed');
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t remove it.'), 'error');
    }
  };

  const dialogOpen = adding || !!resetting;
  return (
    <section aria-labelledby="settings-accounts" data-settings-accounts="">
      <div className="mb-2 flex items-center gap-1 px-1">
        <h2 id="settings-accounts" className="flex flex-1 items-center gap-1 text-[13px] font-semibold text-muted">
          Accounts
          <InfoTip label="About accounts">Sign in with an email and a password; the server code keeps working. Admin: full access. Member: nothing until a workspace is shared with them.</InfoTip>
        </h2>
        <Button variant="ghost" size="icon" aria-label="Add an account" onClick={() => (setAdding(true), setProblem(null))}>
          <Plus className="size-[18px]" />
        </Button>
      </div>
      <Card>
        {users === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : users.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">No accounts. Sign-in uses the server code.</p>
        ) : (
          <ul className="divide-y divide-line">
            {users.map((u) => (
              <li key={u.id} className="flex min-h-14 items-center gap-2 px-4 py-2 sm:px-5">
                <UserRound className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold [overflow-wrap:anywhere]">{u.displayName}</span>
                  <span className="block text-[12.5px] text-muted [overflow-wrap:anywhere]">
                    {u.email}
                    {u.lastLoginAt ? ` · signed in ${timeAgo(u.lastLoginAt)}` : ' · never signed in'}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void setRole(u)}
                  className="press min-h-11 shrink-0 rounded-full px-2"
                  aria-label={u.role === 'admin' ? `Make ${u.email} a member` : `Make ${u.email} an admin`}
                >
                  <Badge tone={u.role === 'admin' ? 'warning' : 'neutral'}>{u.role === 'admin' ? 'Admin' : 'Member'}</Badge>
                </button>
                <button type="button" onClick={() => void toggle(u)} className="press min-h-11 shrink-0 rounded-full px-2" aria-label={u.state === 'active' ? `Disable ${u.email}` : `Enable ${u.email}`}>
                  <Badge tone={u.state === 'active' ? 'success' : 'neutral'}>{u.state === 'active' ? 'Active' : 'Off'}</Badge>
                </button>
                <Button variant="ghost" size="icon" aria-label={`Change the password of ${u.email}`} onClick={() => (setResetting(u), setProblem(null))}>
                  <KeyRound className="size-[18px]" />
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Remove ${u.email}`} onClick={() => setRemoving(u)}>
                  <Trash2 className="size-[18px]" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Dialog open={dialogOpen} onClose={() => (setAdding(false), setResetting(null))} title={resetting ? 'New password' : 'Add account'} size="sm">
        <form onSubmit={save} className="flex flex-col gap-3" noValidate>
          {!resetting && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold text-ink-soft">Email</span>
                <input type="email" autoComplete="off" inputMode="email" required value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className={field} />
              </label>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 flex items-center gap-1 text-sm font-semibold text-ink-soft">
                  Role
                  <InfoTip label="About roles">Member: no access until a workspace is shared with them. Admin: everything, like the server code.</InfoTip>
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {(['member', 'admin'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={form.role === r}
                      onClick={() => setForm((f) => ({ ...f, role: r }))}
                      className={`press min-h-11 rounded-2xl border px-3 text-sm font-semibold ${form.role === r ? 'border-accent bg-accent-soft text-ink' : 'border-line text-ink-soft'}`}
                    >
                      {r === 'member' ? 'Member' : 'Admin'}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold text-ink-soft">Name</span>
                <input type="text" autoComplete="off" value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} className={field} />
              </label>
            </>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
              Password
              <InfoTip label="Password rules">At least {PASSWORD.min} characters; not a common password and not the email.</InfoTip>
            </span>
            <input type="password" autoComplete="new-password" required minLength={PASSWORD.min} value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} className={field} />
          </label>
          {problem && (
            <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
              {problem}
            </p>
          )}
          <Button type="submit" size="lg" loading={busy} className="mt-1 w-full">
            {resetting ? 'Change password' : 'Add account'}
          </Button>
        </form>
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        title="Remove account?"
        description={removing ? `${removing.email} can no longer sign in.` : ''}
        confirmLabel="Remove"
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </section>
  );
}
