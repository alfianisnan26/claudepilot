import { FormDialog, Select, SwitchRow, TextField } from '@isnanme/ui';
import { CHAT_SESSION_TITLE_MAX, CLAUDE_NAME_MAX, type ChatFolderScan, type CreateChatSessionRequest, type Workspace, type WorkspaceClaudeState } from '@portal/contracts';
import { GitBranch, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
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
 * Why a workspace can't host a session right now, or null when it can (chat PRD §6 rule 1). Without a
 * pool a session runs on its Claude's own sign-in (checked per Claude below); with one, on the pool's
 * keys, so the pool must be active and delivered.
 */
function ineligible(w: Workspace): string | null {
  if (w.status !== 'running') return 'not running';
  if (!w.account) return null;
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
  const [claudes, setClaudes] = useState<WorkspaceClaudeState[] | null>(null);
  const [claudeId, setClaudeId] = useState('');
  const [newClaude, setNewClaude] = useState('');
  // Where policy allows Bypass, the person can opt this session in at its start (FR20); off by default, every time.
  const [bypassAllowed, setBypassAllowed] = useState(false);
  const [allowBypass, setAllowBypass] = useState(false);
  // A git worktree of its own: the chat's folder is a new branch of the repository (all optional: the portal names them).
  const [useWorktree, setUseWorktree] = useState(false);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');

  useEffect(() => {
    if (!open) return;
    setAllowBypass(false);
    setBypassAllowed(false);
    setUseWorktree(false);
    setBranch('');
    setBase('');
    chatApi.policy().then(
      (p) => setBypassAllowed(p.bypass.allowed),
      () => undefined,
    );
    setTitle('');
    setFolder(HOME);
    setFolderError(undefined);
    setError(null);
    setTrust(null);
    setWorkspaces(null);
    setWorkspaceId('');
    setClaudes(null);
    setClaudeId('');
    setNewClaude('');
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

  const all = workspaces ?? [];
  const chosenWorkspace = all.find((w) => w.id === workspaceId);
  /** Without a pool, each session runs on its Claude's own sign-in. */
  const ownSignIn = !!chosenWorkspace && !chosenWorkspace.account;
  /** A Claude that can't start a session: signed out, on a workspace without a pool. */
  const signedOut = (c: WorkspaceClaudeState) => ownSignIn && !!c.auth && !c.auth.loggedIn;

  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    setClaudes(null);
    api.workspaces.claudes(workspaceId).then(
      (list) => {
        if (!current) return;
        setClaudes(list);
        const usable = list.find((c) => !(c.auth && !c.auth.loggedIn)) ?? list[0];
        setClaudeId(usable?.claude.id ?? '');
      },
      () => current && setClaudes([]),
    );
    return () => {
      current = false;
    };
  }, [workspaceId]);

  /** After a refusal for the workspace's pool: the picker catches up (the choice stays if still eligible). */
  const reload = () =>
    api.workspaces.list().then(
      (list) => {
        setWorkspaces(list);
        setWorkspaceId((id) => (list.some((w) => w.id === id && !ineligible(w)) ? id : (list.find((w) => !ineligible(w))?.id ?? '')));
      },
      () => undefined,
    );

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
      // A worktree the portal made and is holding for this start: the retry names it, so it is used and none is made twice.
      setTrust((t) => ({ scan, request: scan.worktree ? { ...request, worktree: scan.worktree } : request, changed: !!t && t.scan.hash !== scan.hash }));
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
    let chosen = claudeId;
    const named = ownSignIn ? '' : newClaude.trim();
    if (named) {
      setSaving(true);
      setError(null);
      try {
        const created = await chatApi.createClaude({ workspaceId, name: named });
        chosen = created.id;
      } catch (e) {
        setError(errorText(e, 'Could not add that Claude.'));
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    await start({ workspaceId, title: title.trim() || undefined, cwd, claudeId: chosen || undefined, allowBypass: bypassAllowed && allowBypass ? true : undefined, worktree: useWorktree ? { branch: branch.trim() || undefined, base: base.trim() || undefined } : undefined });
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
        trust ? <span className="font-mono break-all">{trust.scan.folder}</span> : needsSetup ? 'No workspace is ready for sessions.' : undefined
      }
      onSubmit={trust ? trustAndStart : needsSetup ? goNext : submit}
      submitLabel={trust ? 'Trust and start' : needsSetup ? (shell ? 'Open shell' : 'Workspaces') : 'Start'}
      saving={saving}
      submitDisabled={trust ? false : needsSetup ? false : !workspaceId || (ownSignIn && !newClaude.trim() && !claudes?.some((c) => c.claude.id === claudeId && !signedOut(c)))}
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
          <Select
            label="Claude"
            value={claudeId}
            onChange={setClaudeId}
            options={(claudes ?? []).map((c) => ({
              value: c.claude.id,
              label: signedOut(c) ? `${c.claude.name} · signed out` : c.claude.name,
              disabled: signedOut(c),
            }))}
            placeholder={!workspaceId ? 'Pick a workspace first' : claudes === null ? 'Loading…' : 'Pick a Claude'}
            hint={
              chosenWorkspace && ownSignIn && claudes && !claudes.some((c) => !signedOut(c)) ? (
                <>
                  No Claude here is signed in.{' '}
                  <Link to="/admin/workspaces" onClick={onClose} className="font-semibold text-ink underline underline-offset-2">
                    Sign one in
                  </Link>
                </>
              ) : undefined
            }
          />
          {!ownSignIn && (
            <TextField
              label="New Claude"
              optional
              hint="Adds another Claude on this workspace."
              placeholder="Name, to add one"
              maxLength={CLAUDE_NAME_MAX}
              value={newClaude}
              onChange={(e) => setNewClaude(e.target.value)}
            />
          )}
          <TextField
            label="Title"
            optional
            placeholder="What’s this about?"
            maxLength={CHAT_SESSION_TITLE_MAX}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <SwitchRow
            label={
              <span className="inline-flex items-center gap-1">
                Work in a git worktree
                <InfoTip label="About worktrees">
                  Adds a branch of the folder’s repository in a folder of its own, so this chat’s changes stay apart from your working folder and from other chats. Leave the branch empty and the portal names one. Its folder stays when the chat is deleted, unless you remove it.
                </InfoTip>
              </span>
            }
            icon={<GitBranch className="size-4" />}
            checked={useWorktree}
            onChange={setUseWorktree}
            className="-my-1"
          />
          {useWorktree && (
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Branch" optional placeholder="session/…" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={100} className="[&_input]:font-mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
              <TextField label="From" optional placeholder="current branch" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={100} className="[&_input]:font-mono" value={base} onChange={(e) => setBase(e.target.value)} />
            </div>
          )}
          {bypassAllowed && (
            <SwitchRow
              label="Allow Bypass later in this session"
              icon={<ShieldAlert className="size-4" />}
              checked={allowBypass}
              onChange={setAllowBypass}
              className="-my-1"
            />
          )}
        </div>
      )}
    </FormDialog>
  );
}
