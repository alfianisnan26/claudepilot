import { Badge, Button, Dialog, useToast } from '@isnanme/ui';
import {
  SESSION_SHARE_CAPS,
  SESSION_SHARE_PRESETS,
  type PortalTeam,
  type PortalUser,
  type SessionShare,
  type SessionShareCap,
  type ShareSubjectRef,
} from '@portal/contracts';
import { ShieldAlert, Trash2, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { api, errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';

/** Short names for each permission (the InfoTip says what they mean). */
export const CAP_LABEL: Record<SessionShareCap, string> = { read: 'Read', send: 'Send', respond: 'Approve', stop: 'Stop' };
const ENDS = [
  { label: 'Never', days: 0 },
  { label: '1 day', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
] as const;

/** `in 3 days`, `ended`, or nothing for a share without an end. */
export function endText(s: { expiresAt: string | null; expired?: boolean }): string | null {
  if (!s.expiresAt) return null;
  if (s.expired || Date.parse(s.expiresAt) <= Date.now()) return 'ended';
  return `ends ${timeAgo(s.expiresAt)}`;
}

/**
 * Share ONE session (owner, 2026-10-17: "delegate the session ... instead delegating full workspace", then "lebih granular dan
 * controllable"): with an account or a team, choosing what they may do (read always; send, approve, stop each on their own) and until when.
 * Never the terminal, files, other sessions, Bypass, model or end. Sending or approving in a Bypass session means running anything in the
 * workspace: the owner ticks that on the record (the server asks for it).
 */
export function ShareSessionDialog({ sessionId, bypass, open, onClose }: { sessionId: string; bypass: boolean; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [teams, setTeams] = useState<PortalTeam[]>([]);
  const [shares, setShares] = useState<SessionShare[]>([]);
  const [pick, setPick] = useState('');
  const [caps, setCaps] = useState<SessionShareCap[]>(SESSION_SHARE_PRESETS.view);
  const [days, setDays] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const acts = caps.includes('send') || caps.includes('respond');
  const needsAck = acts && bypass;

  const load = useCallback(async () => {
    try {
      const [u, t, g] = await Promise.all([api.users(), api.teams(), api.sessionGrants(sessionId)]);
      setUsers(u.filter((x) => x.state === 'active'));
      setTeams(t);
      setShares(g);
    } catch (e) {
      toast(errorText(e, 'Couldn’t load the shares.'), 'error');
    }
  }, [sessionId, toast]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const subjectOf = (v: string): ShareSubjectRef | null => {
    const [kind, id] = v.split(':', 2) as [string, string];
    return kind === 'user' || kind === 'team' ? { kind, id } : null;
  };

  const share = async () => {
    const subject = subjectOf(pick);
    if (!subject) return;
    setBusy(true);
    try {
      await api.shareSession(sessionId, {
        subject,
        caps,
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
        acknowledgeBypass: needsAck && ack,
      });
      toast('Shared');
      setPick('');
      setAck(false);
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t share it.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (s: SessionShare) => {
    try {
      await api.revokeShare(s.id);
      toast('Access removed');
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t remove it.'), 'error');
    }
  };
  const edit = (s: SessionShare) => {
    setPick(`${s.subject.kind}:${s.subject.id}`);
    setCaps(s.caps);
    setDays(0);
  };
  const toggle = (c: SessionShareCap) => {
    if (c === 'read') return;
    setCaps((cur) => SESSION_SHARE_CAPS.filter((x) => (x === c ? !cur.includes(c) : cur.includes(x))));
  };

  return (
    <Dialog open={open} onClose={onClose} title="Share session" size="sm">
      <div className="flex flex-col gap-3" data-share-session="">
        {shares.length > 0 && (
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {shares.map((s) => (
              <li key={s.id} className="flex min-h-11 items-center gap-2 px-3 py-1.5">
                <button type="button" onClick={() => edit(s)} className="press flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center text-left" aria-label={`Change ${s.subjectName}`}>
                  <span className="flex w-full min-w-0 items-center gap-1.5 text-sm font-medium">
                    {s.subject.kind === 'team' && <Users className="size-4 shrink-0 text-muted" aria-hidden="true" />}
                    <span className="truncate">{s.subjectName}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1 pt-0.5">
                    {s.caps.map((c) => (
                      <Badge key={c} tone={c === 'read' ? 'neutral' : 'warning'}>
                        {CAP_LABEL[c]}
                      </Badge>
                    ))}
                    {endText(s) && <span className={`text-[12px] ${s.expired ? 'text-danger' : 'text-muted'}`}>{endText(s)}</span>}
                  </span>
                </button>
                <button type="button" onClick={() => void revoke(s)} aria-label={`Remove ${s.subjectName}`} className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-danger-soft hover:text-danger">
                  <Trash2 className="size-[18px]" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-ink-soft">With</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-12 w-full rounded-2xl border border-line bg-surface px-3 text-[15px]">
            <option value="">Choose…</option>
            {teams.length > 0 && (
              <optgroup label="Teams">
                {teams.map((t) => (
                  <option key={t.id} value={`team:${t.id}`}>
                    {t.name} ({t.members})
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Accounts">
              {users.map((u) => (
                <option key={u.id} value={`user:${u.id}`}>
                  {u.email}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <fieldset>
          <legend className="mb-1.5 flex items-center gap-1 text-sm font-semibold text-ink-soft">
            Can
            <InfoTip label="About permissions">
              Read: see this session live. Send: write to it. Approve: answer its approval requests. Stop: stop a running turn. Nothing else of the workspace.
            </InfoTip>
          </legend>
          <div className="grid grid-cols-4 gap-1.5">
            {SESSION_SHARE_CAPS.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={caps.includes(c)}
                disabled={c === 'read'}
                onClick={() => toggle(c)}
                className={`press min-h-11 rounded-2xl border px-1 text-[13px] font-semibold disabled:opacity-80 ${caps.includes(c) ? 'border-accent bg-accent-soft text-ink' : 'border-line text-ink-soft'}`}
              >
                {CAP_LABEL[c]}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-sm font-semibold text-ink-soft">Ends</legend>
          <div className="grid grid-cols-4 gap-1.5">
            {ENDS.map((e) => (
              <button
                key={e.days}
                type="button"
                aria-pressed={days === e.days}
                onClick={() => setDays(e.days)}
                className={`press min-h-11 rounded-2xl border px-1 text-[13px] font-semibold ${days === e.days ? 'border-accent bg-accent-soft text-ink' : 'border-line text-ink-soft'}`}
              >
                {e.label}
              </button>
            ))}
          </div>
        </fieldset>
        {needsAck && (
          <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-current" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <ShieldAlert className="mr-1 inline size-4 align-[-3px]" aria-hidden="true" />
              Bypass: they can make the agent run any command in its workspace. I accept that.
            </span>
          </label>
        )}
        <Button size="lg" loading={busy} disabled={!pick || (needsAck && !ack)} onClick={() => void share()} className="w-full">
          Share
        </Button>
      </div>
    </Dialog>
  );
}
