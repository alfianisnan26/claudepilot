import type { AdminSignInConfig, AdminSsoProvider, AdminSsoRequest } from '@portal/contracts';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { ago } from './model';
import { btnPlain, btnPrimary, chip, Confirm, Empty, field, Field, InfoTip, list, Secret, Section, Sheet, useList, type Run } from './ui';

/*
 * Sign-in: how people get in. The server code (on or off, a new code shown once; a new code signs everyone out of the portal), the console's
 * own OIDC allow list (read only: it is the deployment's env), and the instance's SSO providers (add, edit, turn off). Writes are step-up.
 */

export function SignInView({ run }: { run: Run }) {
  const [config, setConfig] = useState<AdminSignInConfig | null>(null);
  const loadConfig = useCallback(() => void run(api.signInConfig).then((v) => v && setConfig(v)), [run]);
  useEffect(loadConfig, [loadConfig]);
  const sso = useList(run, api.sso);
  const [ask, setAsk] = useState<'off' | 'rotate' | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [edit, setEdit] = useState<AdminSsoProvider | 'new' | null>(null);
  const sc = config?.serverCode ?? null;
  return (
    <div className="flex flex-col gap-6">
      <Section title="Code" onReload={loadConfig} tip="The server code signs in as the portal’s owner. Turn it off once everyone has an account.">
        {!config ? (
          <p className="text-sm text-muted">Loading</p>
        ) : !sc ? (
          <p className="text-sm text-muted">Unavailable</p>
        ) : (
          <div className={`${list} gap-0`}>
            <label className="flex min-h-14 items-center justify-between gap-3 px-3 text-sm">
              <span>Sign-in with the code</span>
              <input type="checkbox" className="size-6" checked={sc.enabled} onChange={(e) => (e.target.checked ? void run(() => api.setServerCode(true)).then((v) => v && setConfig(v)) : setAsk('off'))} />
            </label>
            <div className="flex min-h-14 items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block">
                  {sc.source} · {sc.sessions} sessions
                </span>
                <span className="block text-xs text-muted">changed {ago(sc.codeUpdatedAt)}</span>
              </span>
              <button type="button" className={btnPlain} onClick={() => setAsk('rotate')}>
                New code
              </button>
            </div>
            {/* Owner request 2026-11-01: the code goes off only while an admin can sign in without it; who can, and how. */}
            {(config.admins ?? []).map((a) => (
              <div key={a.id} className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm" data-admin-signin={a.methods.length ? 'ok' : 'none'}>
                <span className="break-any min-w-0 flex-1">{a.email}</span>
                <span className={`${chip} ${a.methods.length ? 'bg-accent-soft' : 'bg-danger-soft text-danger'}`}>{a.methods.length ? a.methods.join(', ') : 'no sign-in'}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-1 text-lg font-semibold">
          Console
          <InfoTip label="About the console’s sign-in">
            Who may sign in here through {config?.adminOidc?.name ?? 'the OIDC provider'}: set PORTAL_ADMIN_OIDC_ALLOW in the deployment (deploy/k3s/portal.yaml) and roll out. Only
            active admin accounts get in.
          </InfoTip>
        </h2>
        {config && !config.adminOidc && <p className="text-sm text-muted">Password only</p>}
        {config?.adminOidc && (
          <ul className={list}>
            <li className="break-any px-3 py-2 text-xs text-muted">{config.adminOidc.issuer}</li>
            {config.adminOidc.allow.map((a) => (
              <li key={a} className="break-any px-3 py-2 text-sm">
                {a}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Section
        title="SSO"
        onReload={sso.reload}
        tip="OpenID Connect providers by email domain, for the whole portal. An email on a provider’s domain signs in there, never with a password."
        actions={
          <button type="button" className={btnPrimary} aria-label="New provider" title="New provider" onClick={() => setEdit('new')}>
            <Plus size={18} aria-hidden />
            <span className="hidden sm:inline">New</span>
          </button>
        }
      >
        <Empty items={sso.items} />
        <ul className={list}>
          {sso.items?.map((p) => (
            <li key={p.id}>
              <button type="button" className="flex min-h-14 w-full flex-col gap-0.5 px-3 py-2 text-left text-sm" onClick={() => setEdit(p)}>
                <span className="flex w-full items-center gap-2">
                  <span className="break-any min-w-0 flex-1 font-medium">{p.name}</span>
                  <span className={`${chip} ${p.enabled ? 'bg-accent-soft' : 'bg-surface-2'}`}>{p.enabled ? 'on' : 'off'}</span>
                </span>
                <span className="break-any text-xs text-muted">{p.issuer}</span>
                <span className="break-any text-xs text-muted">{p.domains.join(', ') || 'no domains'}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      {ask === 'off' && (
        <Confirm
          title="Turn off"
          body="Nobody signs in with the server code until it is on again. Accounts still sign in."
          action="Turn off"
          danger
          onConfirm={async () => {
            const v = await run(() => api.setServerCode(false));
            if (v) setConfig(v);
            return !!v;
          }}
          onClose={() => setAsk(null)}
        />
      )}
      {ask === 'rotate' && (
        <Confirm
          title="New code"
          body="Everyone is signed out of the portal, accounts too. The new code is shown once."
          action="New code"
          danger
          onConfirm={async () => {
            const v = await run(api.rotateCode);
            if (v) {
              setConfig(v.config);
              setCode(v.code);
            }
            return !!v;
          }}
          onClose={() => setAsk(null)}
        />
      )}
      {code && <Secret title="Server code" value={code} onClose={() => setCode(null)} />}
      {edit && (
        <SsoSheet
          provider={edit === 'new' ? null : edit}
          run={run}
          onClose={() => {
            setEdit(null);
            sso.reload();
          }}
        />
      )}
    </div>
  );
}

function SsoSheet({ provider, run, onClose }: { provider: AdminSsoProvider | null; run: Run; onClose: () => void }) {
  const [name, setName] = useState(provider?.name ?? '');
  const [issuer, setIssuer] = useState(provider?.issuer ?? '');
  const [clientId, setClientId] = useState(provider?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [domains, setDomains] = useState(provider?.domains.join(', ') ?? '');
  const [autoCreate, setAutoCreate] = useState(provider?.autoCreate ?? false);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const req: AdminSsoRequest = {
      name: name.trim(),
      issuer: issuer.trim(),
      clientId: clientId.trim(),
      domains: domains
        .split(/[\s,]+/)
        .map((d) => d.trim())
        .filter(Boolean),
      autoCreate,
      enabled,
      // Write-only: an empty field keeps the stored secret.
      ...(secret ? { clientSecret: secret } : {}),
    };
    const r = await run(() => (provider ? api.updateSso(provider.id, req) : api.createSso(req)));
    if (r) onClose();
  };
  return (
    <Sheet title={provider ? provider.name : 'New provider'} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="Name">
          <input className={field} required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Issuer">
          <input className={field} required type="url" placeholder="https://" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
        </Field>
        <Field label="Client id">
          <input className={field} required autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </Field>
        <Field label={provider?.hasClientSecret ? 'Client secret (kept if empty)' : 'Client secret'}>
          <input className={field} type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
        <Field label="Domains">
          <input className={field} placeholder="example.com" value={domains} onChange={(e) => setDomains(e.target.value)} />
        </Field>
        <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
          <span className="flex items-center gap-1">
            Make accounts
            <InfoTip label="About making accounts">A first sign-in from one of the domains makes a member account. Off: only existing accounts sign in.</InfoTip>
          </span>
          <input type="checkbox" className="size-6" checked={autoCreate} onChange={(e) => setAutoCreate(e.target.checked)} />
        </label>
        <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
          <span>On</span>
          <input type="checkbox" className="size-6" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        </label>
        {provider?.redirectUri && <p className="break-any text-xs text-muted">Redirect: {provider.redirectUri}</p>}
        <button type="submit" className={btnPrimary}>
          Save
        </button>
      </form>
    </Sheet>
  );
}
