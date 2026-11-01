import { Badge, Button, ConfirmDialog, useToast } from '@isnanme/ui';
import type { Org, OrgMember, OrgRole, OrgSignInSettings, OrgSsoProviderRequest } from '@portal/contracts';
import { Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { api } from '@/lib/api';
import { orgField } from './NewOrgDialog';
import { canSetSsoPolicy, cleanRules, DOMAIN_STATE, orgErrorText, outsideMembers, parseFreshness, ROLE_LABEL } from './rules';

type RuleRow = { group: string; role: Exclude<OrgRole, 'owner'> };
const heading = 'mb-2 flex items-center gap-1 px-1 text-[13px] font-semibold text-muted';
const label = 'text-sm font-semibold text-ink-soft';
const mono = 'block font-mono text-[12.5px] [overflow-wrap:anywhere]';
const check = 'flex min-h-11 items-center gap-3 text-sm font-medium';

/**
 * The Sign-in tab of Org settings (docs/prd/organizations.md §9, slice 10): Domains (TXT verification), the org's OIDC provider and its
 * group rules, and Require SSO (owners). Owners and admins see it; the server decides every change.
 */
export function OrgSignInTab({ org, members }: { org: Org; members: OrgMember[] | null }) {
  const toast = useToast();
  const [s, setS] = useState<OrgSignInSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setS(await api.orgs.signIn(org.id));
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t load the sign-in settings.'));
    }
  }, [org.id]);
  useEffect(() => void load(), [load]);

  const run = async (fn: () => Promise<unknown>, done: string, fallback: string) => {
    setError(null);
    try {
      await fn();
      toast(done);
      await load();
    } catch (e) {
      setError(orgErrorText(e, fallback));
    }
  };

  if (!s) return error ? <Alert text={error} /> : <div className="skeleton h-40 rounded-[24px]" aria-busy="true" />;

  return (
    <div data-org-signin="" className="flex flex-col gap-6">
      {error && <Alert text={error} />}
      <Domains org={org} s={s} run={run} />
      <Provider org={org} s={s} run={run} />
      <Policy org={org} s={s} members={members} run={run} />
    </div>
  );
}

type Run = (fn: () => Promise<unknown>, done: string, fallback: string) => Promise<void>;

function Alert({ text }: { text: string }) {
  return (
    <p role="alert" data-org-error="" className="rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm font-medium [overflow-wrap:anywhere] text-danger">
      {text}
    </p>
  );
}

function Domains({ org, s, run }: { org: Org; s: OrgSignInSettings; run: Run }) {
  const [domain, setDomain] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const d = domain.trim();
    if (!d) return;
    await run(() => api.orgs.addDomain(org.id, d), 'Domain added', 'Couldn’t add the domain.');
    setDomain('');
  };
  return (
    <section aria-labelledby="org-domains">
      <h3 id="org-domains" className={heading}>
        Domains
        <InfoTip label="About domains">
          Publish the TXT record at your DNS, then Check. A verified domain signs in through this organization’s provider. It is checked daily; seven failed checks in a row and it stops working.
        </InfoTip>
      </h3>
      <Card>
        <ul className="divide-y divide-line">
          {s.domains.map((d) => (
            <li key={d.domain} data-org-domain={d.domain} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 basis-32 font-medium [overflow-wrap:anywhere]">{d.domain}</span>
                <Badge tone={DOMAIN_STATE[d.state].tone}>{DOMAIN_STATE[d.state].label}</Badge>
                <Button variant="ghost" size="icon" aria-label={`Check ${d.domain}`} onClick={() => void run(() => api.orgs.checkDomain(org.id, d.domain), 'Checked', 'Couldn’t check.')}>
                  <RefreshCw className="size-[18px]" />
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Remove ${d.domain}`} onClick={() => setRemoving(d.domain)}>
                  <Trash2 className="size-[18px]" />
                </Button>
              </div>
              {d.state !== 'verified' && (
                <div className="rounded-xl bg-surface-2 px-3 py-2">
                  <span className="text-[12px] font-semibold text-muted">TXT</span>
                  <span className={mono}>{d.record.name}</span>
                  <span className={mono}>{d.record.value}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
        <form onSubmit={add} className="flex flex-wrap gap-2 px-4 py-3 sm:px-5" noValidate>
          <input
            type="text"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            aria-label="New domain"
            placeholder="example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className={`${orgField} min-w-0 flex-1 basis-48`}
          />
          <Button type="submit" variant="secondary" icon={<Plus className="size-4" />} disabled={!domain.trim()}>
            Add
          </Button>
        </form>
      </Card>
      <ConfirmDialog
        open={!!removing}
        title="Remove domain?"
        description={removing ? `${removing} stops signing in through this organization.` : ''}
        confirmLabel="Remove"
        onConfirm={() => {
          const d = removing;
          setRemoving(null);
          if (d) void run(() => api.orgs.removeDomain(org.id, d), 'Removed', 'Couldn’t remove it.');
        }}
        onClose={() => setRemoving(null)}
      />
    </section>
  );
}

function Provider({ org, s, run }: { org: Org; s: OrgSignInSettings; run: Run }) {
  const p = s.provider;
  const [name, setName] = useState(p?.name ?? '');
  const [issuer, setIssuer] = useState(p?.issuer ?? '');
  const [clientId, setClientId] = useState(p?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [groupsClaim, setGroupsClaim] = useState(p?.groupsClaim ?? '');
  const [autoCreate, setAutoCreate] = useState(p?.autoCreate ?? true);
  const [enabled, setEnabled] = useState(p?.enabled ?? true);
  const [rules, setRules] = useState<RuleRow[]>((p?.groupRules ?? []).filter((r) => r.role).map((r) => ({ group: r.group, role: r.role! })));
  const [removing, setRemoving] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: OrgSsoProviderRequest = {
      name: name.trim(),
      issuer: issuer.trim(),
      clientId: clientId.trim(),
      groupsClaim: groupsClaim.trim() || null,
      groupRules: cleanRules(rules),
      autoCreate,
      enabled,
      ...(secret ? { clientSecret: secret } : {}),
    };
    await run(() => api.orgs.saveSso(org.id, body), 'Saved', 'Couldn’t save the provider.');
    setSecret('');
  };

  return (
    <section aria-labelledby="org-provider">
      <h3 id="org-provider" className={heading}>
        Provider
        <InfoTip label="About the provider">
          Your organization’s OpenID Connect sign-in (Google Workspace, Entra, Okta, Keycloak). It serves every verified domain. An existing account with a password is never linked by email: its holder connects it from here.
        </InfoTip>
      </h3>
      <Card className="p-4 sm:p-5">
        <form onSubmit={save} className="flex flex-col gap-3" noValidate>
          <Field label="Name" value={name} onChange={setName} placeholder="Acme sign-in" />
          <Field label="Issuer" value={issuer} onChange={setIssuer} placeholder="https://accounts.example.com" mono />
          <Field label="Client ID" value={clientId} onChange={setClientId} mono />
          <label className="flex flex-col gap-1.5">
            <span className={label}>Client secret</span>
            <input type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={p?.hasClientSecret ? 'Saved (type to replace)' : 'Optional'} className={orgField} />
          </label>
          <Field label="Groups claim" value={groupsClaim} onChange={setGroupsClaim} placeholder="groups" mono />
          <div className="flex flex-col gap-1.5">
            <span className={`${label} flex items-center gap-1`}>
              Group rules
              <InfoTip label="About group rules">At each sign-in the highest matching role wins; no match gives the default role. Owner is never given by a group.</InfoTip>
            </span>
            {rules.map((r, i) => (
              <div key={i} className="flex flex-wrap gap-2" data-org-rule="">
                <input aria-label={`Group of rule ${i + 1}`} value={r.group} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)))} className={`${orgField} min-w-0 flex-1 basis-40`} />
                <select
                  aria-label={`Role of rule ${i + 1}`}
                  value={r.role}
                  onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, role: e.target.value as RuleRow['role'] } : x)))}
                  className="h-12 min-w-28 rounded-2xl border border-line bg-surface px-3 text-sm font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {(['admin', 'member', 'guest'] as const).map((x) => (
                    <option key={x} value={x}>
                      {ROLE_LABEL[x]}
                    </option>
                  ))}
                </select>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove rule ${i + 1}`} onClick={() => setRules(rules.filter((_, j) => j !== i))}>
                  <X className="size-[18px]" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="ghost" icon={<Plus className="size-4" />} className="self-start" onClick={() => setRules([...rules, { group: '', role: 'member' }])}>
              Rule
            </Button>
          </div>
          <label className={check}>
            <input type="checkbox" className="size-5 accent-[var(--color-accent)]" checked={autoCreate} onChange={(e) => setAutoCreate(e.target.checked)} />
            Make accounts
            <InfoTip label="About making accounts">A person from a verified domain with no account gets one at the first sign-in, and joins with the default role.</InfoTip>
          </label>
          <label className={check}>
            <input type="checkbox" className="size-5 accent-[var(--color-accent)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            On
          </label>
          {p && (
            <div className="flex flex-col gap-1.5">
              <span className={`${label} flex items-center gap-1`}>
                Redirect URL
                <InfoTip label="About the redirect URL">Register this at your provider.</InfoTip>
              </span>
              <span className={`${mono} rounded-xl bg-surface-2 px-3 py-2`}>{p.redirectUri}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!name.trim() || !issuer.trim() || !clientId.trim()}>
              Save
            </Button>
            {p && (
              <Button type="button" variant="secondary" onClick={() => void run(() => api.orgs.testSso(org.id), 'The provider answers', 'The provider did not answer.')}>
                Test
              </Button>
            )}
            {p && (
              <Button type="button" variant="ghost" onClick={() => setRemoving(true)}>
                Remove
              </Button>
            )}
          </div>
        </form>
      </Card>
      <ConfirmDialog
        open={removing}
        title="Remove provider?"
        description="People sign in with their passwords again; links to this provider are dropped."
        confirmLabel="Remove"
        onConfirm={() => {
          setRemoving(false);
          void run(() => api.orgs.removeSso(org.id), 'Removed', 'Couldn’t remove it.');
        }}
        onClose={() => setRemoving(false)}
      />
    </section>
  );
}

function Field({ label: text, value, onChange, placeholder, mono: isMono }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={label}>{text}</span>
      <input type="text" autoCapitalize="none" spellCheck={false} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={`${orgField} ${isMono ? 'font-mono text-[14px]' : ''}`} />
    </label>
  );
}

function Policy({ org, s, members, run }: { org: Org; s: OrgSignInSettings; members: OrgMember[] | null; run: Run }) {
  const owner = canSetSsoPolicy(org.myRole);
  const [days, setDays] = useState(s.ssoFreshnessDays === null ? '' : String(s.ssoFreshnessDays));
  useEffect(() => setDays(s.ssoFreshnessDays === null ? '' : String(s.ssoFreshnessDays)), [s.ssoFreshnessDays]);
  const parsed = parseFreshness(days);
  const outside = members ? outsideMembers(members, s.domains) : [];
  const toggleException = (userId: string, on: boolean) => {
    const next = on ? [...s.exceptions, userId] : s.exceptions.filter((u) => u !== userId);
    void run(() => api.orgs.ssoPolicy(org.id, { exceptions: next as OrgSignInSettings['exceptions'] }), 'Saved', 'Couldn’t save.');
  };
  return (
    <section aria-labelledby="org-require-sso">
      <h3 id="org-require-sso" className={heading}>
        Require SSO
        <InfoTip label="About requiring SSO">
          Members on a verified domain reach this organization’s things only after signing in through the provider; their passwords stop working here. Members outside the domains count as guests unless listed below. Only owners change this.
        </InfoTip>
      </h3>
      <Card className="flex flex-col gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={s.thisSession ? 'success' : 'neutral'}>{s.thisSession ? 'This session: connected' : 'This session: not connected'}</Badge>
          {s.stepUp && !s.thisSession && (
            <a href={s.stepUp} data-org-stepup="" className="press inline-flex min-h-11 items-center rounded-full bg-surface-2 px-4 text-sm font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-accent">
              Connect
            </a>
          )}
        </div>
        <label className={check}>
          <input
            type="checkbox"
            className="size-5 accent-[var(--color-accent)]"
            checked={s.requireSso}
            disabled={!owner}
            onChange={(e) => void run(() => api.orgs.ssoPolicy(org.id, { requireSso: e.target.checked }), 'Saved', 'Couldn’t change it.')}
          />
          Require SSO
          {!s.ownerSignedIn && <InfoTip label="Why it may be refused">An owner connects through the provider first, so nobody is locked out.</InfoTip>}
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1.5">
            <span className={`${label} flex items-center gap-1`}>
              Token freshness (days)
              <InfoTip label="About token freshness">Tokens and agents of bound members work while their last sign-in through the provider is this recent. Empty: one sign-in is enough.</InfoTip>
            </span>
            <input type="text" inputMode="numeric" value={days} disabled={!owner} onChange={(e) => setDays(e.target.value)} placeholder="Off" className={orgField} aria-invalid={parsed === 'invalid'} />
          </label>
          {owner && (
            <Button
              variant="secondary"
              disabled={parsed === 'invalid' || parsed === s.ssoFreshnessDays}
              onClick={() => parsed !== 'invalid' && void run(() => api.orgs.ssoPolicy(org.id, { ssoFreshnessDays: parsed }), 'Saved', 'Couldn’t save.')}
            >
              Save
            </Button>
          )}
        </div>
        {outside.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className={`${label} flex items-center gap-1`}>
              Exceptions
              <InfoTip label="About exceptions">Members outside the verified domains keep their role while SSO is required only when checked.</InfoTip>
            </span>
            {outside.map((m) => (
              <label key={m.userId} className={check}>
                <input type="checkbox" className="size-5 shrink-0 accent-[var(--color-accent)]" checked={s.exceptions.includes(m.userId)} disabled={!owner} onChange={(e) => toggleException(m.userId, e.target.checked)} />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {m.displayName} <span className="text-muted">{m.email}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </Card>
    </section>
  );
}
