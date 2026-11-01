import { Switch, useToast } from '@isnanme/ui';
import { ORG_POLICY_DEFAULTS, type Org, type OrgSettablePolicy } from '@portal/contracts';
import { useState, type ReactNode } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { api } from '@/lib/api';
import { orgErrorText } from './rules';
import { Alert, SectionTitle } from './settingsUi';

type Key = OrgSettablePolicy | 'requireSso';

const ROWS: { key: Key; label: string; about: ReactNode }[] = [
  { key: 'membersMayInvite', label: 'Members invite', about: 'Members (not only owners and admins) may invite people, up to member.' },
  { key: 'membersCreateTeams', label: 'Members create teams', about: 'Members may create teams. Owners and admins always can.' },
  {
    key: 'externalShares',
    label: 'Outside shares',
    about: 'Kept for sharing the organization’s things outside it. Not in effect yet: shares stay inside the organization.',
  },
  {
    key: 'requireSso',
    label: 'Require SSO',
    about: 'Members on a verified domain reach the organization’s things only after signing in through its provider. An owner who signed in through it is needed first (Sign-in).',
  },
];

/** Policies (owners only): the three org policies (PATCH /api/orgs/:id `policies`) and Require SSO (its own route, with the lockout guard). */
export function PoliciesSection({ org, onSaved }: { org: Org; onSaved: (org: Org) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<Key | null>(null);
  const [error, setError] = useState<string | null>(null);
  const p = org.policies ?? ORG_POLICY_DEFAULTS;

  const set = async (key: Key, value: boolean) => {
    setBusy(key);
    setError(null);
    try {
      if (key === 'requireSso') {
        await api.orgs.ssoPolicy(org.id, { requireSso: value });
        onSaved(await api.orgs.get(org.id));
      } else onSaved(await api.orgs.update(org.id, { policies: { [key]: value } }));
      toast('Saved');
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t save.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="org-policies" data-org-policies="">
      <SectionTitle id="org-policies" about="Rules for everyone in this organization. Only owners change them.">
        Policies
      </SectionTitle>
      <Alert text={error} />
      <Card>
        <ul className="divide-y divide-line">
          {ROWS.map((r) => (
            <li key={r.key} data-org-policy={r.key} className="flex min-h-14 items-center gap-2 px-4 py-2 sm:px-5">
              <span id={`org-policy-${r.key}`} className="min-w-0 font-medium [overflow-wrap:anywhere]">
                {r.label}
              </span>
              <InfoTip label={`About ${r.label.toLowerCase()}`}>{r.about}</InfoTip>
              <Switch className="ml-auto" checked={!!p[r.key]} disabled={busy !== null} labelledBy={`org-policy-${r.key}`} onChange={(v) => void set(r.key, v)} />
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
