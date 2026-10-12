import { FormDialog, Select, SwitchRow, TextField, useToast } from '@isnanme/ui';
import { CONNECT_LABEL_MAX, CONNECT_TOKEN_TTL_MINUTES, type ConnectSettings, type ConnectTargetRow, type ConnectTargetView, type UpdateConnectTargetRequest } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ApiError, errorText } from '@/lib/api';
import { connectApi } from './api';
import { isEnrolled } from './view';

const fieldErrors = (e: unknown): Record<string, string> => (e instanceof ApiError && e.details && typeof e.details === 'object' ? (e.details as Record<string, string>) : {});

/** One target's settings (the registry's Settings button). Sends only what changed. */
export function TargetSettingsDialog({ open, target, onClose, onSaved }: { open: boolean; target: ConnectTargetView; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const s = target.settings;
  const [label, setLabel] = useState(target.label);
  const [max, setMax] = useState('');
  const [storageClass, setStorageClass] = useState('');
  const [storage, setStorage] = useState('');
  const [image, setImage] = useState('');
  const [delivery, setDelivery] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const cluster = target.role === 'cluster';
  const k8s = target.kind === 'kubernetes';

  useEffect(() => {
    if (!open) return;
    setLabel(target.label);
    setMax(s.maxWorkspaces ? String(s.maxWorkspaces) : '');
    setStorageClass(s.storageClass ?? '');
    setStorage(s.storage ?? '');
    setImage(s.workspaceImage ?? '');
    // Singles start with delivery off (owner decision O5); a missing value reads as the role's default.
    setDelivery(s.delivery ?? cluster);
    setIsDefault(target.default);
    setErrors({});
    setFormError(null);
    // Reset when it opens, not when the live list refreshes underneath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target.id]);

  const submit = async () => {
    const body: UpdateConnectTargetRequest = {};
    const settings: NonNullable<UpdateConnectTargetRequest['settings']> = {};
    if (label.trim() !== target.label) body.label = label.trim();
    if (cluster && (max.trim() ? Number(max) : null) !== (s.maxWorkspaces ?? null)) settings.maxWorkspaces = max.trim() ? Number(max) : null;
    if (k8s && storageClass.trim() !== (s.storageClass ?? '')) settings.storageClass = storageClass.trim();
    if (k8s && storage.trim() !== (s.storage ?? '')) settings.storage = storage.trim();
    if (!k8s && image.trim() !== (s.workspaceImage ?? '')) settings.workspaceImage = image.trim();
    if (delivery !== (s.delivery ?? cluster)) settings.delivery = delivery;
    if (Object.keys(settings).length) body.settings = settings;
    if (cluster && isDefault !== target.default) body.default = isDefault;
    if (Object.keys(body).length === 0) return onClose();
    setSaving(true);
    setFormError(null);
    try {
      await connectApi.update(target.id, body);
      toast('Saved');
      onSaved();
      onClose();
    } catch (e) {
      setErrors(fieldErrors(e));
      setFormError(errorText(e, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={open} onClose={onClose} title="Settings" onSubmit={submit} submitLabel="Save" saving={saving} error={formError} dirty>
      <div className="flex flex-col gap-4">
        <TextField label="Label" value={label} maxLength={CONNECT_LABEL_MAX} onChange={(e) => setLabel(e.target.value)} error={errors.label} data-autofocus />
        {cluster && <TextField label="Max workspaces" optional inputMode="numeric" placeholder="No limit" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} error={errors.maxWorkspaces} />}
        {k8s && (
          <>
            <TextField label="Storage class" optional className="[&_input]:font-mono" autoCapitalize="none" spellCheck={false} value={storageClass} onChange={(e) => setStorageClass(e.target.value)} error={errors.storageClass} />
            <TextField label="Storage" optional placeholder="10Gi" className="[&_input]:font-mono" autoCapitalize="none" spellCheck={false} value={storage} onChange={(e) => setStorage(e.target.value)} error={errors.storage} />
          </>
        )}
        {!k8s && <TextField label="Image" optional placeholder={'Portal default'} className="[&_input]:font-mono" autoCapitalize="none" spellCheck={false} value={image} onChange={(e) => setImage(e.target.value)} error={errors.workspaceImage} />}
        <SwitchRow
          label={
            <span className="inline-flex items-center gap-1">
              Pools and secrets
              <InfoTip label="About delivery">Lets the portal put pools, secrets and the chat host into workspaces here. Off, delivery reads “unsupported”.</InfoTip>
            </span>
          }
          checked={delivery}
          onChange={setDelivery}
        />
        {cluster && <SwitchRow label="Default target" checked={isDefault} onChange={setIsDefault} />}
      </div>
    </FormDialog>
  );
}

/** Portal-wide: the address targets use, the token lifetime, the default target. */
export function PortalSettingsDialog({ open, rows, settings, onClose, onSaved }: { open: boolean; rows: ConnectTargetRow[]; settings: ConnectSettings | null; onClose: () => void; onSaved: (s: ConnectSettings) => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [ttl, setTtl] = useState('');
  const [def, setDef] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open || !settings) return;
    setUrl(settings.publicUrl ?? '');
    setTtl(String(settings.tokenTtlMinutes));
    setDef(settings.defaultTarget ?? '');
    setErrors({});
    setFormError(null);
  }, [open, settings]);
  if (!settings) return null;
  const locked = settings.publicUrlSource === 'env';
  const choices = rows.filter((r) => (isEnrolled(r) ? r.role === 'cluster' && r.link !== 'pending' : r.available && r.kind !== 'local')).map((r) => ({ value: r.id, label: r.label }));

  const submit = async () => {
    const ttlN = Number(ttl);
    if (!Number.isInteger(ttlN) || ttlN < 1 || ttlN > CONNECT_TOKEN_TTL_MINUTES.max) return setErrors({ tokenTtlMinutes: `1 to ${CONNECT_TOKEN_TTL_MINUTES.max} minutes.` });
    setSaving(true);
    setFormError(null);
    try {
      const next = await connectApi.saveSettings({
        ...(locked ? {} : { publicUrl: url.trim() || null }),
        tokenTtlMinutes: ttlN,
        defaultTarget: def || null,
      });
      toast('Saved');
      onSaved(next);
      onClose();
    } catch (e) {
      setErrors(fieldErrors(e));
      setFormError(errorText(e, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={open} onClose={onClose} title="Settings" onSubmit={submit} submitLabel="Save" saving={saving} error={formError} dirty>
      <div className="flex flex-col gap-4">
        <TextField
          label="Portal address"
          value={url}
          disabled={locked}
          placeholder={typeof location === 'undefined' ? '' : location.origin}
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          className="[&_input]:font-mono"
          onChange={(e) => setUrl(e.target.value)}
          error={errors.publicUrl}
          hint={locked ? 'Set by the server’s environment.' : undefined}
          data-autofocus
        />
        <TextField label="Token lifetime" suffix="min" inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value.replace(/\D/g, ''))} error={errors.tokenTtlMinutes} />
        <Select label="Default target" value={def} onChange={setDef} options={[{ value: '', label: 'None' }, ...choices]} error={errors.defaultTarget} />
      </div>
    </FormDialog>
  );
}
