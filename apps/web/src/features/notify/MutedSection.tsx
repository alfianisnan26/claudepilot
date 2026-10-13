import { Button, ChipGroup, ConfirmDialog, FormDialog, Section, Select, TextField, useToast } from '@isnanme/ui';
import { isMuteGuarded, MUTE_DURATIONS, NOTIFY_KIND_INFO, type MuteDuration, type MuteScopeType, type NotifyDestination, type NotifyKind, type NotifyMute } from '@portal/contracts';
import { BellOff, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { notifyApi } from './api';
import { ClampedText } from './ClampedText';
import { MATRIX_KINDS } from './matrix';
import { Titled } from './Titled';
import { DURATION_LABEL, expiryText, HAND_SCOPES, hushedText, MUTE_SCOPE_LABEL, muteLine, muteWhere, SCOPE_HINT } from './mutes';

const GUARD_WHY = 'Approvals stop a session until somebody answers, and a deploy waits for a person. Muting them can leave work stuck with nobody told.';

/** Settings > Muted: the person's rules in words, what each hushed and when it ends; remove one, add one by hand, Unmute all. */
export function MutedSection({ destinations }: { destinations: NotifyDestination[] }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [rules, setRules] = useState<NotifyMute[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRules(await notifyApi.mutes());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLive('notify', () => void load());

  const remove = async (m: NotifyMute) => {
    try {
      await notifyApi.unmute(m.id);
      setRules((cur) => cur?.filter((x) => x.id !== m.id) ?? cur);
      toast('Unmuted');
    } catch (e) {
      toast(errorText(e, 'Could not remove it.'), 'error');
    }
  };
  const clear = async () => {
    setBusy(true);
    try {
      await notifyApi.unmuteAll();
      setRules([]);
      toast('Unmuted all');
    } catch (e) {
      toast(errorText(e, 'Could not remove them.'), 'error');
    } finally {
      setBusy(false);
      setClearing(false);
    }
  };

  return (
    <Section
      title={<Titled title="Muted">Muted notifications are still kept in the Inbox (under Muted), but they do not buzz, toast or push. Mute one from its ⋯ in the Inbox or the Mute button on a phone notification, or add a rule here.</Titled>}
      visibleTitle
      action={
        <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
          Add
        </Button>
      }
    >
      {!rules ? (
        <p className="px-1 text-[13.5px] text-muted">{failed ? 'Could not load the rules.' : 'Loading…'}</p>
      ) : rules.length === 0 ? (
        <p className="px-1 text-[13.5px] text-muted">Nothing muted.</p>
      ) : (
        <>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {rules.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2 pr-1 pl-4">
                <BellOff className="size-5 shrink-0 text-ink-soft" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    <ClampedText>{muteLine(m)}</ClampedText>
                  </div>
                  <p className="text-[13px] break-words text-muted">
                    {muteWhere(m, destinations)} · {expiryText(m.expiresAt)} · {hushedText(m.hushed)} · <time dateTime={m.createdAt}>{timeAgo(m.createdAt)}</time>
                  </p>
                </div>
                <Button variant="ghost" aria-label={`Unmute ${muteLine(m)}`} className="size-11 shrink-0 p-0" onClick={() => void remove(m)}>
                  <X className="size-5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setClearing(true)}>
              Unmute all
            </Button>
          </div>
        </>
      )}
      <AddMuteDialog open={adding} destinations={destinations} onClose={() => setAdding(false)} onAdded={(m) => setRules((cur) => [m, ...(cur ?? [])])} />
      <ConfirmDialog open={clearing} title="Unmute all" description="Every rule goes; everything is delivered again." confirmLabel="Unmute all" loading={busy} onConfirm={() => void clear()} onClose={() => setClearing(false)} />
    </Section>
  );
}

function AddMuteDialog({ open, destinations, onClose, onAdded }: { open: boolean; destinations: NotifyDestination[]; onClose: () => void; onAdded: (m: NotifyMute) => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<NotifyKind>('ci_failed');
  const [scopeType, setScopeType] = useState<MuteScopeType | ''>('');
  const [scopeId, setScopeId] = useState('');
  const [dest, setDest] = useState('');
  const [duration, setDuration] = useState<MuteDuration>('forever');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind('ci_failed');
    setScopeType('');
    setScopeId('');
    setDest('');
    setDuration('forever');
    setError(null);
  }, [open]);

  const guarded = isMuteGuarded(kind);
  const save = async (confirm: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const m = await notifyApi.mute({ kind, scope: scopeType ? { type: scopeType, id: scopeId.trim() } : null, destinationId: dest || null, duration, ...(confirm ? { confirm: true } : {}) });
      onAdded(m);
      toast('Muted');
      onClose();
    } catch (e) {
      setError(errorText(e, 'Could not add it.'));
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };
  const submit = () => (guarded ? setConfirming(true) : save(false));

  return (
    <>
      <FormDialog open={open} onClose={onClose} title="Mute" onSubmit={submit} submitLabel="Mute" saving={saving} error={error} submitDisabled={!!scopeType && !scopeId.trim()}>
        <div className="flex flex-col gap-4">
          <div className="flex items-end gap-1.5">
            <Select className="min-w-0 flex-1" label="Kind" value={kind} onChange={(v) => setKind(v as NotifyKind)} options={MATRIX_KINDS.map((k) => ({ value: k, label: NOTIFY_KIND_INFO[k].label }))} />
            {guarded && (
              <InfoTip label="Why this asks first" className="mb-3">
                {GUARD_WHY}
              </InfoTip>
            )}
          </div>
          <Select label="Only for" value={scopeType} onChange={(v) => setScopeType(v as MuteScopeType | '')} options={[{ value: '', label: 'Any' }, ...HAND_SCOPES.map((t) => ({ value: t, label: MUTE_SCOPE_LABEL[t] }))]} />
          {scopeType && <TextField label={MUTE_SCOPE_LABEL[scopeType]} value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder={SCOPE_HINT[scopeType]} maxLength={200} autoComplete="off" />}
          <Select label="Where" value={dest} onChange={setDest} options={[{ value: '', label: 'Everywhere' }, ...destinations.map((d) => ({ value: d.id, label: d.name }))]} />
          <ChipGroup label="For" value={duration} onChange={setDuration} options={MUTE_DURATIONS.map((d) => ({ value: d, label: DURATION_LABEL[d] }))} />
        </div>
      </FormDialog>
      <ConfirmDialog open={confirming} title={`Mute ${NOTIFY_KIND_INFO[kind].label}?`} description={GUARD_WHY} confirmLabel="Mute anyway" loading={saving} onConfirm={() => void save(true)} onClose={() => setConfirming(false)} />
    </>
  );
}
