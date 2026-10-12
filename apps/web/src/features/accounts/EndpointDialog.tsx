import { Button, FormDialog, SwitchRow, TextField } from '@isnanme/ui';
import type { Endpoint, EndpointRequest, ModelNames } from '@portal/contracts';
import { ChevronDown, Download } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { api, ApiError, errorText } from '@/lib/api';

const SLOTS: { key: keyof ModelNames; label: string }[] = [
  { key: 'default', label: 'Default model' },
  { key: 'opus', label: 'Opus slot' },
  { key: 'sonnet', label: 'Sonnet slot' },
  { key: 'haiku', label: 'Haiku slot' },
];

/** Add or edit a custom Anthropic-compatible host (Account Pool PRD FR1). */
export function EndpointDialog({
  open,
  endpoint,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Null to add a new host. */
  endpoint: Endpoint | null;
  onClose: () => void;
  onSaved: (endpoint: Endpoint) => void;
}) {
  const listId = useId();
  const [form, setForm] = useState<EndpointRequest>({ name: '', baseUrl: '' });
  const [models, setModels] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(
      endpoint
        ? {
            name: endpoint.name,
            baseUrl: endpoint.baseUrl,
            modelNames: endpoint.modelNames,
            contextTokens: endpoint.contextTokens,
            maxOutputTokens: endpoint.maxOutputTokens,
            disableBetas: endpoint.disableBetas,
            allowPrivateNetwork: endpoint.allowPrivateNetwork,
          }
        : { name: '', baseUrl: '', modelNames: {}, disableBetas: false, allowPrivateNetwork: false },
    );
    setModels([]);
    setErrors({});
    setFormError(null);
  }, [open, endpoint]);

  const set = <K extends keyof EndpointRequest>(k: K, v: EndpointRequest[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors(({ [k]: _, ...r }) => r);
  };
  const setSlot = (slot: keyof ModelNames, v: string) => setForm((f) => ({ ...f, modelNames: { ...f.modelNames, [slot]: v } }));

  const importModels = async () => {
    if (!endpoint) return;
    setImporting(true);
    try {
      setModels(await api.accounts.endpointModels(endpoint.id));
    } catch (e) {
      setFormError(errorText(e, 'Could not read the host’s models.'));
    } finally {
      setImporting(false);
    }
  };

  const submit = async () => {
    setSaving(true);
    setFormError(null);
    const tokens = (v: unknown) => (v === '' || v === undefined || v === null ? null : Number(v));
    const body = { ...form, contextTokens: tokens(form.contextTokens), maxOutputTokens: tokens(form.maxOutputTokens) };
    try {
      onSaved(endpoint ? await api.accounts.updateEndpoint(endpoint.id, body) : await api.accounts.createEndpoint(body));
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === 'object') setErrors(e.details as Record<string, string>);
      setFormError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-1.5">
          {endpoint ? 'Edit host' : 'Add custom host'}
          <InfoTip label="About custom hosts">
            An Anthropic-compatible gateway. Claude Code calls &lt;base URL&gt;/v1/messages with the account's key. Leave the
            base URL without /v1: it's added automatically.
          </InfoTip>
        </span>
      }
      onSubmit={submit}
      submitLabel="Save"
      saving={saving}
      error={formError}
      dirty={!!form.name || !!form.baseUrl}
    >
      <div className="flex flex-col gap-4">
        <TextField label="Name" autoComplete="off" value={form.name} onChange={(e) => set('name', e.target.value)} error={errors.name} data-autofocus />
        <TextField
          label="Base URL"
          placeholder="https://gateway.example.com"
          autoComplete="off"
          spellCheck={false}
          className="[&_input]:font-mono"
          value={form.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
          error={errors.baseUrl}
        />

        <SwitchRow
          label={
            <span className="inline-flex items-center gap-1.5">
              Allow private network
              <InfoTip label="About private networks">Lets checks reach LAN or localhost addresses. Off unless the host is on your own network.</InfoTip>
            </span>
          }
          checked={!!form.allowPrivateNetwork}
          onChange={(v) => set('allowPrivateNetwork', v)}
        />
        <details className="group rounded-xl border border-line">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-3 text-sm font-semibold text-ink-soft [&::-webkit-details-marker]:hidden">
            Advanced
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="flex flex-col gap-4 px-3.5 pb-3.5">
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-ink-soft">Model names</p>
                {endpoint && endpoint.accounts > 0 && (
                  <Button variant="ghost" size="sm" icon={<Download className="size-3.5" />} loading={importing} onClick={() => void importModels()}>
                    Import from host
                  </Button>
                )}
              </div>
              <datalist id={listId}>
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {SLOTS.map((s) => (
                  <TextField
                    key={s.key}
                    label={s.label}
                    list={listId}
                    autoComplete="off"
                    spellCheck={false}
                    className="[&_input]:font-mono"
                    value={form.modelNames?.[s.key] ?? ''}
                    onChange={(e) => setSlot(s.key, e.target.value)}
                    error={errors[`modelNames.${s.key}`]}
                  />
                ))}
              </div>
              {models.length > 0 && <p className="mt-2 text-[12px] text-muted">{models.length} models found; start typing to pick one.</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="Context window (tokens)"
                inputMode="numeric"
                value={form.contextTokens ?? ''}
                onChange={(e) => set('contextTokens', e.target.value === '' ? null : (e.target.value as unknown as number))}
                error={errors.contextTokens}
              />
              <TextField
                label="Max output (tokens)"
                inputMode="numeric"
                value={form.maxOutputTokens ?? ''}
                onChange={(e) => set('maxOutputTokens', e.target.value === '' ? null : (e.target.value as unknown as number))}
                error={errors.maxOutputTokens}
              />
            </div>

            <SwitchRow
              label={
                <span className="inline-flex items-center gap-1.5">
                  Rejects Claude Code’s beta flags
                  <InfoTip label="About beta flags">Turn on if requests fail with errors about anthropic-beta.</InfoTip>
                </span>
              }
              checked={!!form.disableBetas}
              onChange={(v) => set('disableBetas', v)}
            />
          </div>
        </details>
      </div>
    </FormDialog>
  );
}
