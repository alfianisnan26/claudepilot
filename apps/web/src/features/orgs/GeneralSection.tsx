import { Button, ConfirmDialog, useToast } from '@isnanme/ui';
import { ORG_LIMITS, type Org } from '@portal/contracts';
import { LogOut } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { HOME } from '@/app/nav';
import { api } from '@/lib/api';
import { PERSONAL } from '@/lib/orgContext';
import { orgField } from './NewOrgDialog';
import { useOrgs } from './OrgsProvider';
import { canManageOrg, orgErrorText, ROLE_ABOUT, ROLE_LABEL } from './rules';
import { Alert, SectionTitle } from './settingsUi';

/** General: the name (owners and admins rename), the slug (fixed), when it was made, your role, and Leave (everyone; the last owner is refused). */
export function GeneralSection({ org, onSaved }: { org: Org; onSaved: (org: Org) => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { reload: reloadOrgs, setContext } = useOrgs();
  const manage = canManageOrg(org.myRole) && org.state === 'active';
  const [name, setName] = useState(org.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
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

  return (
    <section aria-labelledby="org-general">
      <SectionTitle id="org-general">General</SectionTitle>
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
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 px-1 text-sm">
            <dt className="font-semibold text-ink-soft">Created</dt>
            <dd data-org-created="" className="[overflow-wrap:anywhere]">{new Date(org.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</dd>
            <dt className="font-semibold text-ink-soft">Your role</dt>
            <dd className="flex items-center gap-1">
              {ROLE_LABEL[org.myRole]}
              <InfoTip label="About your role">{ROLE_ABOUT[org.myRole]}</InfoTip>
            </dd>
          </dl>
          <Alert text={error} />
          <div className="flex flex-wrap gap-2">
            {manage && (
              <Button type="submit" loading={busy} disabled={!name.trim() || name.trim() === org.name}>
                Save
              </Button>
            )}
            <Button type="button" variant="secondary" icon={<LogOut className="size-4" />} onClick={() => setLeaving(true)} data-org-leave="">
              Leave
            </Button>
          </div>
        </form>
      </Card>
      <ConfirmDialog
        open={leaving}
        title="Leave organization?"
        description={`You lose access to ${org.name}.`}
        confirmLabel="Leave"
        onConfirm={() => void leave()}
        onClose={() => setLeaving(false)}
      />
    </section>
  );
}
