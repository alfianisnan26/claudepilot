import { FormDialog, SwitchRow, TextField, useToast } from '@isnanme/ui';
import type { NotifyDestination } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { notifyApi } from './api';
import { loadNotifyOverview } from './store';

/** Rename a destination and set its switches. The address of a channel cannot be edited: make a new channel. */
export function EditDialog({ destination, onClose }: { destination: NotifyDestination | null; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [shared, setShared] = useState(false);
  const [detail, setDetail] = useState(false);
  const [priv, setPriv] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!destination) return;
    setName(destination.name);
    setEnabled(destination.enabled);
    setShared(destination.includeShared);
    setDetail(destination.includeDetail);
    setPriv(destination.allowPrivateNetwork);
    setError(null);
  }, [destination]);

  const dirty = !!destination && (name !== destination.name || enabled !== destination.enabled || shared !== destination.includeShared || detail !== destination.includeDetail || priv !== destination.allowPrivateNetwork);

  const submit = async () => {
    if (!destination) return;
    setSaving(true);
    setError(null);
    try {
      await notifyApi.update(destination.id, { name: name.trim(), enabled, includeShared: shared, includeDetail: detail, ...(destination.type === 'webhook' ? { allowPrivateNetwork: priv } : {}) });
      await loadNotifyOverview();
      toast('Saved');
      onClose();
    } catch (e) {
      setError(errorText(e, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={!!destination} onClose={onClose} title="Edit" onSubmit={submit} saving={saving} error={error} submitDisabled={!name.trim() || !dirty} dirty={dirty}>
      <div className="flex flex-col gap-4">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" />
        <SwitchRow label="On" description={destination?.state === 'ok' ? undefined : 'Turn it on to try again after failures.'} checked={enabled} onChange={setEnabled} />
        <SwitchRow
          label={
            <span className="inline-flex items-center gap-1.5">
              Also shared with me
              <InfoTip label="About also shared with me">Also hear of agents other people shared with you. Off: only what you own.</InfoTip>
            </span>
          }
          checked={shared}
          onChange={setShared}
        />
        <SwitchRow
          label={
            <span className="inline-flex items-center gap-1.5">
              Include detail
              <InfoTip label="About include detail">Adds a short, redacted piece of the request, which is needed to allow from a notification. It comes from an agent or a workspace, so treat it as untrusted text.</InfoTip>
            </span>
          }
          checked={detail}
          onChange={setDetail}
        />
        {destination?.type === 'webhook' && <SwitchRow label="Private network" description="Allow an address on a private network. Metadata addresses stay refused." checked={priv} onChange={setPriv} />}
      </div>
    </FormDialog>
  );
}
