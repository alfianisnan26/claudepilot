import { cn } from '@isnanme/ui';
import { FOUNDING_USER_ID, type Org, type OrgMember } from '@portal/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
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

const anchor = (s: OrgSection) => `org-s-${s}`;

/**
 * Org settings (docs/prd/organizations.md §7, §13.9; owner request 2026-11-01): one scrolling page of sections, with a side list on wide
 * screens and a sticky section picker on phones. Which sections show is `orgSections` (rules.ts): owners everything; admins no Policies or
 * Danger zone; members General, Members, Teams, Objects, Access (and Invitations when the org lets them invite); guests General, Teams,
 * Objects. A suspended org shows its owners General and Danger zone. The server decides every change. `?tab=sign-in` (where an SSO
 * step-up returns) opens at Sign-in, `?tab=access` (an access request's notification) at Access.
 */
export function OrgSettingsPage() {
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const { reload: reloadOrgs } = useOrgs();
  const [org, setOrg] = useState<Org | null>(null);
  const [missing, setMissing] = useState(false);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [rows, setRows] = useState<OrgObjectRow[] | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [active, setActive] = useState<OrgSection>('general');

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

  const go = useCallback((s: OrgSection) => {
    setActive(s);
    const el = document.getElementById(anchor(s));
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }, []);

  // An SSO step-up returns to `?tab=sign-in`, an access request's notification to `?tab=access`: open there once the sections are on the page.
  const opened = useRef(false);
  useEffect(() => {
    const tab = search.get('tab') as OrgSection | null;
    if (opened.current || !tab || (tab !== 'sign-in' && tab !== 'access') || !sections.includes(tab)) return;
    opened.current = true;
    requestAnimationFrame(() => go(tab));
    // The sections above load their lists after the page; go again once they have settled, so the section stays at the top.
    window.setTimeout(() => go(tab), 900);
  }, [sections, search, go]);

  // The side list and the picker follow the section in view.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || sections.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const key = top?.target.getAttribute('data-org-section') as OrgSection | null;
        if (key) setActive(key);
      },
      { rootMargin: '-140px 0px -55% 0px' },
    );
    for (const s of sections) {
      const el = document.getElementById(anchor(s));
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, [sections]);

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
            onInvite={sections.includes('invitations') ? () => go('invitations') : undefined}
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
    <div data-org-settings="" className="flex flex-col gap-6 pb-10">
      <PageHeader title={org.name} description="Settings of this organization. You see the sections your role may use." />
      {org.state === 'suspended' && (
        <p data-org-suspended="" className="rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm font-medium [overflow-wrap:anywhere] text-danger">
          Suspended. Nobody can use its things until an owner resumes it.
        </p>
      )}
      <div className="lg:grid lg:grid-cols-[10.5rem_minmax(0,1fr)] lg:gap-8">
        <nav aria-label="Org settings sections" className="hidden lg:block">
          <ul className="sticky top-6 flex flex-col gap-1">
            {sections.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  aria-current={active === s ? 'location' : undefined}
                  data-org-nav={s}
                  onClick={() => go(s)}
                  className={cn(
                    'press flex min-h-11 w-full items-center rounded-xl px-3 text-left text-sm font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-accent',
                    active === s ? 'bg-surface-2 text-ink' : 'text-ink-soft',
                    s === 'danger' && 'text-danger',
                  )}
                >
                  {SECTION_LABEL[s]}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-10">
          {sections.length > 1 && (
            <label className="sticky top-[calc(var(--safe-top)+4rem)] z-30 -mx-4 -mb-6 border-b border-line bg-bg/90 px-4 py-2 backdrop-blur-md sm:top-0 sm:-mx-6 sm:px-6 lg:hidden">
              <span className="sr-only">Section</span>
              <select
                data-org-picker=""
                value={active}
                onChange={(e) => go(e.target.value as OrgSection)}
                className="h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
              >
                {sections.map((s) => (
                  <option key={s} value={s}>
                    {SECTION_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {sections.map((s) => (
            <div key={s} id={anchor(s)} data-org-section={s} className="scroll-mt-48 sm:scroll-mt-20 lg:scroll-mt-6">
              {render(s)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
