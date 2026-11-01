import { Button, ConfirmDialog, Dialog, Segmented, TextField, cn, useToast } from '@isnanme/ui';
import {
  ACCESS_LEVEL_INFO,
  type AccessLevel,
  type AccessObjectType,
  type ObjectAccess,
  type ObjectAccessEntry,
  type Org,
  type OrgMember,
  type OrgTeam,
} from '@portal/contracts';
import { ArrowLeft, Building2, Check, Globe, Plus, User, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { askableLevels, endText, exposesCredentials, LEVEL_LABEL, reasonText, subjectText, untilValue, type SubjectKind, type UntilKey } from './accessRules';
import { LevelCards, LevelPill, ReasonLine, UntilPicker } from './accessUi';
import { KIND_LABEL, orgErrorText } from './rules';
import { Alert } from './settingsUi';

type Mode = 'list' | 'who' | 'level' | 'until' | 'review' | 'ask';
type Pick = { kind: SubjectKind; id: string; name: string };

const STEP_OF: Partial<Record<Mode, string>> = { who: '1 of 3', level: '2 of 3', until: '3 of 3' };
const TITLE: Record<Mode, string> = { list: 'Access', who: 'Who', level: 'Level', until: 'Until', review: 'Review', ask: 'Request' };
const SUBJECT_ICON: Record<ObjectAccessEntry['subject']['kind'], typeof User> = { org_managers: Building2, org: Globe, team: Users, user: User };

/**
 * The Access sheet of one object (docs/prd/access.md §7): who can reach it and why, one-tap revoke, and the grant flow in three steps
 * (Who: everyone, a team or a person -> Level: cards with what each allows, the credentials warning on a workspace -> Until: no end, 7 or 30
 * days or a date, and a note), then Review -> Grant. Someone who may not grant sees their own access and may ask for more (an org-owned
 * object). The server decides every step (the ceiling, the policy); the choices it would refuse are not offered.
 */
export function AccessSheet({
  org,
  target,
  name,
  meId,
  open,
  onClose,
  onChanged,
}: {
  org: Org;
  target: { type: AccessObjectType; id: string };
  name: string;
  meId: string | null;
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<ObjectAccess | null>(null);
  const [hidden, setHidden] = useState(false);
  const [mode, setMode] = useState<Mode>('list');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [teams, setTeams] = useState<OrgTeam[] | null>(null);
  const [kind, setKind] = useState<SubjectKind>('user');
  const [query, setQuery] = useState('');
  const [pick, setPick] = useState<Pick | null>(null);
  const [level, setLevel] = useState<AccessLevel | null>(null);
  const [ack, setAck] = useState(false);
  const [until, setUntil] = useState<UntilKey>('none');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [revoking, setRevoking] = useState<ObjectAccessEntry | null>(null);
  const now = Date.now();

  const load = useCallback(async () => {
    try {
      setData(await api.orgs.objectAccess(org.id, target.type, target.id));
      setHidden(false);
    } catch (e) {
      // No view on it (the same 404 as a missing one): a member may still ask for an org object from the catalog.
      setData(null);
      setHidden(true);
      if ((e as { status?: number } | null)?.status !== 404) setError(orgErrorText(e, 'Couldn’t load the access.'));
    }
  }, [org.id, target.type, target.id]);

  useEffect(() => {
    if (!open) return;
    setMode('list');
    setError(null);
    setData(null);
    setHidden(false);
    void load();
  }, [open, load]);

  const reset = () => {
    setKind('user');
    setQuery('');
    setPick(null);
    setLevel(null);
    setAck(false);
    setUntil(data?.maxUntil ? '7d' : 'none');
    setDate('');
    setNote('');
    setError(null);
  };

  const startGrant = () => {
    reset();
    setMode('who');
    if (!members) api.orgs.members(org.id).then(setMembers, () => setMembers([]));
    if (!teams) api.orgs.teams(org.id).then(setTeams, () => setTeams([]));
  };

  const startAsk = () => {
    reset();
    setMode('ask');
  };

  const choices = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (kind === 'org') return [{ kind: 'org' as const, id: org.id, name: `Everyone in ${org.name}` }];
    if (kind === 'team') return (teams ?? []).filter((t) => !q || t.name.toLowerCase().includes(q)).map((t) => ({ kind: 'team' as const, id: t.id, name: t.name }));
    return (members ?? [])
      .filter((m) => m.userId !== meId && (!q || m.displayName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)))
      .map((m) => ({ kind: 'user' as const, id: m.userId, name: m.displayName, sub: m.role === 'guest' ? 'Guest' : m.email }));
  }, [kind, query, teams, members, meId, org.id, org.name]);

  const expiresAt = untilValue(until, date, now, data?.maxUntil ?? null);
  const needsAck = !!data && exposesCredentials(target.type, level, data.credentials.length);

  const grant = async () => {
    if (!pick || !level || expiresAt === 'invalid') return;
    setBusy(true);
    setError(null);
    try {
      await api.orgs.share(org.id, {
        target,
        subject: pick.kind === 'org' ? { kind: 'org' } : pick.kind === 'team' ? { kind: 'team', teamId: pick.id } : { kind: 'user', userId: pick.id },
        level,
        expiresAt,
        note: note.trim() || null,
        acknowledgeExposure: needsAck ? ack : undefined,
      });
      toast(`${pick.kind === 'org' ? 'Everyone' : pick.name} can ${LEVEL_LABEL[level].toLowerCase()}`);
      setMode('list');
      await load();
      onChanged?.();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t give access.'));
    } finally {
      setBusy(false);
    }
  };

  const ask = async () => {
    if (!level) return;
    setBusy(true);
    setError(null);
    try {
      await api.orgs.requestAccess(org.id, { target, level, note: note.trim() || null });
      toast('Request sent');
      setMode('list');
      await load();
      onChanged?.();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t send the request.'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    const r = revoking;
    setRevoking(null);
    if (!r || r.reason.kind !== 'share') return;
    setError(null);
    try {
      await api.orgs.revokeShare(org.id, r.reason.share.id);
      toast('Access ended');
      await load();
      onChanged?.();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t end it.'));
    }
  };

  const cancelRequest = async () => {
    if (!data?.openRequest) return;
    try {
      await api.orgs.cancelAccessRequest(org.id, data.openRequest.id);
      toast('Request cancelled');
      await load();
      onChanged?.();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t cancel it.'));
    }
  };

  const back = () => setMode(mode === 'who' || mode === 'ask' ? 'list' : mode === 'level' ? 'who' : mode === 'until' ? 'level' : 'until');
  const myLevel = data?.myLevel ?? 'none';
  const orgObject = hidden || data?.owner.kind === 'org';
  const canAsk = org.myRole !== 'guest' && orgObject && askableLevels(myLevel).length > 0 && !data?.openRequest;
  const mayGrant = (data?.mayGrant.length ?? 0) > 0;

  const footer =
    mode === 'list' ? (
      mayGrant ? (
        <Button icon={<Plus className="size-4" />} onClick={startGrant} data-access-add="">
          Give access
        </Button>
      ) : canAsk ? (
        <Button variant="secondary" onClick={startAsk} data-access-ask="">
          Request access
        </Button>
      ) : undefined
    ) : mode === 'who' ? (
      <Button disabled={!pick} onClick={() => setMode('level')} data-access-next="">
        Next
      </Button>
    ) : mode === 'level' ? (
      <Button disabled={!level || (needsAck && !ack)} onClick={() => setMode('until')} data-access-next="">
        Next
      </Button>
    ) : mode === 'until' ? (
      <Button disabled={expiresAt === 'invalid'} onClick={() => setMode('review')} data-access-next="">
        Review
      </Button>
    ) : mode === 'review' ? (
      <Button loading={busy} icon={<Check className="size-4" />} onClick={() => void grant()} data-access-grant="">
        Grant
      </Button>
    ) : (
      <Button loading={busy} disabled={!level} onClick={() => void ask()} data-access-send="">
        Send request
      </Button>
    );

  const leading =
    mode === 'list' ? undefined : (
      <Button variant="ghost" size="icon" aria-label="Back" onClick={back} data-access-back="">
        <ArrowLeft className="size-[18px]" />
      </Button>
    );

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={mode === 'list' ? name : TITLE[mode]}
        description={mode === 'list' ? KIND_LABEL[target.type] : STEP_OF[mode]}
        stepKey={mode}
        leading={leading}
        footer={footer}
      >
        <div data-access-sheet={mode} className="flex flex-col gap-3">
          <Alert text={error} />
          {mode === 'list' && (
            <>
              {!data && !hidden && <div className="skeleton h-24 rounded-xl" aria-busy="true" />}
              {(data || hidden) && (
                <div data-access-mine="" className="flex min-h-12 items-center gap-3 rounded-2xl bg-surface-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-muted">You</span>
                    <ReasonLine reasons={data?.mine ?? []} now={now} />
                  </span>
                  <LevelPill level={myLevel} />
                </div>
              )}
              {data?.openRequest && (
                <div data-access-open-request="" className="flex min-h-12 items-center gap-3 rounded-2xl border border-line px-3 py-2">
                  <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">Asked for {LEVEL_LABEL[data.openRequest.level]}</span>
                  <Button variant="ghost" onClick={() => void cancelRequest()}>
                    Cancel
                  </Button>
                </div>
              )}
              {data && data.entries.length > 0 && (
                <ul data-access-entries="" className="-mx-2 flex flex-col">
                  {data.entries.map((e, i) => {
                    const Icon = SUBJECT_ICON[e.subject.kind];
                    const share = e.reason.kind === 'share' ? e.reason.share : null;
                    const end = share ? endText(share.expiresAt, now) : null;
                    return (
                      <li key={`${e.subject.kind}:${e.subject.id}:${i}`} data-access-entry={e.subject.kind} className="flex min-h-14 items-center gap-3 px-2 py-1">
                        <Icon className="size-[18px] shrink-0 text-muted" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium [overflow-wrap:anywhere]">{subjectText(e.subject)}</span>
                          <span className="block text-[12.5px] [overflow-wrap:anywhere] text-muted">
                            {[e.reason.kind === 'share' ? null : reasonText(e.reason), end, share?.note].filter(Boolean).join(' · ') || 'Shared'}
                          </span>
                        </span>
                        <LevelPill level={e.level} />
                        {e.reason.kind === 'share' && e.reason.revocable && (
                          <Button variant="ghost" size="icon" aria-label={`End access of ${subjectText(e.subject)}`} onClick={() => setRevoking(e)} data-access-revoke="">
                            <X className="size-[18px]" />
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {mode === 'who' && (
            <>
              <Segmented<SubjectKind>
                label="Who"
                value={kind}
                options={[
                  { value: 'user', label: 'Person' },
                  { value: 'team', label: 'Team' },
                  { value: 'org', label: 'Everyone' },
                ]}
                onChange={(k) => {
                  setKind(k);
                  setPick(k === 'org' ? { kind: 'org', id: org.id, name: `Everyone in ${org.name}` } : null);
                  setQuery('');
                }}
              />
              {kind !== 'org' && <TextField label="Search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={kind === 'team' ? 'Team name' : 'Name or email'} />}
              {(kind === 'team' ? teams : kind === 'user' ? members : []) === null ? (
                <div className="skeleton h-24 rounded-xl" aria-busy="true" />
              ) : choices.length === 0 ? (
                <p className="text-sm text-muted">No match.</p>
              ) : (
                <ul role="radiogroup" aria-label="Who" data-access-who="" className="-mx-2 flex flex-col">
                  {choices.map((c) => {
                    const on = pick?.kind === c.kind && pick.id === c.id;
                    const Icon = c.kind === 'org' ? Globe : c.kind === 'team' ? Users : User;
                    return (
                      <li key={`${c.kind}:${c.id}`}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => setPick({ kind: c.kind, id: c.id, name: c.name })}
                          className={cn(
                            'press flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-accent',
                            on && 'bg-accent/10',
                          )}
                        >
                          <Icon className="size-[18px] shrink-0 text-muted" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium [overflow-wrap:anywhere]">{c.name}</span>
                            {'sub' in c && c.sub && <span className="block text-[12.5px] [overflow-wrap:anywhere] text-muted">{c.sub}</span>}
                          </span>
                          {on && <Check className="size-4 shrink-0 text-accent" aria-hidden />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {mode === 'level' && data && (
            <LevelCards type={target.type} mayGrant={data.mayGrant} subject={pick?.kind ?? null} value={level} onChange={setLevel} credentials={data.credentials} ack={ack} onAck={setAck} />
          )}

          {mode === 'until' && data && (
            <UntilPicker maxUntil={data.maxUntil} now={now} until={until} onUntil={setUntil} date={date} onDate={setDate} note={note} onNote={setNote} />
          )}

          {mode === 'review' && pick && level && expiresAt !== 'invalid' && (
            <dl data-access-review="" className="flex flex-col divide-y divide-line rounded-2xl border border-line">
              {[
                ['What', name],
                ['Who', pick.name],
                ['Level', `${ACCESS_LEVEL_INFO[target.type][level].label} · ${ACCESS_LEVEL_INFO[target.type][level].short}`],
                ['Until', expiresAt ? new Date(expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'No end'],
                ...(note.trim() ? [['Note', note.trim()]] : []),
              ].map(([k, v]) => (
                <div key={k} className="flex min-h-12 items-center gap-3 px-3 py-2">
                  <dt className="w-14 shrink-0 text-[13px] font-semibold text-muted">{k}</dt>
                  <dd className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{v}</dd>
                </div>
              ))}
            </dl>
          )}

          {mode === 'ask' && (
            <>
              <LevelCards type={target.type} mayGrant={askableLevels(myLevel)} subject={null} value={level} onChange={setLevel} credentials={[]} ack={false} onAck={() => undefined} />
              <TextField label="Note" optional value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Why" />
            </>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!revoking}
        title="End access?"
        description={revoking ? `${subjectText(revoking.subject)} loses this access at once.` : ''}
        confirmLabel="End"
        onConfirm={() => void revoke()}
        onClose={() => setRevoking(null)}
      />
    </>
  );
}
