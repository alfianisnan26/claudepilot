import { Button, ConfirmDialog, useToast } from '@isnanme/ui';
import { FOUNDING_USER_ID, ORG_LIMITS, type Org, type OrgMember, type OrgRole } from '@portal/contracts';
import { LogOut, UserMinus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { api } from '@/lib/api';
import { HOME } from '@/app/nav';
import { PERSONAL } from '@/lib/orgContext';
import { orgField } from './NewOrgDialog';
import { OrgSignInTab } from './OrgSignInTab';
import { useOrgs } from './OrgsProvider';
import { canManageOrg, canRemoveMember, canSeeMembers, canSeeSignIn, orgErrorText, ROLE_ABOUT, ROLE_LABEL, roleChoices } from './rules';

type Tab = 'general' | 'sign-in';

/**
 * Org settings (docs/prd/organizations.md §7, slice 9): General (name; the slug is fixed) and Members (roles, remove, leave). Owners and
 * admins change things; members read; a guest sees the name and Leave only. Slice 10 adds the Sign-in tab (owners and admins; `?tab=sign-in`,
 * where a step-up returns): domains, the org's provider, Require SSO (OrgSignInTab). Teams, invitations, policies and audit come with their
 * slices (7, 8). The server decides every change; a refusal (the last owner) is shown as it comes.
 */
export function OrgSettingsPage() {
  const { id = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const toast = useToast();
  const navigate = useNavigate();
  const { reload: reloadOrgs, setContext } = useOrgs();
  const [org, setOrg] = useState<Org | null>(null);
  const [missing, setMissing] = useState(false);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<OrgMember | null>(null);
  const [leaving, setLeaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const o = await api.orgs.get(id);
      setOrg(o);
      setMissing(false);
      if (canSeeMembers(o.myRole)) setMembers(await api.orgs.members(id));
    } catch {
      setMissing(true);
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    void api.me().then((m) => setMeId(m.kind === 'account' ? m.user.id : FOUNDING_USER_ID), () => undefined);
  }, []);

  if (missing)
    return (
      <>
        <PageHeader title="Org settings" />
        <Card className="px-4 py-4 text-sm text-muted sm:px-5">Not found.</Card>
      </>
    );
  if (!org) return <div className="skeleton h-40 rounded-[24px]" aria-busy="true" />;

  const manage = canManageOrg(org.myRole);

  const setRole = async (m: OrgMember, role: OrgRole) => {
    setError(null);
    try {
      setMembers(await api.orgs.setRole(org.id, m.userId, { role }));
      toast('Role changed');
      if (m.userId === meId) await Promise.all([load(), reloadOrgs()]);
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t change the role.'));
    }
  };
  const remove = async () => {
    const m = removing;
    setRemoving(null);
    if (!m) return;
    setError(null);
    try {
      await api.orgs.remove(org.id, m.userId);
      toast('Removed');
      await load();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t remove them.'));
    }
  };
  const leave = async () => {
    setLeaving(false);
    setError(null);
    try {
      await api.orgs.leave(org.id);
      setContext(PERSONAL);
      await reloadOrgs();
      toast('You left the organization');
      navigate(HOME);
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t leave.'));
    }
  };

  const tab: Tab = canSeeSignIn(org.myRole) && search.get('tab') === 'sign-in' ? 'sign-in' : 'general';
  const tabs = canSeeSignIn(org.myRole) && (
    <div role="tablist" aria-label="Org settings" className="flex gap-1 rounded-full bg-surface-2 p-1 self-start">
      {(
        [
          ['general', 'General'],
          ['sign-in', 'Sign-in'],
        ] as const
      ).map(([key, text]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          data-org-tab={key}
          onClick={() => setSearch(key === 'general' ? {} : { tab: key }, { replace: true })}
          className={`press min-h-11 rounded-full px-4 text-sm font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-accent ${tab === key ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft'}`}
        >
          {text}
        </button>
      ))}
    </div>
  );

  if (tab === 'sign-in')
    return (
      <div data-org-settings="" className="flex flex-col gap-6">
        <PageHeader title={org.name} description={`Settings of this organization. Your role: ${ROLE_ABOUT[org.myRole]}`} />
        {tabs}
        <OrgSignInTab org={org} members={members} />
      </div>
    );

  return (
    <div data-org-settings="" className="flex flex-col gap-6">
      <PageHeader title={org.name} description={`Settings of this organization. Your role: ${ROLE_ABOUT[org.myRole]}`} />
      {tabs}
      <General org={org} manage={manage} onSaved={(o) => (setOrg(o), void reloadOrgs())} />

      {error && (
        <p role="alert" data-org-error="" className="rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm font-medium [overflow-wrap:anywhere] text-danger">
          {error}
        </p>
      )}

      {canSeeMembers(org.myRole) && (
        <section aria-labelledby="org-members">
          <h2 id="org-members" className="mb-2 flex items-center gap-1 px-1 text-[13px] font-semibold text-muted">
            Members
            <InfoTip label="About members">
              {manage
                ? 'Change a role or remove someone. Admins change roles up to admin; only an owner changes owners. An organization always keeps an owner.'
                : 'The people in this organization. Owners and admins change roles.'}
            </InfoTip>
          </h2>
          <Card>
            {members === null ? (
              <div className="skeleton m-4 h-10 rounded-xl" />
            ) : (
              <ul className="divide-y divide-line">
                {members.map((m) => {
                  const self = m.userId === meId;
                  const choices = roleChoices(org.myRole, m.role);
                  return (
                    <li key={m.userId} data-org-member={m.userId} className="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 sm:px-5">
                      <span className="min-w-0 flex-1 basis-40">
                        <span className="block font-medium [overflow-wrap:anywhere]">
                          {m.displayName}
                          {self && <span className="text-muted"> (you)</span>}
                        </span>
                        {m.email && <span className="block text-[12.5px] [overflow-wrap:anywhere] text-muted">{m.email}</span>}
                      </span>
                      {choices.length > 0 ? (
                        <select
                          aria-label={`Role of ${m.displayName}`}
                          value={m.role}
                          onChange={(e) => void setRole(m, e.target.value as OrgRole)}
                          className="h-11 min-w-28 rounded-xl border border-line bg-surface px-3 text-sm font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          {choices.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="px-2 text-sm font-semibold text-ink-soft">{ROLE_LABEL[m.role]}</span>
                      )}
                      {canRemoveMember(org.myRole, m.role, self) && (
                        <Button variant="ghost" size="icon" aria-label={`Remove ${m.displayName}`} onClick={() => setRemoving(m)}>
                          <UserMinus className="size-[18px]" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </section>
      )}

      <div>
        <Button variant="secondary" icon={<LogOut className="size-4" />} onClick={() => setLeaving(true)} data-org-leave="">
          Leave
        </Button>
      </div>

      <ConfirmDialog
        open={!!removing}
        title="Remove member?"
        description={removing ? `${removing.displayName} loses access to this organization.` : ''}
        confirmLabel="Remove"
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
      <ConfirmDialog
        open={leaving}
        title="Leave organization?"
        description={`You lose access to ${org.name}.`}
        confirmLabel="Leave"
        onConfirm={() => void leave()}
        onClose={() => setLeaving(false)}
      />
    </div>
  );
}

function General({ org, manage, onSaved }: { org: Org; manage: boolean; onSaved: (org: Org) => void }) {
  const toast = useToast();
  const [name, setName] = useState(org.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(org.name), [org.name]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.orgs.update(org.id, { name: name.trim() }));
      toast('Saved');
    } catch (err) {
      setError(orgErrorText(err, 'Couldn’t save.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="org-general">
      <h2 id="org-general" className="mb-2 px-1 text-[13px] font-semibold text-muted">
        General
      </h2>
      <Card className="p-4 sm:p-5">
        <form onSubmit={save} className="flex flex-col gap-3" noValidate>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink-soft">Name</span>
            <input type="text" maxLength={ORG_LIMITS.nameMax} value={name} readOnly={!manage} onChange={(e) => setName(e.target.value)} className={orgField} />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
              Slug
              <InfoTip label="About the slug">Used in links. It can’t be changed.</InfoTip>
            </span>
            <span className="flex min-h-12 items-center rounded-2xl bg-surface-2 px-4 font-mono text-[14px] [overflow-wrap:anywhere]">{org.slug}</span>
          </div>
          {error && (
            <p role="alert" className="text-sm font-medium [overflow-wrap:anywhere] text-danger">
              {error}
            </p>
          )}
          {manage && (
            <Button type="submit" loading={busy} disabled={!name.trim() || name.trim() === org.name} className="self-start">
              Save
            </Button>
          )}
        </form>
      </Card>
    </section>
  );
}
