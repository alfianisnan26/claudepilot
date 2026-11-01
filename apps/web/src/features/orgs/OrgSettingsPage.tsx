import { FOUNDING_USER_ID, type Org, type OrgMember } from '@portal/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { RoutedTabs } from '@/components/RoutedTabs';
import { api } from '@/lib/api';
import { AccessSection } from './AccessSection';
import { AuditSection } from './AuditSection';
import { DangerSection } from './DangerSection';
import { GeneralSection } from './GeneralSection';
import { InvitationsSection } from './InvitationsSection';
import { MembersSection } from './MembersSection';
import { ObjectsSection } from './ObjectsSection';
import { OrgSignInTab } from './OrgSignInTab';
import { useOrgs } from './OrgsProvider';
import { PoliciesSection } from './PoliciesSection';
import { canSeeMembers, objectRows, orgSections, SECTION_LABEL, type OrgObjectRow, type OrgSection } from './rules';
import { SectionTitle } from './settingsUi';
import { TeamsSection } from './TeamsSection';

/**
 * Org settings (docs/prd/organizations.md §7, §13.9; owner request 2026-11-01): a tab per section, each its own path
 * (`/admin/orgs/<id>/members`; General at `/admin/orgs/<id>`), one at a time under a bar of pill tabs (RoutedTabs). Which sections
 * show is `orgSections` (rules.ts): owners everything; admins no Policies or Danger zone; members General, Members, Teams, Objects, Access (and
 * Invitations when the org lets them invite); guests General, Teams, Objects. A suspended org shows its owners General and Danger zone. The
 * server decides every change. The older `?tab=sign-in` (where an SSO step-up returns) and `?tab=access` (an access request's notification)
 * move to their tab's path.
 */
export function OrgSettingsPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { reload: reloadOrgs } = useOrgs();
  const [org, setOrg] = useState<Org | null>(null);
  const [missing, setMissing] = useState(false);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [rows, setRows] = useState<OrgObjectRow[] | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const base = `/admin/orgs/${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
    try {
      const o = await api.orgs.get(id);
      setOrg(o);
      setMissing(false);
      if (canSeeMembers(o.myRole) && o.state === 'active') setMembers(await api.orgs.members(id));
    } catch {
      setMissing(true);
    }
  }, [id]);
  const loadObjects = useCallback(async () => {
    try {
      setRows(objectRows(await api.orgs.objects(id)));
    } catch {
      setRows([]);
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (org?.state === 'active') void loadObjects();
  }, [org?.state, loadObjects]);
  useEffect(() => {
    void api.me().then((m) => setMeId(m.kind === 'account' ? m.user.id : FOUNDING_USER_ID), () => undefined);
  }, []);

  const sections = useMemo(() => (org ? orgSections(org) : []), [org]);
  const names = useMemo(() => new Map((members ?? []).map((m) => [m.userId, m.displayName])), [members]);

  if (missing)
    return (
      <>
        <PageHeader title="Org settings" />
        <Card className="px-4 py-4 text-sm text-muted sm:px-5">Not found.</Card>
      </>
    );
  if (!org) return <div className="skeleton h-40 rounded-[24px]" aria-busy="true" />;

  const saved = (o: Org) => {
    setOrg(o);
    void reloadOrgs();
  };
  const render = (s: OrgSection) => {
    switch (s) {
      case 'general':
        return <GeneralSection org={org} onSaved={saved} />;
      case 'members':
        return (
          <MembersSection
            org={org}
            members={members}
            meId={meId}
            onMembers={setMembers}
            onSelfChanged={async () => {
              await Promise.all([load(), reloadOrgs()]);
            }}
            onInvite={sections.includes('invitations') ? () => navigate(`${base}/invitations`) : undefined}
          />
        );
      case 'teams':
        return <TeamsSection org={org} members={members} meId={meId} />;
      case 'invitations':
        return <InvitationsSection org={org} />;
      case 'objects':
        return <ObjectsSection org={org} rows={rows} meId={meId} onMoved={loadObjects} />;
      case 'access':
        return <AccessSection org={org} members={members} meId={meId} />;
      case 'sign-in':
        return (
          <section aria-labelledby="org-signin-title">
            <SectionTitle id="org-signin-title">Sign-in</SectionTitle>
            {/* Keyed on requireSso, so a change made in Policies reloads it. */}
            <OrgSignInTab key={String(org.policies?.requireSso)} org={org} members={members} />
          </section>
        );
      case 'policies':
        return <PoliciesSection org={org} onSaved={saved} />;
      case 'audit':
        return <AuditSection org={org} names={names} />;
      case 'danger':
        return <DangerSection org={org} onChanged={saved} />;
    }
  };

  return (
    <div data-org-settings="" className="pb-10">
      <PageHeader title={org.name} description="Settings of this organization. You see the sections your role may use." />
      {org.state === 'suspended' && (
        <p data-org-suspended="" className="mb-6 rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm font-medium [overflow-wrap:anywhere] text-danger">
          Suspended. Nobody can use its things until an owner resumes it.
        </p>
      )}
      <RoutedTabs
        base={base}
        label="Org settings sections"
        tabs={sections.map((s) => ({ id: s, label: SECTION_LABEL[s], danger: s === 'danger', content: <div data-org-section={s}>{render(s)}</div> }))}
      />
    </div>
  );
}
