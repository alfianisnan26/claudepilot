import { ADMIN_TOKEN_DAYS, type AdminMintedToken, type AdminOrgDetail, type AdminUserDetail, type AdminUserRow, type AdminWorkspaceChoice } from '@portal/contracts';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { addableAccounts, MEMBER_ROLES, memberRequest, mintRequest, tokenScopes, type MemberForm, type TokenForm, type TokenScope } from './model';
import { btnPlain, btnPrimary, field, Field, InfoTip, Sheet, type Run } from './ui';

/*
 * Owner need 2026-11-01 (an AI agent's account with Portal MCP access limited to one org): Orgs → Members → Add, and Users → Tokens → New.
 * Both are step-up writes with a platform audit row; the server checks every rule the form checks. `accounts` and `workspaces` may be given
 * (tests, the QA page); otherwise each sheet loads its own list.
 */

export function AddMemberSheet({
  org,
  run,
  accounts,
  onDone,
  onClose,
}: {
  org: AdminOrgDetail;
  run: Run;
  accounts?: AdminUserRow[];
  onDone: (o: AdminOrgDetail) => void;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<AdminUserRow[] | null>(accounts ?? null);
  useEffect(() => {
    if (!accounts) void run(api.users).then((v) => v && setLoaded(v));
  }, [run, accounts]);
  const [f, setF] = useState<MemberForm>({ mode: 'existing', userId: '', email: '', name: '', role: 'member' });
  const choices = addableAccounts(loaded ?? [], org.memberList);
  const checked = memberRequest(f);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!('req' in checked)) return;
    const r = await run(() => api.addMember(org.id, checked.req));
    if (r) onDone(r);
  };
  return (
    <Sheet title="Add member" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <div role="radiogroup" aria-label="Account" className="grid grid-cols-2 gap-2">
          {(['existing', 'new'] as const).map((m) => (
            <label key={m} className={`${btnPlain} cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary ${f.mode === m ? 'bg-surface-2 font-semibold ring-2 ring-primary' : ''}`}>
              <input type="radio" className="sr-only" name="member-mode" value={m} checked={f.mode === m} onChange={() => setF({ ...f, mode: m })} />
              {m === 'existing' ? 'Existing' : 'New account'}
            </label>
          ))}
        </div>
        {f.mode === 'existing' ? (
          <Field label="Account">
            <select className={field} required value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>
              <option value="">{loaded === null ? 'Loading' : choices.length ? 'Pick an account' : 'No account to add'}</option>
              {choices.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field label="Email">
              <input className={field} type="email" required autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </Field>
            <Field label="Name">
              <input className={field} maxLength={60} autoComplete="off" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <p className="flex items-center gap-1 text-xs text-muted">
              No password
              <InfoTip label="About the new account">A portal member with no password: they sign in with SSO, or act only through a token you give them.</InfoTip>
            </p>
          </>
        )}
        <Field label="Role">
          <select className={field} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as MemberForm['role'] })}>
            {MEMBER_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" className={btnPrimary} disabled={!('req' in checked)}>
          Add
        </button>
      </form>
    </Sheet>
  );
}

export function NewTokenSheet({
  user,
  run,
  workspaces,
  onDone,
  onClose,
}: {
  user: AdminUserDetail;
  run: Run;
  workspaces?: AdminWorkspaceChoice[];
  onDone: (t: AdminMintedToken) => void;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<AdminWorkspaceChoice[] | null>(workspaces ?? null);
  useEffect(() => {
    if (!workspaces) void run(() => api.userWorkspaces(user.id)).then((v) => setChoices(v ?? []));
  }, [run, workspaces, user.id]);
  const scopes = tokenScopes(user.role);
  const [f, setF] = useState<TokenForm>({ label: '', scope: 'operate', days: 90, workspace: '' });
  const checked = mintRequest(f, user.role);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!('req' in checked)) return;
    const r = await run(() => api.mintToken(user.id, checked.req));
    if (r) onDone(r);
  };
  return (
    <Sheet title="New token" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <p className="break-any flex items-center gap-1 text-sm">
          Acts as {user.email}
          <InfoTip label="About this token">It has this account’s rights and no more: an org member reaches only what the org shares with its members.</InfoTip>
        </p>
        <Field label="Label">
          <input className={field} required maxLength={60} autoComplete="off" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        </Field>
        <Field label="Scope">
          <select className={field} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as TokenScope, workspace: e.target.value === 'read' ? '' : f.workspace })}>
            {scopes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Lifetime">
          <select className={field} value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })}>
            {ADMIN_TOKEN_DAYS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </Field>
        <Field label="Default workspace">
          <select className={field} value={f.workspace} disabled={f.scope === 'read'} onChange={(e) => setF({ ...f, workspace: e.target.value })}>
            <option value="">{choices === null ? 'Loading' : 'None'}</option>
            {choices?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </Field>
        {'error' in checked && f.label.trim() !== '' && <p className="text-sm text-danger">{checked.error}</p>}
        <button type="submit" className={btnPrimary} disabled={!('req' in checked)}>
          Create
        </button>
      </form>
    </Sheet>
  );
}

/** The new token, shown once: the secret, and the `/mcp` URL when the portal knows it. */
export function TokenSecretSheet({ minted, onClose }: { minted: AdminMintedToken; onClose: () => void }) {
  const [copied, setCopied] = useState<'secret' | 'url' | null>(null);
  const copy = (what: 'secret' | 'url', value: string) =>
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(what),
      () => setCopied(null),
    );
  const row = (what: 'secret' | 'url', label: string, value: string) => (
    <Field label={label}>
      <span className="flex gap-2">
        <input className={`${field} font-mono`} readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} />
        <button type="button" className={btnPlain} aria-label={`Copy ${label.toLowerCase()}`} onClick={() => copy(what, value)}>
          {copied === what ? <Check size={18} aria-hidden /> : <Copy size={18} aria-hidden />}
        </button>
      </span>
    </Field>
  );
  return (
    <Sheet title={minted.token.label} onClose={onClose}>
      <p className="text-sm text-muted">
        {minted.token.scope ?? 'token'} · until {new Date(minted.token.expiresAt).toLocaleDateString()} · shown once
      </p>
      {row('secret', 'Token', minted.secret)}
      {minted.mcpUrl && row('url', 'MCP URL', minted.mcpUrl)}
      <button type="button" className={btnPrimary} onClick={onClose}>
        Done
      </button>
    </Sheet>
  );
}
