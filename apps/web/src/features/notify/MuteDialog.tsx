import { ChipGroup, FormDialog, useToast } from '@isnanme/ui';
import { MUTE_DURATIONS, NOTIFY_KIND_INFO, type MuteDuration, type MuteOffer } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { errorText } from '@/lib/api';
import { notifyApi } from './api';
import { ClampedText } from './ClampedText';
import { DURATION_LABEL } from './mutes';

/**
 * "Mute similar" for one notification (an Inbox item `nh_…`, or an event `evt_…` from a push's Mute button): this subject (the
 * narrowest the event has) or all of its kind, for an hour, a day or for good. Approvals and deploy waits are muted in Settings only.
 */
export function MuteDialog({ muteRef, onClose, onMuted }: { muteRef: string | null; onClose: () => void; onMuted?: () => void }) {
  const toast = useToast();
  const [offer, setOffer] = useState<MuteOffer | null>(null);
  const [wide, setWide] = useState<'this' | 'all'>('this');
  const [duration, setDuration] = useState<MuteDuration>('1d');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOffer(null);
    setError(null);
    setWide('this');
    setDuration('1d');
    if (!muteRef) return;
    let live = true;
    notifyApi.muteOffer(muteRef).then(
      (o) => live && (setOffer(o), setWide(o.scope ? 'this' : 'all')),
      (e) => live && setError(errorText(e, 'Could not load that notification.')),
    );
    return () => void (live = false);
  }, [muteRef]);

  const submit = async () => {
    if (!muteRef || !offer || offer.guarded) return;
    setSaving(true);
    setError(null);
    try {
      await notifyApi.mute({ from: muteRef, wide: wide === 'all', duration });
      toast('Muted');
      onMuted?.();
      onClose();
    } catch (e) {
      setError(errorText(e, 'Could not mute it.'));
    } finally {
      setSaving(false);
    }
  };

  const kind = offer ? NOTIFY_KIND_INFO[offer.kind].label : '';
  return (
    <FormDialog open={!!muteRef} onClose={onClose} title="Mute similar" description={offer ? kind : undefined} onSubmit={submit} submitLabel="Mute" saving={saving} error={error} submitDisabled={!offer || offer.guarded} size="sm">
      {offer?.guarded ? (
        <p className="text-[13.5px] text-muted">{kind} block work until somebody answers, so they are muted in Setup only.</p>
      ) : offer ? (
        <div className="flex flex-col gap-4">
          <ChipGroup
            label="Which"
            stacked
            value={wide}
            onChange={setWide}
            options={[
              ...(offer.scope ? [{ value: 'this' as const, label: <ClampedText>{offer.scope.label}</ClampedText> }] : []),
              { value: 'all' as const, label: `All ${kind}` },
            ]}
          />
          <ChipGroup label="For" value={duration} onChange={setDuration} options={MUTE_DURATIONS.map((d) => ({ value: d, label: DURATION_LABEL[d] }))} />
        </div>
      ) : (
        !error && <div className="h-24" aria-busy="true" />
      )}
    </FormDialog>
  );
}
