import { Badge, Button, ConfirmDialog, Dialog, useToast } from '@isnanme/ui';
import type { PortalTeam, SsoProvider, SsoProviderRequest } from '@portal/contracts';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { api, errorText } from '@/lib/api';

const field = 'h-12 w-full min-w-0 rounded-2xl border border-line bg-surface px-4 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-accent';

interface Form {
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  domains: string;
  defaultRole: 'admin' | 'member';
  defaultTeamId: string;
  autoCreate: boolean;
  trustUnverifiedEmail: boolean;
  allowPrivateNetwork: boolean;
  enabled: boolean;
  acknowledgeAdminAutoCreate: boolean;
}
const empty: Form = { name: '', issuer: '', clientId: '', clientSecret: '', domains: '', defaultRole: 'member', defaultTeamId: '', autoCreate: true, trustUnverifiedEmail: false, allowPrivateNetwork: false, enabled: true, acknowledgeAdminAutoCreate: false };

/**
 * Single sign-on (owner, 2026-10-17): OpenID Connect providers (Google Workspace, Microsoft Entra, Okta, Keycloak, ...). An email on a
 * provider's domains signs in there and never with a password; others keep their password. The server code always works.
 */
export function SsoSection() {
  const toast = useToast();
  const [list, setList] = useState<SsoProvider[] | null>(null);
  const [teams, setTeams] = useState<PortalTeam[]>([]);
  const [editing, setEditing] = useState<SsoProvider | 'new' | null>(null);
  const [form, setForm] = useState<Form>(empty);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SsoProvider | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([api.ssoProviders(), api.teams()]);
      setList(p);
      setTeams(t);
    } catch (e) {
      toast(errorText(e, 'Couldn’t load SSO.'), 'error');
    }
  }, [toast]);
  useEffect(() => void load(), [load]);

  const open = (p: SsoProvider | 'new') => {
    setProblem(null);
    setEditing(p);
    setForm(
      p === 'new'
        ? empty
        : {
            name: p.name,
            issuer: p.issuer,
            clientId: p.clientId,
            clientSecret: '',
            domains: p.domains.join(', '),
            defaultRole: p.defaultRole,
            defaultTeamId: p.defaultTeamId ?? '',
            autoCreate: p.autoCreate,
            trustUnverifiedEmail: p.trustUnverifiedEmail,
            allowPrivateNetwork: p.allowPrivateNetwork,
            enabled: p.enabled,
            acknowledgeAdminAutoCreate: false,
          },
    );
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    const req: SsoProviderRequest = {
      name: form.name.trim(),
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      domains: form.domains.split(/[\s,]+/).filter(Boolean),
      defaultRole: form.defaultRole,
      defaultTeamId: form.defaultTeamId || null,
      autoCreate: form.autoCreate,
      trustUnverifiedEmail: form.trustUnverifiedEmail,
      allowPrivateNetwork: form.allowPrivateNetwork,
      enabled: form.enabled,
      acknowledgeAdminAutoCreate: form.acknowledgeAdminAutoCreate,
      ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
    };
    try {
      if (editing === 'new') await api.createSso(req);
      else if (editing) await api.updateSso(editing.id, req);
      toast('Saved');
      setEditing(null);
      await load();
    } catch (err) {
      setProblem(errorText(err, 'Couldn’t save it.'));
    } finally {
      setBusy(false);
    }
  };
  const test = async (p: SsoProvider) => {
    try {
      await api.testSso(p.id);
      toast(`${p.name} answers`);
    } catch (e) {
      toast(errorText(e, 'It did not answer.'), 'error');
    }
  };
  const remove = async () => {
    const p = removing;
    setRemoving(null);
    if (!p) return;
    try {
      await api.removeSso(p.id);
      toast('Removed');
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t remove it.'), 'error');
    }
  };
  const copy = (v: string) => void navigator.clipboard?.writeText(v).then(() => toast('Copied'), () => undefined);
  const flag = (k: keyof Pick<Form, 'autoCreate' | 'trustUnverifiedEmail' | 'allowPrivateNetwork' | 'enabled'>, label: string, tip: string) => (
    <label className="flex min-h-11 items-center gap-2.5">
      <input type="checkbox" checked={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} className="size-5 shrink-0" />
      <span className="flex min-w-0 flex-1 items-center gap-1 text-sm">
        {label}
        <InfoTip label={`About ${label}`}>{tip}</InfoTip>
      </span>
    </label>
  );
  const redirect = list?.[0]?.redirectUri ?? `${window.location.origin}/api/auth/sso/callback`;

  return (
    <section aria-labelledby="settings-sso" data-settings-sso="">
      <div className="mb-2 flex items-center gap-1 px-1">
        <h2 id="settings-sso" className="flex flex-1 items-center gap-1 text-[13px] font-semibold text-muted">
          Single sign-on
          <InfoTip label="About single sign-on">
            OpenID Connect. An email on a provider’s domains signs in there, never with a password. Other emails use their password. The server code always works.
          </InfoTip>
        </h2>
        <Button variant="ghost" size="icon" aria-label="Add a provider" onClick={() => open('new')}>
          <Plus className="size-[18px]" />
        </Button>
      </div>
      <Card>
        {list === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : list.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">No providers. Everyone signs in with a password.</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((p) => (
              <li key={p.id} className="flex min-h-14 items-center gap-2 px-4 py-2 sm:px-5">
                <button type="button" onClick={() => open(p)} className="press flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left">
                  <KeyRound className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="block text-[12.5px] text-muted [overflow-wrap:anywhere]">{p.domains.map((d) => `@${d}`).join(' ')}</span>
                  </span>
                </button>
                <Badge tone={p.enabled ? 'success' : 'neutral'}>{p.enabled ? 'On' : 'Off'}</Badge>
                <Button variant="ghost" size="sm" onClick={() => void test(p)}>
                  Test
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Remove ${p.name}`} onClick={() => setRemoving(p)}>
                  <Trash2 className="size-[18px]" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add provider' : 'Provider'} size="sm">
        <form onSubmit={save} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
              Redirect URL
              <InfoTip label="About the redirect URL">Register this at the provider as the redirect (callback) URL of the app.</InfoTip>
            </span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 rounded-xl bg-surface-2 px-3 py-2.5 text-[12.5px] [overflow-wrap:anywhere]">{redirect}</code>
              <Button type="button" variant="ghost" size="icon" aria-label="Copy the redirect URL" onClick={() => copy(redirect)}>
                <Copy className="size-[18px]" />
              </Button>
            </div>
          </div>
          {(
            [
              ['name', 'Name', 'text', 'Google Workspace'],
              ['issuer', 'Issuer', 'url', 'https://accounts.google.com'],
              ['clientId', 'Client ID', 'text', ''],
            ] as const
          ).map(([k, label, type, ph]) => (
            <label key={k} className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink-soft">{label}</span>
              <input type={type} autoComplete="off" placeholder={ph} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} className={field} />
            </label>
          ))}
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
              Client secret
              <InfoTip label="About the client secret">Stored sealed; never shown again. Leave empty to keep the one set{editing !== 'new' && editing?.hasClientSecret ? ' (one is set)' : ''}.</InfoTip>
            </span>
            <input type="password" autoComplete="new-password" value={form.clientSecret} onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))} className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
              Domains
              <InfoTip label="About domains">Email domains that sign in through this provider, like konfersi.com. Comma separated, no @.</InfoTip>
            </span>
            <input type="text" autoComplete="off" placeholder="konfersi.com" value={form.domains} onChange={(e) => setForm((f) => ({ ...f, domains: e.target.value }))} className={field} />
          </label>
          <fieldset>
            <legend className="mb-1.5 flex items-center gap-1 text-sm font-semibold text-ink-soft">
              New accounts
              <InfoTip label="About new accounts">The role and team of an account made on its first sign-in.</InfoTip>
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {(['member', 'admin'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={form.defaultRole === r}
                  onClick={() => setForm((f) => ({ ...f, defaultRole: r }))}
                  className={`press min-h-11 rounded-2xl border px-3 text-sm font-semibold ${form.defaultRole === r ? 'border-accent bg-accent-soft text-ink' : 'border-line text-ink-soft'}`}
                >
                  {r === 'member' ? 'Member' : 'Admin'}
                </button>
              ))}
            </div>
            <select value={form.defaultTeamId} onChange={(e) => setForm((f) => ({ ...f, defaultTeamId: e.target.value }))} className="mt-2 h-12 w-full rounded-2xl border border-line bg-surface px-3 text-[15px]" aria-label="Team for new accounts">
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </fieldset>
          {flag('autoCreate', 'Make accounts', 'Make an account on the first sign-in. Off: only accounts an admin made may sign in.')}
          {form.defaultRole === 'admin' && form.autoCreate && (
            <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
              <input type="checkbox" checked={form.acknowledgeAdminAutoCreate} onChange={(e) => setForm((f) => ({ ...f, acknowledgeAdminAutoCreate: e.target.checked }))} className="mt-0.5 size-5 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">Everyone on these domains becomes a full admin on their first sign-in. I accept that.</span>
            </label>
          )}
          {flag('trustUnverifiedEmail', 'Trust unverified email', 'Accept an email the provider does not mark verified. Only for a provider that owns the domain outright.')}
          {flag('allowPrivateNetwork', 'Private network', 'The issuer is on a private network (an in-house Keycloak).')}
          {flag('enabled', 'On', 'Off: these domains use passwords again.')}
          {problem && (
            <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger [overflow-wrap:anywhere]">
              {problem}
            </p>
          )}
          <Button type="submit" size="lg" loading={busy} className="mt-1 w-full">
            Save
          </Button>
        </form>
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        title="Remove provider?"
        description={removing ? `${removing.domains.map((d) => '@' + d).join(', ')} sign in with a password again.` : ''}
        confirmLabel="Remove"
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </section>
  );
}
