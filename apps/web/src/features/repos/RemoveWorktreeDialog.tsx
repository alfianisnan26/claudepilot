import { ConfirmDialog } from '@isnanme/ui';
import { WORKTREE_DIRTY, type ChatWorktreeStatus, type RemoveRepoWorktreeResult, type RepoNode } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { ApiError, errorText } from '@/lib/api';
import { reposApi } from './api';
import { clip } from './labels';
import { useEscapeTop } from './escape';

const files = (n: number, word: string) => `${n} ${word} ${n === 1 ? 'file' : 'files'}`;

/**
 * Removing a worktree: the folder goes, its branch only when it is merged, so commits are never lost with it. Asked once; when the
 * folder holds changes the portal refuses (409) and says how many, and only a second, explicit yes discards them.
 */
export function RemoveWorktreeDialog({ repo, onClose, onRemoved, onRefused }: { repo: RepoNode | null; onClose: () => void; onRemoved: (r: RemoveRepoWorktreeResult, repo: RepoNode) => void; onRefused?: (e: unknown) => void }) {
  const [lost, setLost] = useState<ChatWorktreeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const id = repo?.id;
  useEffect(() => {
    setLost(null);
    setFailure(null);
  }, [id]);
  useEscapeTop(!!repo, () => !busy && onClose());

  const run = async () => {
    if (!repo) return;
    setBusy(true);
    setFailure(null);
    try {
      onRemoved(await reposApi.removeWorktree(repo.id, lost ? 'force' : 'safe'), repo);
    } catch (e) {
      onRefused?.(e);
      if (e instanceof ApiError && e.code === WORKTREE_DIRTY) setLost((e.details as ChatWorktreeStatus | undefined) ?? { exists: true, branch: null, dirty: 0, untracked: 0, unique: 0, needsForce: true });
      else setFailure(errorText(e, 'Couldn’t remove it.'));
    } finally {
      setBusy(false);
    }
  };

  const changes = lost ? [lost.dirty > 0 && files(lost.dirty, 'changed'), lost.untracked > 0 && files(lost.untracked, 'untracked')].filter(Boolean).join(' and ') : '';
  return (
    <ConfirmDialog
      open={!!repo}
      title={lost ? 'Discard changes?' : `Remove ${clip(repo?.name ?? '', 32)}?`}
      description={
        <span className="[overflow-wrap:anywhere]">
          {lost ? `${clip(repo?.name ?? 'It', 60)} has ${changes || 'changes'} that would be lost. Remove it anyway?` : 'Its folder is deleted. The branch goes only when it is merged.'}
          {!lost && repo && repo.name.length > 32 && <span className="mt-2 block font-mono text-[13px]">{repo.name}</span>}
          {failure && <span className="mt-2 block text-danger">{failure}</span>}
        </span>
      }
      confirmLabel={lost ? 'Discard and remove' : 'Remove'}
      loading={busy}
      onConfirm={() => void run()}
      onClose={() => !busy && onClose()}
    />
  );
}
