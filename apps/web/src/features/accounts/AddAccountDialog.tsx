import { FormDialog, Segmented, Select, SwitchRow, TextArea, TextField } from '@isnanme/ui';
import { ACCOUNT_NAME_MAX, ANTHROPIC_ENDPOINT_ID, type Endpoint } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { SecretField } from '@/components/SecretField';
import { api, ApiError } from '@/lib/api';

type Mode = 'one' | 'many';

/** Add one key (checked on save) or several (`name|key` lines, checked one by one afterwards). */
export function AddAccountDialog({
  open,
  endpoints,
  onClose,
  onAdded,
}: {
  open: boolean;
  endpoints: Endpoint[];
  onClose: () => void;
  onAdded: (message: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('one');
  const [endpointId, setEndpointId] = useState(ANTHROPIC_ENDPOINT_ID);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [lines, setLines] = useState('');
  const [owned, setOwned] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('one');
    setEndpointId(ANTHROPIC_ENDPOINT_ID);
    setName('');
    setKey('');
    setLines('');
    setOwned(false);
    setErrors({});
    setFormError(null);
  }, [open]);

  const submit = async () => {
    const next: Record<string, string> = {};
    if (mode === 'one' && !name.trim()) next.name = 'Give it a name.';
    if (mode === 'one' && !key.trim()) next.key = 'Paste the key.';
    if (mode === 'many' && !lines.trim()) next.lines = 'Paste one “name|key” per line.';
    if (!owned) next.confirmOwned = 'Confirm the key is yours to use.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    setFormError(null);
    try {
      if (mode === 'one') {
        const account = await api.accounts.create({ name, endpointId, key, confirmOwned: true });
        onAdded(account.check.result === 'ok' ? `${account.name} added and working` : `${account.name} added; check: ${account.check.result.replace('_', ' ')}`);
      } else {
        const result = await api.accounts.bulk({ endpointId, lines, confirmOwned: true });
        if (result.skipped.length) {
          setFormError(`Added ${result.created.length}. Skipped ${result.skipped.map((s) => `line ${s.line} (${s.reason})`).join('; ')}`);
          setLines(lines.split(/\r?\n/).filter((_, i) => result.skipped.some((s) => s.line === i + 1)).join('\n'));
          if (result.created.length) onAdded(`${result.created.length} added; checking them one by one`);
          return;
        }
        onAdded(`${result.created.length} added; checking them one by one`);
      }
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === 'object') setErrors(e.details as Record<string, string>);
      setFormError(e instanceof Error ? e.message : 'Could not add it.');
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
          Add key
          <InfoTip label="About keys">
            An Anthropic API key, or a key for one of your custom hosts. Keys are encrypted and can’t be shown again. Using a
            Claude Pro or Max plan? Sign in per workspace instead (its menu, Sign in to Claude): plan logins can’t be added to pools.
          </InfoTip>
        </span>
      }
      onSubmit={submit}
      submitLabel={mode === 'one' ? 'Add and check' : 'Add keys'}
      saving={saving}
      error={formError}
      dirty={!!(name || key || lines)}
    >
      <div className="flex flex-col gap-4">
        <Segmented<Mode>
          label="How many"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'one', label: 'One key' },
            { value: 'many', label: 'Several keys' },
          ]}
        />
        <Select
          label="Used with"
          value={endpointId}
          onChange={setEndpointId}
          options={endpoints.map((e) => ({ value: e.id, label: e.kind === 'anthropic' ? 'Anthropic API' : `${e.name} · ${e.baseUrl}` }))}
          error={errors.endpointId}
        />
        {mode === 'one' ? (
          <>
            <TextField
              label="Name"
              placeholder="team-main"
              autoComplete="off"
              name="key-name"
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              maxLength={ACCOUNT_NAME_MAX}
              value={name}
              onChange={(e) => (setName(e.target.value), setErrors(({ name: _, ...r }) => r))}
              error={errors.name}
              data-autofocus
            />
            <SecretField
              label="Key"
              placeholder="sk-ant-…"
              value={key}
              onChange={(e) => (setKey(e.target.value), setErrors(({ key: _, ...r }) => r))}
              error={errors.key}
            />
          </>
        ) : (
          <TextArea
            label="Keys"
            hint="One per line: name|key"
            rows={6}
            spellCheck={false}
            className="font-mono text-[13px]"
            value={lines}
            onChange={(e) => (setLines(e.target.value), setErrors(({ lines: _, ...r }) => r))}
            error={errors.lines}
          />
        )}
        <SwitchRow
          label="These keys belong to me or my organization"
          description={errors.confirmOwned}
          checked={owned}
          onChange={(v) => (setOwned(v), setErrors(({ confirmOwned: _, ...r }) => r))}
        />
      </div>
    </FormDialog>
  );
}
