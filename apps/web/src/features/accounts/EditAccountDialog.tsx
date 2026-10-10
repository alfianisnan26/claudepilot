import { FormDialog, SwitchRow, TextField } from '@isnanme/ui';
import { ACCOUNT_NAME_MAX, type Account } from '@portal/contracts';
import { Power } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SecretField } from '@/components/SecretField';
import { api, ApiError } from '@/lib/api';

/** Rename, notes, enable/disable, or replace the key. The current key is never shown. */
export function EditAccountDialog({
  account,
  onClose,
  onSaved,
}: {
  account: Account | null;
  onClose: () => void;
  onSaved: (account: Account) => void;
}) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [key, setKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!account) return;
    setName(account.name);
    setNotes(account.notes);
    setEnabled(account.enabled);
    setKey('');
    setErrors({});
    setFormError(null);
  }, [account]);

  const submit = async () => {
    if (!account) return;
    setSaving(true);
    setFormError(null);
    try {
      onSaved(await api.accounts.update(account.id, { name, notes, enabled, ...(key.trim() ? { key } : {}) }));
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === 'object') setErrors(e.details as Record<string, string>);
      setFormError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const dirty = !!account && (name !== account.name || notes !== account.notes || enabled !== account.enabled || !!key);

  return (
    <FormDialog
      open={!!account}
      onClose={onClose}
      title="Edit account"
      onSubmit={submit}
      submitLabel={key.trim() ? 'Save and check' : 'Save'}
      saving={saving}
      error={formError}
      dirty={dirty}
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Name"
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
        />
        <SecretField
          label="Replace key"
          optional
          placeholder={account?.hasSecret ? `Current: ${account.masked}` : 'Enter the key again'}
          hint={account?.hasSecret ? 'Leave empty to keep the current key.' : 'This key was cleared (portal forget-secrets). Enter it again to use the account.'}
          value={key}
          onChange={(e) => (setKey(e.target.value), setErrors(({ key: _, ...r }) => r))}
          error={errors.key}
        />
        <TextField label="Notes" optional autoComplete="off" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <SwitchRow
          icon={<Power className="size-[18px]" />}
          label="Enabled"
          description={enabled ? 'Can be used by pools.' : 'Kept, but not used by any pool.'}
          checked={enabled}
          onChange={setEnabled}
        />
      </div>
    </FormDialog>
  );
}
