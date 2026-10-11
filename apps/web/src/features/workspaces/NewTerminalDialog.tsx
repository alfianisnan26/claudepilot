import { FormDialog, Segmented, TextField } from '@isnanme/ui';
import { TERMINAL_MAX, type TerminalKind, type WorkspaceTerminal } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';

const KINDS: { value: TerminalKind; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'shell', label: 'Shell' },
];

/**
 * Opens a terminal that keeps running without a browser (a tmux session): Claude Code, or a shell, in
 * a folder. The first one in a workspace may install tmux and Claude Code first, which takes a while.
 */
export function NewTerminalDialog({
  workspaceId,
  open,
  onClose,
  onOpened,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onOpened: (t: WorkspaceTerminal) => void;
}) {
  const [kind, setKind] = useState<TerminalKind>('claude');
  const [cwd, setCwd] = useState('~');
  const [error, setError] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCwdError(undefined);
  }, [open]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      onOpened(await api.workspaces.openTerminal(workspaceId, { kind, cwd: cwd.trim() || '~' }));
    } catch (e) {
      const details = (e as { details?: { cwd?: string } }).details;
      if (details?.cwd) setCwdError(details.cwd);
      else setError(errorText(e, 'Couldn’t open the terminal.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      size="sm"
      title="New terminal"
      description={`Keeps running when you close the page. Up to ${TERMINAL_MAX} per workspace.`}
      onSubmit={submit}
      submitLabel={saving ? 'Opening… (first time installs what’s missing)' : 'Open'}
      saving={saving}
      error={error}
    >
      <div className="flex flex-col gap-4">
        <Segmented<TerminalKind> label="Runs" value={kind} onChange={setKind} options={KINDS} />
        <TextField
          label="Folder"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="[&_input]:font-mono"
          value={cwd}
          onChange={(e) => (setCwd(e.target.value), setCwdError(undefined))}
          error={cwdError}
        />
      </div>
    </FormDialog>
  );
}
