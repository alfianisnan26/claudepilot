import { FormDialog, Select, TextField } from '@isnanme/ui';
import { CHAT_SESSION_TITLE_MAX, type ChatFolderScan, type CreateChatSessionRequest, type Workspace } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorText } from '@/lib/api';
import { chatApi } from './api';
import { firstShell, NoSessionWorkspace } from './SessionSetup';
import { HOME, isIneligible } from './shared';
import { isFolderUntrusted, scanAfter, TrustDetails } from './TrustSheet';

/** The longest folder path the portal takes. */
const FOLDER_MAX = 4096;
const FOLDER_PROBLEM = `Use a folder inside ${HOME}, like ${HOME}/project.`;

/**
 * The folder as the session will run in it: `~` expanded, `.`, `..` and repeated slashes resolved, and
 * empty meaning the home folder. Null when it isn't inside the home folder.
 */
function folderPath(raw: string): string | null {
  const value = raw.trim();
  if (!value) return HOME;
  const path = value === '~' || value.startsWith('~/') ? HOME + value.slice(1) : value;
  if (!path.startsWith('/')) return null;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  const tidy = `/${parts.join('/')}`;
  return tidy === HOME || tidy.startsWith(`${HOME}/`) ? tidy : null;
}

/** A start refused until the folder is trusted: what the folder would load, and the start to run again. */
interface TrustStep {
  scan: ChatFolderScan;
  request: CreateChatSessionRequest;
  /** The folder's settings changed since the last scan shown. */
  changed: boolean;
}

/**
 * Why a workspace can't host a session right now, or null when it can. Sessions run only on the keys
 * an Account Pool delivers (chat PRD §6 rule 1), so the workspace needs an active, synced pool.
 */
function ineligible(w: Workspace): string | null {
  if (w.status !== 'running') return 'not running';
  if (!w.account) return 'no account pool';
  if (w.account.state === 'removing') return 'pool change in progress';
  if (w.account.state === 'waiting') return 'pool has no usable key';
  if (w.delivery?.status !== 'synced') return 'delivery not up to date';
  return null;
}

/**
 * Start a session: pick a running workspace, optionally a folder in it and a title. The running
 * workspaces are loaded when the dialog opens; with none running there's nothing to talk to, so it
 * points at Workspaces instead of offering an empty picker. A folder whose own Claude Code settings
 * would load something asks first: the dialog turns into "Trust this folder?", and Trust and start
 * starts it again (Cancel goes back to the form).
 */
export function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState(HOME);
  const [folderError, setFolderError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [trust, setTrust] = useState<TrustStep | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setFolder(HOME);
    setFolderError(undefined);
    setError(null);
    setTrust(null);
    setWorkspaces(null);
    setWorkspaceId('');
    let current = true;
    api.workspaces.list().then(
      (list) => {
        if (!current) return;
        setWorkspaces(list);
        setWorkspaceId(list.find((w) => !ineligible(w))?.id ?? '');
      },
      () => current && setWorkspaces([]),
    );
    return () => {
      current = false;
    };
  }, [open]);

  /** After a refusal for the workspace's pool: the picker catches up (the choice stays if still eligible). */
  const reload = () =>
    api.workspaces.list().then(
      (list) => {
        setWorkspaces(list);
        setWorkspaceId((id) => (list.some((w) => w.id === id && !ineligible(w)) ? id : (list.find((w) => !ineligible(w))?.id ?? '')));
      },
      () => undefined,
    );

  const all = workspaces ?? [];
  // No workspace can host a session (US8): each says why, with its way out; the main button opens a shell.
  const needsSetup = workspaces !== null && !all.some((w) => !ineligible(w));
  const shell = needsSetup ? firstShell(all) : null;
  const startWorkspace = async (w: Workspace) => {
    setError(null);
    try {
      await api.workspaces.start(w.id);
      await reload();
    } catch (e) {
      setError(errorText(e, `Couldn’t start ${w.name}.`));
    }
  };
  const goNext = () => {
    onClose();
    navigate(shell ?? '/admin/workspaces');
  };

  /** The folder needs trust: show what it would load (a fresh scan when its files changed since the last). */
  const askTrust = async (e: unknown, request: CreateChatSessionRequest, where: string) => {
    try {
      const scan = await scanAfter(e, request.workspaceId, where);
      setTrust((t) => ({ scan, request, changed: !!t && t.scan.hash !== scan.hash }));
    } catch (err) {
      setTrust(null);
      setError(errorText(err, 'Couldn’t check the folder.'));
    }
  };

  const start = async (request: CreateChatSessionRequest) => {
    setSaving(true);
    setError(null);
    try {
      const session = await chatApi.create(request);
      onClose();
      navigate(`/admin/sessions/${session.id}`);
    } catch (e) {
      if (isFolderUntrusted(e)) {
        await askTrust(e, request, request.cwd ?? HOME);
      } else {
        setTrust(null);
        setError(errorText(e, 'Could not start the session.'));
        if (isIneligible(e)) void reload();
      }
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    if (!workspaceId) return;
    const cwd = folderPath(folder);
    if (!cwd) return setFolderError(FOLDER_PROBLEM);
    await start({ workspaceId, title: title.trim() || undefined, cwd });
  };

  const trustAndStart = async () => {
    if (!trust) return;
    const { scan, request } = trust;
    setSaving(true);
    setError(null);
    try {
      await chatApi.trust({ workspaceId: scan.workspaceId, folder: scan.folder, hash: scan.hash });
    } catch (e) {
      if (isFolderUntrusted(e)) await askTrust(e, request, scan.folder);
      else setError(errorText(e, 'Couldn’t trust the folder.'));
      setSaving(false);
      return;
    }
    await start(request);
  };

  // Cancel (and ×) on the trust step goes back to the form.
  const back = () => {
    if (saving) return;
    setTrust(null);
    setError(null);
  };

  return (
    <FormDialog
      open={open}
      onClose={trust ? back : onClose}
      size="sm"
      title={trust ? 'Trust this folder?' : 'New session'}
      description={
        trust ? <span className="font-mono break-all">{trust.scan.folder}</span> : needsSetup ? 'No workspace is ready for sessions.' : 'Chat with Claude Code in a workspace.'
      }
      onSubmit={trust ? trustAndStart : needsSetup ? goNext : submit}
      submitLabel={trust ? 'Trust and start' : needsSetup ? (shell ? 'Open shell' : 'Workspaces') : 'Start'}
      saving={saving}
      submitDisabled={trust ? false : needsSetup ? false : !workspaceId}
      error={error}
      dirty={!trust && (!!title || folder.trim() !== HOME)}
    >
      {trust ? (
        <TrustDetails scan={trust.scan} changed={trust.changed} />
      ) : needsSetup ? (
        <NoSessionWorkspace workspaces={all} onStart={startWorkspace} onLeave={onClose} />
      ) : (
        <div className="flex flex-col gap-4">
          <Select
            label="Workspace"
            value={workspaceId}
            onChange={setWorkspaceId}
            options={all.map((w) => {
              const why = ineligible(w);
              return { value: w.id, label: why ? `${w.name} · ${why}` : w.name, disabled: !!why };
            })}
            placeholder={workspaces === null ? 'Loading…' : 'Pick a workspace'}
          />
          <TextField
            label="Folder"
            optional
            hint={`Where Claude Code works, inside ${HOME}.`}
            placeholder={HOME}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={FOLDER_MAX}
            className="[&_input]:font-mono"
            value={folder}
            onChange={(e) => {
              setFolder(e.target.value);
              setFolderError(undefined);
            }}
            error={folderError}
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
