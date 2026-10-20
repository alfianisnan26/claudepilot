import { Badge, Button, Dialog, useToast } from '@isnanme/ui';
import type { PortalTeamDetail, PortalTeamRole } from '@portal/contracts';
import { LogOut, Trash2, UserPlus, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { api, errorText } from '@/lib/api';
import { CAP_LABEL, endText } from '@/features/chat/ShareSessionDialog';

const field = 'h-12 w-full min-w-0 rounded-2xl border border-line bg-surface px-4 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-accent';

/**
 * One team (owner, 2026-10-17: "team based multiaccount"): its people and what is shared with it. An admin or one of the team's owners adds
 * people by email, makes them owner or member, removes them; a member sees the people and may leave. A team keeps one owner.
 */
export function TeamDialog({ teamId, manage, meId, open, onClose, onChanged }: { teamId: string | null; manage: boolean; meId: string | null; open: boolean; onClose: () => void; onChanged?: () => void }) {
  const toast = useToast();
  const [team, setTeam] = useState<PortalTeamDetail | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PortalTeamRole>('member');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      setTeam(await api.team(teamId));
    } catch (e) {
      toast(errorText(e, 'Couldn’t load the team.'), 'error');
    }
  }, [teamId, toast]);
  useEffect(() => {
    if (open) void load();
    else setTeam(null);
  }, [open, load]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      await load();
      onChanged?.();
    } catch (e) {
      toast(errorText(e, 'Couldn’t change it.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!teamId || !email.trim()) return;
    void run(async () => {
      await api.addTeamMember(teamId, { email: email.trim(), role });
      setEmail('');
    }, 'Added');
  };
  const canManage = manage || team?.myRole === 'owner';

  return (
    <Dialog open={open} onClose={onClose} title={team?.name ?? 'Team'} size="sm">
      <div className="flex flex-col gap-3" data-team-dialog="">
        {team?.description && <p className="text-sm text-ink-soft [overflow-wrap:anywhere]">{team.description}</p>}
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {(team?.people ?? []).map((p) => (
            <li key={p.userId} className="flex min-h-11 items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium [overflow-wrap:anywhere]">{p.displayName}</span>
                <span className="block text-[12.5px] text-muted [overflow-wrap:anywhere]">{p.email}</span>
              </span>
              {canManage ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => api.setTeamRole(team!.id, p.userId, p.role === 'owner' ? 'member' : 'owner'), 'Role changed')}
                  className="press min-h-11 shrink-0 rounded-full px-2"
                  aria-label={p.role === 'owner' ? `Make ${p.email} a member` : `Make ${p.email} an owner`}
                >
                  <Badge tone={p.role === 'owner' ? 'warning' : 'neutral'}>{p.role === 'owner' ? 'Owner' : 'Member'}</Badge>
                </button>
              ) : (
                <Badge tone={p.role === 'owner' ? 'warning' : 'neutral'}>{p.role === 'owner' ? 'Owner' : 'Member'}</Badge>
              )}
              {(canManage || p.userId === meId) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => api.removeTeamMember(team!.id, p.userId), p.userId === meId ? 'You left the team' : 'Removed')}
                  aria-label={p.userId === meId ? 'Leave the team' : `Remove ${p.email}`}
                  className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-danger-soft hover:text-danger"
                >
                  {p.userId === meId ? <LogOut className="size-[18px]" /> : <Trash2 className="size-[18px]" />}
                </button>
              )}
            </li>
          ))}
          {team && team.people.length === 0 && <li className="px-3 py-3 text-sm text-muted">No one yet.</li>}
        </ul>
        {canManage && (
          <form onSubmit={add} className="flex flex-col gap-2" noValidate>
            <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
              Add
              <InfoTip label="About adding">An existing account, by its email. An admin makes accounts in Settings; SSO makes them on the first sign-in.</InfoTip>
            </span>
            <div className="flex gap-2">
              <input type="email" inputMode="email" autoComplete="off" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
              <button
                type="button"
                onClick={() => setRole((r) => (r === 'owner' ? 'member' : 'owner'))}
                className="press min-h-11 shrink-0 rounded-2xl border border-line px-3 text-[13px] font-semibold"
                aria-label={`Add as ${role === 'owner' ? 'owner' : 'member'}; tap to change`}
              >
                {role === 'owner' ? 'Owner' : 'Member'}
              </button>
              <Button type="submit" size="icon" loading={busy} disabled={!email.trim()} aria-label="Add to the team">
                <UserPlus className="size-[18px]" />
              </Button>
            </div>
          </form>
        )}
        {canManage && team && team.shares.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink-soft">Shared with the team</span>
            <ul className="divide-y divide-line rounded-2xl border border-line">
              {team.shares.map((s) => (
                <li key={s.id} className="flex min-h-11 flex-col justify-center px-3 py-1.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                    <Users className="size-4 shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{s.sessionTitle ?? 'A removed agent'}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1 pt-0.5">
                    {s.caps.map((c) => (
                      <Badge key={c} tone={c === 'read' ? 'neutral' : 'warning'}>
                        {CAP_LABEL[c]}
                      </Badge>
                    ))}
                    {endText(s) && <span className="text-[12px] text-muted">{endText(s)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
