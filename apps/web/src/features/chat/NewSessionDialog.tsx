import { FormDialog, Select, TextField } from '@isnanme/ui';
import { CHAT_SESSION_TITLE_MAX, type Workspace } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText } from '@/lib/api';
import { chatApi } from './api';

/**
 * Start a session: pick a running workspace and, optionally, a title. The running workspaces are
 * loaded when the dialog opens; with none running there's nothing to talk to, so it points at
 * Workspaces instead of offering an empty picker.
 */
export function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setError(null);
    setWorkspaces(null);
    setWorkspaceId('');
    let current = true;
    api.workspaces.list().then(
      (list) => {
        if (!current) return;
        const running = list.filter((w) => w.status === 'running');
        setWorkspaces(running);
        setWorkspaceId(running[0]?.id ?? '');
      },
      () => current && setWorkspaces([]),
    );
    return () => {
      current = false;
    };
  }, [open]);

  const running = workspaces ?? [];
  const none = workspaces !== null && running.length === 0;

  const submit = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      const session = await chatApi.create({ workspaceId, title: title.trim() || undefined });
      onClose();
      navigate(`/admin/sessions/${session.id}`);
    } catch (e) {
      setError(errorText(e, 'Could not start the session.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      size="sm"
      title="New session"
      description="Chat with Claude Code in a running workspace."
      onSubmit={submit}
      submitLabel="Start"
      saving={saving}
      submitDisabled={!workspaceId}
      error={error}
      dirty={!!title}
    >
      {none ? (
        <p className="text-sm text-muted">
          No workspace is running.{' '}
          <Link to="/admin/workspaces" onClick={onClose} className="font-semibold text-ink underline underline-offset-2">
            Start one
          </Link>{' '}
          to chat with its agent.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <Select
            label="Workspace"
            value={workspaceId}
            onChange={setWorkspaceId}
            options={running.map((w) => ({ value: w.id, label: w.name }))}
            placeholder={workspaces === null ? 'Loading…' : 'Pick a workspace'}
          />
          <TextField
            label="Title"
            optional
            placeholder="What’s this about?"
            maxLength={CHAT_SESSION_TITLE_MAX}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
      )}
    </FormDialog>
  );
}
