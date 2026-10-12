import { Button, DateField, Dialog, SwitchRow, TextField, useToast } from '@isnanme/ui';
import type { SecretRotationView } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { ApiError, errorText } from '@/lib/api';
import { secretsApi } from './api';
import { SecretValueField } from './SecretValueField';

/**
 * Rotate one secret (Secrets & env FR16): a new value, optionally when it expires, a note, and "Urgent" to also
 * reach workspaces pinned to an older revision at once. The value is write-only. FR20's warning is one line.
 */
export function RotateDialog({
  open,
  poolId,
  entry,
  onClose,
  onDone,
}: {
  open: boolean;
  poolId: string;
  entry: { id: string; name: string };
  onClose: () => void;
  onDone: (rotation: SecretRotationView) => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState('');
  const [expires, setExpires] = useState('');
  const [note, setNote] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue('');
    setExpires('');
    setNote('');
    setUrgent(false);
    setError(null);
  }, [open]);

  const rotate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await secretsApi.rotate(poolId, entry.id, {
        value,
        urgent,
        ...(note.trim() ? { note: note.trim() } : {}),
        // The end of that day, local time: it still works on the day itself.
        ...(expires ? { expiresAt: new Date(`${expires}T23:59:59`).toISOString() } : {}),
      });
      toast(`${entry.name} rotated to v${r.toVersion}`);
      onDone(r);
    } catch (e) {
      setError(e instanceof ApiError && e.details && typeof e.details === 'object' ? ((e.details as Record<string, string>).value ?? e.message) : errorText(e, 'Could not rotate it.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      size="sm"
      title={`Rotate ${entry.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void rotate()} loading={busy} disabled={value.trim() === ''}>
            Rotate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <SecretValueField label="New value" info={null} value={value} onChange={setValue} error={error ?? undefined} disabled={busy} />
        <DateField label="Expires" optional value={expires} onChange={setExpires} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} />
        <TextField label="Note" optional placeholder="Why" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
        <SwitchRow label="Urgent" description="Also reaches workspaces pinned to an older revision, now." checked={urgent} onChange={setUrgent} disabled={busy} />
        <p className="text-[12.5px] text-muted">Rotating is not revoking: copies of the old value may remain. Revoke it at the provider.</p>
      </div>
    </Dialog>
  );
}
