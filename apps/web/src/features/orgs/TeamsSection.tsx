import { Button, ConfirmDialog, useToast } from '@isnanme/ui';
import type { Org, OrgMember, OrgTeam, OrgTeamMember, OrgTeamRole } from '@portal/contracts';
import { ChevronDown, Plus, Trash2, UserMinus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Card } from '@/components/Card';
import { api } from '@/lib/api';
import { orgField } from './NewOrgDialog';
import { canCreateTeam, canManageTeam, orgErrorText } from './rules';
import { Alert, SectionTitle, selectField } from './settingsUi';

const TEAM_ROLE: Record<OrgTeamRole, string> = { owner: 'Owner', member: 'Member' };

/**
 * Teams of the org (slice 7): everyone sees the teams (a guest only theirs); creating one follows Org.may.createTeam; adding and removing
 * people and deleting a team is for org owners and admins and the team's owners; anyone may take themselves out of a team.
 */
export function TeamsSection({ org, members, meId }: { org: Org; members: OrgMember[] | null; meId: string | null }) {
  const toast = useToast();
  const [teams, setTeams] = useState<OrgTeam[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<OrgTeam | null>(null);

  const load = useCallback(async () => {
    try {
      setTeams(await api.orgs.teams(org.id));
    } catch (e) {
      setTeams([]);
      setError(orgErrorText(e, 'Couldn’t load the teams.'));
    }
  }, [org.id]);
  useEffect(() => void load(), [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const t = await api.orgs.createTeam(org.id, { name: name.trim() });
      setName('');
      toast('Team created');
      await load();
      setOpen(t.id);
    } catch (err) {
      setError(orgErrorText(err, 'Couldn’t create the team.'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const t = deleting;
    setDeleting(null);
    if (!t) return;
    setError(null);
    try {
      await api.orgs.removeTeam(org.id, t.id);
      toast('Team deleted');
      await load();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t delete the team.'));
    }
  };

  return (
    <section aria-labelledby="org-teams" data-org-teams="">
      <SectionTitle id="org-teams" about="Groups of members to share with at once. Deleting a team ends what was shared with it.">
        Teams
      </SectionTitle>
      <Alert text={error} />
      {canCreateTeam(org) && (
        <Card className="mb-3 p-4 sm:p-5">
          <form onSubmit={create} className="flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink-soft">New team</span>
              <input type="text" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} className={orgField} />
            </label>
            <Button type="submit" loading={busy} disabled={!name.trim()} icon={<Plus className="size-4" />} className="min-h-12">
              Create
            </Button>
          </form>
        </Card>
      )}
      <Card>
        {teams === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : teams.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">No teams yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {teams.map((t) => (
              <li key={t.id} data-org-team={t.id}>
                <div className="flex min-h-14 items-center gap-2 px-2 sm:px-3">
                  <button
                    type="button"
                    aria-expanded={open === t.id}
                    onClick={() => setOpen(open === t.id ? null : t.id)}
                    className="press flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium [overflow-wrap:anywhere]">{t.name}</span>
                      <span className="block text-[12.5px] text-muted">
                        {t.members} {t.members === 1 ? 'member' : 'members'}
                        {t.myRole && ` · you: ${TEAM_ROLE[t.myRole].toLowerCase()}`}
                      </span>
                    </span>
                    <ChevronDown className={`size-4 shrink-0 text-muted transition-transform ${open === t.id ? 'rotate-180' : ''}`} aria-hidden />
                  </button>
                  {canManageTeam(org.myRole, t.myRole) && (
                    <Button variant="ghost" size="icon" aria-label={`Delete team ${t.name}`} onClick={() => setDeleting(t)}>
                      <Trash2 className="size-[18px]" />
                    </Button>
                  )}
                </div>
                {open === t.id && <TeamMembers org={org} team={t} members={members} meId={meId} onChanged={load} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={!!deleting}
        title="Delete team?"
        description={deleting ? `${deleting.name} is deleted and what was shared with it ends.` : ''}
        confirmLabel="Delete"
        onConfirm={() => void remove()}
        onClose={() => setDeleting(null)}
      />
    </section>
  );
}

function TeamMembers({ org, team, members, meId, onChanged }: { org: Org; team: OrgTeam; members: OrgMember[] | null; meId: string | null; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const manage = canManageTeam(org.myRole, team.myRole);
  const [list, setList] = useState<OrgTeamMember[] | null>(null);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<OrgTeamRole>('member');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.orgs.teamMembers(org.id, team.id).then(
      (l) => {
        if (live) setList(l);
      },
      (e) => {
        if (!live) return;
        setList([]);
        setError(orgErrorText(e, 'Couldn’t load the team.'));
      },
    );
    return () => {
      live = false;
    };
  }, [org.id, team.id]);

  const run = async (fn: () => Promise<OrgTeamMember[]>, done: string, fallback: string) => {
    setError(null);
    try {
      setList(await fn());
      toast(done);
      await onChanged();
    } catch (e) {
      setError(orgErrorText(e, fallback));
    }
  };
  const inTeam = new Set((list ?? []).map((m) => m.userId));
  // Guests are members of the org too; the server keeps teams to active members (TEAM_NOT_ORG_MEMBER otherwise).
  const candidates = (members ?? []).filter((m) => !inTeam.has(m.userId));

  return (
    <div data-org-team-members={team.id} className="border-t border-line bg-surface-2/50 px-4 py-3 sm:px-5">
      <Alert text={error} />
      {list === null ? (
        <div className="skeleton h-10 rounded-xl" />
      ) : (
        <ul className="flex flex-col">
          {list.map((m) => {
            const self = m.userId === meId;
            return (
              <li key={m.userId} className="flex min-h-12 flex-wrap items-center gap-x-2">
                <span className="min-w-0 flex-1 basis-32 [overflow-wrap:anywhere]">
                  {m.displayName}
                  {self && <span className="text-muted"> (you)</span>}
                </span>
                {manage ? (
                  <select
                    aria-label={`Team role of ${m.displayName}`}
                    value={m.role}
                    onChange={(e) => void run(() => api.orgs.setTeamMember(org.id, team.id, m.userId, e.target.value as OrgTeamRole), 'Role changed', 'Couldn’t change the role.')}
                    className="h-11 rounded-xl border border-line bg-surface px-3 text-sm font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <option value="owner">{TEAM_ROLE.owner}</option>
                    <option value="member">{TEAM_ROLE.member}</option>
                  </select>
                ) : (
                  <span className="px-2 text-sm font-semibold text-ink-soft">{TEAM_ROLE[m.role]}</span>
                )}
                {(manage || self) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={self ? `Leave team ${team.name}` : `Remove ${m.displayName} from ${team.name}`}
                    onClick={() => void run(async () => (await api.orgs.removeTeamMember(org.id, team.id, m.userId), (list ?? []).filter((x) => x.userId !== m.userId)), self ? 'You left the team' : 'Removed', 'Couldn’t remove them.')}
                  >
                    <UserMinus className="size-[18px]" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {manage && candidates.length > 0 && (
        <form
          className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pick) return;
            void run(() => api.orgs.setTeamMember(org.id, team.id, pick, role), 'Added', 'Couldn’t add them.').then(() => setPick(''));
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink-soft">Add</span>
            <select value={pick} onChange={(e) => setPick(e.target.value)} className={`${selectField} w-full`}>
              <option value="">Choose a member</option>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink-soft">Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value as OrgTeamRole)} className={selectField}>
              <option value="member">{TEAM_ROLE.member}</option>
              <option value="owner">{TEAM_ROLE.owner}</option>
            </select>
          </label>
          <Button type="submit" disabled={!pick} className="min-h-12">
            Add
          </Button>
        </form>
      )}
    </div>
  );
}
