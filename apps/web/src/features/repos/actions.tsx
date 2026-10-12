import { useToast } from '@isnanme/ui';
import type { RepoNode, WorkspaceRepos } from '@portal/contracts';
import { Download, GitBranchPlus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { ApiError, errorText } from '@/lib/api';
import { reposApi } from './api';
import { NewWorktreeDialog } from './NewWorktreeDialog';
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog';
import type { RowMenuItem } from './RowMenu';
import { clip, shortSha } from './labels';

/** What the portal can refuse a person for (their rights on the workspace), by the kind of request. */
export type RepoVerb = 'scan' | 'worktree' | 'sync';

export interface RepoActions {
  /** A repository something is running on (a scan, a sync). */
  busy: (id: string) => boolean;
  /** The reason the portal gave (403) for each kind of request it refused here: those actions are shown disabled with it. */
  denied: Readonly<Partial<Record<RepoVerb, string>>>;
  /** Note a refusal (a 403) of a request this page made; any other error is left to the caller. */
  refused: (verb: RepoVerb, e: unknown) => void;
  scan: (n: RepoNode) => Promise<void>;
  sync: (n: RepoNode) => Promise<void>;
  keepSynced: (n: RepoNode, on: boolean) => Promise<void>;
  newWorktree: (n: RepoNode) => void;
  removeWorktree: (n: RepoNode) => void;
  /** The ⋯ menu of a repository's row. */
  items: (n: RepoNode) => RowMenuItem[];
  /** What a worktree adds to the sheet's buttons (Scan, Sync and New worktree): Keep synced and Remove. */
  worktreeItems: (n: RepoNode) => RowMenuItem[];
  /** The dialogs the actions open: render once. */
  dialogs: ReactNode;
}

/**
 * What a person can ask of a repository (workspace-git PRD FR16 to FR19): scan it, make a worktree of it, sync it, and for a worktree
 * keep it synced or remove it. One set for the rows and the sheet; each answer is a toast of a few words and the page reloads.
 */
export function useRepoActions(o: {
  workspaceId: string;
  running: boolean;
  /** Something changed: load the tree again. */
  reload: () => void;
  /** A scan's answer is the whole tree: show it at once. */
  replace: (d: WorkspaceRepos) => void;
  /** A worktree was removed (its sheet, if open, should go). */
  onRemoved?: (n: RepoNode) => void;
  /** A worktree was made. */
  onCreated?: (worktree: RepoNode) => void;
}): RepoActions {
  const toast = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [making, setMaking] = useState<RepoNode | null>(null);
  const [removing, setRemoving] = useState<RepoNode | null>(null);
  const [denied, setDenied] = useState<Readonly<Partial<Record<RepoVerb, string>>>>({});
  const { workspaceId, running, reload, replace, onRemoved, onCreated } = o;

  // What a person may do here is the portal's to say (rights per workspace): an action it refused stays disabled, with its reason, instead of being tried again.
  const refused = useCallback((verb: RepoVerb, e: unknown) => {
    if (e instanceof ApiError && e.status === 403) setDenied((d) => ({ ...d, [verb]: e.message }));
  }, []);

  const track = useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusy((s) => new Set(s).add(id));
    try {
      await fn();
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const scan = useCallback(
    (n: RepoNode) =>
      track(n.id, async () => {
        try {
          replace(await reposApi.scan(workspaceId, n.id));
        } catch (e) {
          refused('scan', e);
          toast(errorText(e, 'Couldn’t scan it.'), 'error');
        }
      }),
    [track, replace, workspaceId, toast, refused],
  );

  const sync = useCallback(
    (n: RepoNode) =>
      track(n.id, async () => {
        try {
          const r = await reposApi.syncNow(n.id);
          if (r.outcome === 'updated') toast(`${clip(n.name)} updated${r.to ? ` to ${shortSha(r.to)}` : ''}`);
          else if (r.outcome === 'current') toast(`${clip(n.name)} is up to date`);
          else toast(`Not synced${r.note ? `: ${clip(r.note, 80)}` : ''}`, 'error');
        } catch (e) {
          refused('sync', e);
          toast(errorText(e, 'Couldn’t sync it.'), 'error');
        }
        reload();
      }),
    [track, reload, toast, refused],
  );

  const keepSynced = useCallback(
    (n: RepoNode, on: boolean) =>
      track(n.id, async () => {
        try {
          await reposApi.keepSynced(n.id, on);
          toast(on ? `Keeping ${clip(n.name)} synced` : `${clip(n.name)} no longer kept synced`);
        } catch (e) {
          refused('sync', e);
          toast(errorText(e, 'Couldn’t change it.'), 'error');
        }
        reload();
      }),
    [track, reload, toast, refused],
  );

  const worktreeItems = useCallback(
    (n: RepoNode): RowMenuItem[] => {
      if (n.kind !== 'worktree') return [];
      const off = !running || busy.has(n.id);
      const live = n.sessions.some((s) => s.live);
      return [
        { label: 'Keep synced', checked: !!n.sync?.enabled, onSelect: () => void keepSynced(n, !n.sync?.enabled), disabled: off || !!denied.sync, note: denied.sync },
        // A chat running in it blocks the removal (the portal says so; the menu doesn't offer what will be refused).
        { label: 'Remove…', icon: <Trash2 className="size-4" />, onSelect: () => setRemoving(n), danger: true, disabled: off || live || !!denied.worktree, note: denied.worktree },
      ];
    },
    [running, busy, keepSynced, denied],
  );

  const items = useCallback(
    (n: RepoNode): RowMenuItem[] => {
      if (n.kind === 'missing') return [];
      const off = !running || busy.has(n.id);
      return [
        { label: 'Scan', icon: <RefreshCw className="size-4" />, onSelect: () => void scan(n), disabled: off || !!denied.scan, note: denied.scan },
        { label: 'New worktree…', icon: <GitBranchPlus className="size-4" />, onSelect: () => setMaking(n), disabled: off || !!denied.worktree, note: denied.worktree },
        { label: 'Sync', icon: <Download className="size-4" />, onSelect: () => void sync(n), disabled: off || !!denied.sync, note: denied.sync },
        ...worktreeItems(n),
      ];
    },
    [running, busy, scan, sync, worktreeItems, denied],
  );

  const dialogs = (
    <>
      <NewWorktreeDialog
        repo={making}
        onClose={() => setMaking(null)}
        onRefused={(e) => refused('worktree', e)}
        onCreated={(made) => {
          setMaking(null);
          toast(`Worktree ${clip(made.worktree.name)} made`);
          onCreated?.(made.worktree);
          reload();
        }}
      />
      <RemoveWorktreeDialog
        repo={removing}
        onClose={() => setRemoving(null)}
        onRefused={(e) => refused('worktree', e)}
        onRemoved={(result, repo) => {
          setRemoving(null);
          toast(result.branchDeleted ? `${clip(repo.name)} removed with its branch` : `${clip(repo.name)} removed`);
          onRemoved?.(repo);
          reload();
        }}
      />
    </>
  );

  return { busy: (id: string) => busy.has(id), denied, refused, scan, sync, keepSynced, newWorktree: setMaking, removeWorktree: setRemoving, items, worktreeItems, dialogs };
}
