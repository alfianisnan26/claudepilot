import { Button, Dialog, TextField } from '@isnanme/ui';
import { codeProblem, CODE_LENGTH } from '@portal/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api';

/** Set the server code by hand. */
export function CustomCodeDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) (setCode(''), setError(undefined));
  }, [open]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const problem = codeProblem(code);
    if (problem) return setError(problem);
    setSaving(true);
    try {
      await onSave(code);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not save the code.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !saving && onClose()}
      size="sm"
      title="Set a custom code"
      description="Everyone else signed in is signed out and needs the new code."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Save code
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate>
        <TextField
          label="New code"
          hint={`Exactly ${CODE_LENGTH} letters and digits. Case, spaces and dashes are ignored.`}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="[&_input]:font-mono [&_input]:uppercase [&_input]:tracking-[0.08em]"
          value={code}
          onChange={(e) => (setCode(e.target.value), setError(undefined))}
          error={error}
          data-autofocus
        />
      </form>
    </Dialog>
  );
}
