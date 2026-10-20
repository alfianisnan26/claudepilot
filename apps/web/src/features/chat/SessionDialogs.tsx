import { Button, Dialog, FormDialog, TextField, useToast } from '@isnanme/ui';
import { CHAT_SESSION_TITLE_MAX, WORKTREE_DIRTY, type ChatSession, type ChatWorktreeRemoval, type ChatWorktreeStatus } from '@portal/contracts';
import { Bot, GitBranch } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ApiError, errorText } from '@/lib/api';
import { chatApi } from './api';

/** Rename (FR4): the portal's title for the session, in any state. */
export function RenameSessionDialog({ session, onClose }: { session: ChatSession | null; onClose: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  // Filled once per opening: the session object changes with every live update, the draft mustn't.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const id = session?.id ?? null;
  if (openFor !== id) {
    setOpenFor(id);
    if (session) {
      setTitle(session.title);
      setError(undefined);
    }
  }

  const save = async () => {
    if (!session) return;
    if (!title.trim()) return setError('Give it a title.');
    if (title.trim() === session.title) return onClose();
    setSaving(true);
    try {
      await chatApi.rename(session.id, title);
      toast('Renamed');
      onClose();
    } catch (e) {
      const details = (e as { details?: { title?: string } }).details;
      setError(details?.title ? errorText(e, details.title) : errorText(e, 'Couldn’t rename it.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={!!session} onClose={() => !saving && onClose()} size="sm" title="Rename agent" onSubmit={save} submitLabel="Save" saving={saving}>
      <TextField
        label="Title"
        maxLength={CHAT_SESSION_TITLE_MAX}
        autoComplete="off"
        value={title}
        onChange={(e) => (setTitle(e.target.value), setError(undefined))}
        error={error}
      />
    </FormDialog>
  );
}

/**
 * What happens to a chat's git worktree when it is deleted or archived: the folder stays unless the person says otherwise. The
 * choice reads what removal would lose first, and a folder with changes or untracked files is only removed when the person ticks
 * that they may go. Commits are never lost: the branch is deleted only when it is merged.
 */
function WorktreeChoice({ session, onChange }: { session: ChatSession; onChange: (c: { mode: ChatWorktreeRemoval; blocked: boolean }) => void }) {
  const wt = session.worktree!;
  const [status, setStatus] = useState<ChatWorktreeStatus | null | 'failed'>(null);
  const [remove, setRemove] = useState(false);
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    let current = true;
    chatApi.worktreeStatus(session.id).then(
      (r) => current && setStatus(r),
      () => current && setStatus('failed'),
    );
    return () => {
      current = false;
    };
  }, [session.id]);
  const info = status && status !== 'failed' ? status : null;
  const gone = info?.exists === false;
  const mode: ChatWorktreeRemoval = !remove || gone ? 'keep' : info?.needsForce ? (discard ? 'force' : 'remove') : 'remove';
  const blocked = remove && !gone && (status === null || status === 'failed' || (!!info?.needsForce && !discard));
  useEffect(() => onChange({ mode, blocked }), [mode, blocked, onChange]);
  const choice = (value: boolean, label: string) => (
    <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-[14px] text-ink">
      <input type="radio" name="worktree" checked={remove === value} onChange={() => setRemove(value)} className="size-4 accent-[var(--color-primary)]" />
      {label}
    </label>
  );
  return (
    <fieldset className="mt-3 rounded-2xl bg-surface-2 px-3.5 py-3">
      <legend className="sr-only">Its worktree</legend>
      <p className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate font-mono">{wt.branch}</span>
        <InfoTip label="About the worktree">
          The folder <span className="font-mono break-all">{wt.path}</span> is a git worktree made for this chat. The branch is deleted only when it is merged: commits are never lost with the folder.
        </InfoTip>
      </p>
      {gone ? (
        <p className="text-[13px] text-muted">Its folder is already gone.</p>
      ) : (
        <>
          {choice(false, 'Keep the folder')}
          {choice(true, 'Remove the folder')}
          {remove && status === null && <p className="text-[13px] text-muted">Checking what is in it…</p>}
          {remove && status === 'failed' && <p className="text-[13px] text-danger">Couldn’t look at it. Keep the folder, or try again later.</p>}
          {remove && info && info.needsForce && (
            <label className="mt-1 flex cursor-pointer items-start gap-2.5 rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-ink">
              <input type="checkbox" checked={discard} onChange={(e) => setDiscard(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-danger)]" />
              <span>
                Discard {info.dirty > 0 ? `${info.dirty} changed` : ''}
                {info.dirty > 0 && info.untracked > 0 ? ' and ' : ''}
                {info.untracked > 0 ? `${info.untracked} untracked` : ''} {info.dirty + info.untracked === 1 ? 'file' : 'files'}
              </span>
            </label>
          )}
          {remove && info && info.unique > 0 && <p className="mt-1 text-[13px] text-muted">{info.unique} {info.unique === 1 ? 'commit stays' : 'commits stay'} on the branch.</p>}
        </>
      )}
    </fieldset>
  );
}

/** A confirmation for a session that may have a worktree: the text, the worktree's choice when it has one, Cancel focused. */
function SessionAction({
  session,
  title,
  text,
  confirmLabel,
  danger = true,
  worktree = true,
  run,
  onClose,
}: {
  session: ChatSession | null;
  title: string;
  text: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Offer what to do with the chat's worktree (not for End, which leaves it). */
  worktree?: boolean;
  run: (session: ChatSession, worktree: ChatWorktreeRemoval, children: 'end' | undefined) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<{ mode: ChatWorktreeRemoval; blocked: boolean }>({ mode: 'keep', blocked: false });
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // The sessions this one started and that are still going: ending it asks what becomes of them.
  const [running, setRunning] = useState(0);
  const [endThem, setEndThem] = useState(false);
  const id = session?.id ?? '';
  useEffect(() => {
    setError(null);
    setChoice({ mode: 'keep', blocked: false });
    setRound(0);
    setRunning(0);
    setEndThem(false);
    if (!id) return;
    let current = true;
    chatApi.children(id).then(
      (list) => current && setRunning(list.filter((c) => c.state !== 'ended').length),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [id]);
  const confirm = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await run(session, worktree && session.worktree ? choice.mode : 'keep', running > 0 && endThem ? 'end' : undefined);
      onClose();
    } catch (e) {
      // What was in the folder changed since it was looked at: look again before asking.
      if (e instanceof ApiError && e.code === WORKTREE_DIRTY) setRound((n) => n + 1);
      setError(errorText(e, 'That didn’t go through.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!session}
      onClose={() => !busy && onClose()}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => void confirm()} loading={busy} disabled={choice.blocked}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-[15px] text-ink-soft">{text}</p>
      {running > 0 && (
        <fieldset className="mt-3 rounded-2xl bg-surface-2 px-3.5 py-3">
          <legend className="sr-only">Its workers</legend>
          <p className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <Bot className="size-3.5 shrink-0" aria-hidden="true" />
            {running === 1 ? 'It started 1 agent still running' : `It started ${running} agents still running`}
          </p>
          <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-[14px] text-ink">
            <input type="radio" name="workers" checked={!endThem} onChange={() => setEndThem(false)} className="size-4 accent-[var(--color-primary)]" />
            Leave {running === 1 ? 'it' : 'them'} running
          </label>
          <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-[14px] text-ink">
            <input type="radio" name="workers" checked={endThem} onChange={() => setEndThem(true)} className="size-4 accent-[var(--color-primary)]" />
            End {running === 1 ? 'it' : 'them'} too
          </label>
        </fieldset>
      )}
      {worktree && session?.worktree && <WorktreeChoice key={`${session.id}:${round}`} session={session} onChange={setChoice} />}
      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/**
 * Delete (FR4): always confirmed. One that's still going is ended first. The portal's transcript and the
 * session's files in the workspace go; Claude Code's own transcript stays until its cleanup. A worktree stays unless asked.
 */
export function DeleteSessionDialog({ session, onClose, onDeleted }: { session: ChatSession | null; onClose: () => void; onDeleted?: () => void }) {
  const toast = useToast();
  const running = !!session && session.state !== 'ended';
  return (
    <SessionAction
      session={session}
      title={`Delete ${session?.title || 'this agent'}?`}
      text={
        <>
          Deletes the transcript and its files. This can’t be undone.
          <InfoTip label="Details" className="ml-1 align-middle">
            {running ? 'Claude Code stops working on it first. ' : ''}Images and the agent’s files in the workspace go too. Claude Code’s own transcript stays until its cleanup (30 days by default). Usage history is kept.
          </InfoTip>
        </>
      }
      confirmLabel="Delete"
      run={async (s, worktree, children) => {
        const { purged } = await chatApi.remove(s.id, worktree, children);
        toast(purged ? 'Deleted' : 'Deleted · workspace files kept');
        onDeleted?.();
      }}
      onClose={onClose}
    />
  );
}

/** Archive (FR4): ends a session that is still going, then moves it to Archived. A worktree stays unless asked. */
export function ArchiveSessionDialog({ session, onClose, onArchived }: { session: ChatSession | null; onClose: () => void; onArchived?: () => void }) {
  const toast = useToast();
  return (
    <SessionAction
      session={session}
      title={`Archive ${session?.title || 'this agent'}?`}
      text="Claude Code stops working on it and the chat ends. It moves to Archived, where the transcript stays."
      confirmLabel="Archive"
      danger={false}
      run={async (s, worktree, children) => {
        await chatApi.archive(s.id, worktree, children);
        toast('Archived');
        onArchived?.();
      }}
      onClose={onClose}
    />
  );
}

/** End (FR4): the chat is closed and Claude Code stops. A session that started others asks what becomes of them; its worktree stays. */
export function EndSessionDialog({ session, onClose, onEnded }: { session: ChatSession | null; onClose: () => void; onEnded?: () => void }) {
  return (
    <SessionAction
      session={session}
      title={`End ${session?.title || 'this agent'}?`}
      text="The chat is closed and Claude Code stops working on it. The transcript stays for your records."
      confirmLabel="End agent"
      worktree={false}
      run={async (s, _worktree, children) => {
        await chatApi.end(s.id, children);
        onEnded?.();
      }}
      onClose={onClose}
    />
  );
}
