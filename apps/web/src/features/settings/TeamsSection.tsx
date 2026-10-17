import { Button, ConfirmDialog, Dialog, useToast } from '@isnanme/ui';
import { PORTAL_TEAM_LIMITS, type PortalTeam } from '@portal/contracts';
import { Plus, Trash2, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { TeamDialog } from '@/features/auth/TeamDialog';
import { api, errorText } from '@/lib/api';

const field = 'h-12 w-full rounded-2xl border border-line bg-surface px-4 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** Teams (owner, 2026-10-17: "team based multiaccount"): groups of accounts a session can be shared with. Owners of a team manage its people. */
export function TeamsSection() {
  const toast = useToast();
  const [teams, setTeams] = useState<PortalTeam[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PortalTeam | null>(null);
  const [meId, setMeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTeams(await api.teams());
    } catch (e) {
      toast(errorText(e, 'Couldn’t load the teams.'), 'error');
    }
  }, [toast]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    void api.me().then((m) => setMeId(m.kind === 'account' ? m.user.id : null), () => undefined);
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const t = await api.createTeam({ name: name.trim(), description: description.trim() || null });
      toast('Team added');
      setAdding(false);
      setName('');
      setDescription('');
      await load();
      setOpenId(t.id);
    } catch (err) {
      toast(errorText(err, 'Couldn’t add it.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const t = removing;
    setRemoving(null);
    if (!t) return;
    try {
      await api.removeTeam(t.id);
      toast('Team removed');
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t remove it.'), 'error');
    }
  };

  return (
    <section aria-labelledby="settings-teams" data-settings-teams="">
      <div className="mb-2 flex items-center gap-1 px-1">
        <h2 id="settings-teams" className="flex flex-1 items-center gap-1 text-[13px] font-semibold text-muted">
          Teams
          <InfoTip label="About teams">Groups of accounts. Share a session with a team and everyone in it gets that access while they are in it. A team’s owners add and remove its people.</InfoTip>
        </h2>
        <Button variant="ghost" size="icon" aria-label="Add a team" onClick={() => setAdding(true)}>
          <Plus className="size-[18px]" />
        </Button>
      </div>
      <Card>
        {teams === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : teams.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">No teams.</p>
        ) : (
          <ul className="divide-y divide-line">
            {teams.map((t) => (
              <li key={t.id} className="flex min-h-14 items-center gap-2 px-4 py-2 sm:px-5">
                <button type="button" onClick={() => setOpenId(t.id)} className="press flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left">
                  <Users className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{t.name}</span>
                    <span className="block truncate text-[12.5px] text-muted">
                      {t.members} {t.members === 1 ? 'person' : 'people'}
                      {t.description ? ` · ${t.description}` : ''}
                    </span>
                  </span>
                </button>
                <Button variant="ghost" size="icon" aria-label={`Remove ${t.name}`} onClick={() => setRemoving(t)}>
                  <Trash2 className="size-[18px]" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add team" size="sm">
        <form onSubmit={create} className="flex flex-col gap-3" noValidate>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink-soft">Name</span>
            <input type="text" autoComplete="off" maxLength={PORTAL_TEAM_LIMITS.nameMax} value={name} onChange={(e) => setName(e.target.value)} className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink-soft">Description</span>
            <input type="text" autoComplete="off" maxLength={PORTAL_TEAM_LIMITS.descriptionMax} value={description} onChange={(e) => setDescription(e.target.value)} className={field} />
          </label>
          <Button type="submit" size="lg" loading={busy} disabled={!name.trim()} className="mt-1 w-full">
            Add team
          </Button>
        </form>
      </Dialog>
      <TeamDialog teamId={openId} manage meId={meId} open={!!openId} onClose={() => setOpenId(null)} onChanged={() => void load()} />
      <ConfirmDialog
        open={!!removing}
        title="Remove team?"
        description={removing ? `${removing.name} and everything shared with it are removed.` : ''}
        confirmLabel="Remove"
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </section>
  );
}
