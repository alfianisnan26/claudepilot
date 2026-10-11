import { FormDialog, Segmented, Select, TextField } from '@isnanme/ui';
import { CLAUDE_NAME_MAX, TERMINAL_MAX, type TerminalKind, type WorkspaceClaude, type WorkspaceTerminal } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { chatApi } from '@/features/chat/api';
import { api, errorText } from '@/lib/api';

const KINDS: { value: TerminalKind; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'shell', label: 'Shell' },
];
/** The Select value that adds a Claude instead of picking one. */
const NEW = '__new__';

/**
 * Opens a terminal that keeps running without a browser (a tmux session): Claude Code, or a shell, in
 * a folder, as one of the workspace's Claudes. Each Claude has its own directory, so signing in there
 * (account or SSO, in the terminal) keeps that login apart from the others (Workspace Claudes §6).
 * A new Claude starts signed out. The first terminal may install tmux and Claude Code first.
 */
export function NewTerminalDialog({
  workspaceId,
  open,
  onClose,
  onOpened,
  claudeId: preset,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onOpened: (t: WorkspaceTerminal) => void;
  /** Start on this Claude (from a Claude's own "Open terminal"). */
  claudeId?: string;
}) {
  const [kind, setKind] = useState<TerminalKind>('claude');
  const [cwd, setCwd] = useState('~');
  const [claudes, setClaudes] = useState<WorkspaceClaude[] | null>(null);
  const [claudeId, setClaudeId] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ cwd?: string; name?: string }>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFieldErrors({});
    setNewName('');
    let current = true;
    chatApi.claudes(workspaceId).then(
      (list) => {
        if (!current) return;
        const live = list.filter((c) => !c.removedAt);
        setClaudes(live);
        setClaudeId(preset && live.some((c) => c.id === preset) ? preset : (live.find((c) => !c.directory)?.id ?? live[0]?.id ?? ''));
      },
      () => current && (setClaudes([]), setClaudeId('')),
    );
    return () => {
      current = false;
    };
  }, [open, workspaceId, preset]);

  const adding = claudeId === NEW;
  const picked = claudes?.find((c) => c.id === claudeId);

  const submit = async () => {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      let id = claudeId;
      if (adding) {
        const name = newName.trim();
        if (!name) return setFieldErrors({ name: 'Name the Claude.' });
        id = (await chatApi.createClaude({ workspaceId, name })).id;
      }
      onOpened(await api.workspaces.openTerminal(workspaceId, { kind, cwd: cwd.trim() || '~', claudeId: id || undefined }));
    } catch (e) {
      const details = (e as { details?: { cwd?: string; name?: string } }).details;
      if (details?.cwd || details?.name) setFieldErrors({ cwd: details.cwd, name: details.name });
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
      submitLabel={saving ? 'Opening…' : 'Open'}
      saving={saving}
      error={error}
    >
      <div className="flex flex-col gap-4">
        <Select
          label="Claude"
          value={claudeId}
          onChange={setClaudeId}
          placeholder={claudes === null ? 'Loading…' : 'Pick a Claude'}
          options={[...(claudes ?? []).map((c) => ({ value: c.id, label: c.name })), { value: NEW, label: '+ New Claude…' }]}
        />
        {adding && (
          <TextField
            label="Name"
            maxLength={CLAUDE_NAME_MAX}
            placeholder="Work"
            autoComplete="off"
            value={newName}
            onChange={(e) => (setNewName(e.target.value), setFieldErrors({}))}
            error={fieldErrors.name}
          />
        )}
        <p className="-mt-2 text-[13px] text-muted">
          {adding
            ? 'A new Claude starts signed out, with its own login and chats. Sign in from its terminal (account or SSO).'
            : picked && !picked.directory
              ? 'The workspace’s original Claude.'
              : 'Its own login and chats. Sign in from its terminal if it asks.'}
        </p>
        <Segmented<TerminalKind> label="Runs" value={kind} onChange={setKind} options={KINDS} />
        <TextField
          label="Folder"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="[&_input]:font-mono"
          value={cwd}
          onChange={(e) => (setCwd(e.target.value), setFieldErrors({}))}
          error={fieldErrors.cwd}
        />
      </div>
    </FormDialog>
  );
}
