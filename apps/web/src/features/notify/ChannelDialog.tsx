import { ChipGroup, FormDialog, SwitchRow, TextField } from '@isnanme/ui';
import type { CreatedChannel, DestinationType } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { errorText } from '@/lib/api';
import { InfoTip } from '@/components/InfoTip';
import { notifyApi } from './api';
import { defaultKinds } from './matrix';

type Kind = Exclude<DestinationType, 'push'>;
const NAMES: Record<Kind, string> = { webhook: 'Webhook', discord: 'Discord', slack: 'Slack' };

/** Add a webhook, Discord or Slack channel. The URL is a secret: the field does not remember it, and the portal never shows it again. */
export function ChannelDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: CreatedChannel) => void }) {
  const [type, setType] = useState<Kind>('webhook');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [signed, setSigned] = useState(true);
  const [priv, setPriv] = useState(false);
  const [detail, setDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    setType('webhook');
    setName('');
    setUrl('');
    setSigned(true);
    setPriv(false);
    setDetail(false);
    setError(null);
    setUrlError(undefined);
  }, [open]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    setUrlError(undefined);
    try {
      onCreated(
        await notifyApi.createChannel({
          type,
          name: name.trim(),
          url: url.trim(),
          kinds: defaultKinds(),
          includeDetail: detail,
          ...(type === 'webhook' ? { signed, allowPrivateNetwork: priv } : {}),
        }),
      );
    } catch (e) {
      const d = (e as { details?: Record<string, unknown> }).details;
      if (typeof d?.url === 'string') setUrlError(d.url);
      else setError(errorText(e, 'Could not add the channel.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={open} onClose={onClose} title="Add channel" onSubmit={submit} submitLabel="Add" saving={saving} error={error} submitDisabled={!name.trim() || !url.trim()} dirty={!!name.trim() || !!url.trim()}>
      <div className="flex flex-col gap-4">
        <ChipGroup label="Type" value={type} onChange={setType} options={(Object.keys(NAMES) as Kind[]).map((k) => ({ value: k, label: NAMES[k] }))} />
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" />
        <TextField label="Address" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} error={urlError} autoComplete="off" spellCheck={false} autoCapitalize="off" hint={type === 'webhook' ? 'https://…' : `Your ${NAMES[type]} incoming webhook address`} />
        {type === 'webhook' && (
          <>
            <SwitchRow label="Sign" description="Adds X-Pilot-Signature so the receiver can check it." checked={signed} onChange={setSigned} />
            <SwitchRow label="Private network" description="Allow an address on a private network. Metadata addresses stay refused." checked={priv} onChange={setPriv} />
          </>
        )}
        <SwitchRow
          label={
            <span className="inline-flex items-center gap-1.5">
              Include detail
              <InfoTip label="About include detail">Adds a short, redacted piece of the request. It comes from an agent or a workspace, so treat it as untrusted text.</InfoTip>
            </span>
          }
          checked={detail}
          onChange={setDetail}
        />
      </div>
    </FormDialog>
  );
}
