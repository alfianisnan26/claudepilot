import { Button, cn, LoadError, Spinner, useIsDesktop, useToast } from '@isnanme/ui';
import type { Workspace } from '@portal/contracts';
import { RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { timeShort } from '@/features/chat/shared';
import { formatDateTime, timeAgo } from '@/lib/format';
import { reposApi } from './api';
import { useRepoActions } from './actions';
import { ClampTipHost } from './clamp';
import { summaryTone, treeRows } from './labels';
import { RepoRow } from './RepoRow';
import { RepoSheet } from './RepoSheet';
import { SettingsDialog } from './SettingsDialog';
import { TreeSkeleton } from './Skeleton';
import { TONE_CLASS } from './tone';
import { useWorkspaceRepos } from './useRepos';

/** A pool this big gets a field to find a repo by name. */
const FIND_FROM = 12;

/**
 * The workspace's Repos tab (workspace-git PRD §16): every repo the portal found, as a tree (submodules, nested repos and worktrees
 * indented under what they belong to), one row each with its branch and a chip for anything out of the ordinary. The count of those
 * that need attention filters the tree to them; a big pool also has a field to find one by name. Tapping a row opens its sheet; ⋯
 * has the actions.
 */
export function ReposTab({ workspace }: { workspace: Workspace }) {
  const toast = useToast();
  // Two chips on a row where there is room, one on a phone; the rest are behind `+N`.
  const maxChips = useIsDesktop() ? 2 : 1;
  const { data, failed, stale, denied, reload, replace } = useWorkspaceRepos(workspace.id);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [trail, setTrail] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scanning, setScanning] = useState(false);

  const actions = useRepoActions({
    workspaceId: workspace.id,
    running: data?.running ?? false,
    reload: () => void reload(),
    replace,
    onRemoved: (n) => setTrail((t) => t.filter((id) => id !== n.id)),
  });

  const nodes = useMemo(() => data?.repos ?? [], [data]);
  const attention = data?.summary.attention ?? 0;
  // Nothing needs attention any more: the filter has nothing to filter.
  useEffect(() => {
    if (attention === 0) setAttentionOnly(false);
  }, [attention]);
  const finding = nodes.length > FIND_FROM;
  const rows = useMemo(() => treeRows(nodes, { attentionOnly, query: finding ? query : '', folded }), [nodes, attentionOnly, finding, query, folded]);
  const openId = trail[trail.length - 1] ?? null;
  const open = openId ? (nodes.find((n) => n.id === openId) ?? null) : null;
  // A repo that is gone from the tree (a worktree removed, a folder deleted) closes its sheet.
  useEffect(() => {
    if (data && openId && !open) setTrail((t) => t.filter((id) => data.repos.some((n) => n.id === id)));
  }, [data, openId, open]);

  const scanAll = async () => {
    setScanning(true);
    try {
      replace(await reposApi.scan(workspace.id));
    } catch (e) {
      actions.refused('scan', e);
      toast(errorText(e, 'Couldn’t scan.'), 'error');
    } finally {
      setScanning(false);
    }
  };

  const fold = (id: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (denied) return <p className="py-6 text-center text-sm text-muted">{denied}</p>;
  if (failed) return <LoadError message={failed} onRetry={reload} />;
  if (!data) return <TreeSkeleton />;

  const empty = nodes.length === 0;
  const filtering = attentionOnly || (finding && query.trim() !== '');
  const scanLive = scanning || data.scan.running;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {/* Count and freshness in one slot (a polite live region): a scan swaps it for "Scanning" and back, so nothing moves. */}
        <p aria-live="polite" className="flex items-center gap-1.5 text-sm font-semibold tabular-nums text-ink-soft">
          {scanLive ? (
            <>
              <Spinner className="size-3.5" /> Scanning
            </>
          ) : empty ? null : (
            <>
              {data.summary.repos} {data.summary.repos === 1 ? 'repo' : 'repos'}
              {data.scan.at && (
                <span className="font-normal text-muted" title={`Scanned ${timeAgo(data.scan.at)} (${formatDateTime(data.scan.at)})`}>
                  · {timeShort(data.scan.at)}
                  <span className="sr-only"> scanned {timeAgo(data.scan.at)}</span>
                </span>
              )}
            </>
          )}
        </p>
        {attention > 0 && (
          <button
            type="button"
            aria-pressed={attentionOnly}
            onClick={() => setAttentionOnly((v) => !v)}
            // 32 px to look at, 44 px to hit: the pseudo-element widens the target without making the pill taller.
            className={cn(
              'press relative h-8 rounded-full px-3 text-[13px] font-semibold tabular-nums before:absolute before:-inset-y-1.5 before:-inset-x-1 before:content-[""]',
              attentionOnly ? 'bg-primary text-primary-ink' : TONE_CLASS[summaryTone(data.summary)],
            )}
          >
            Attention {attention}
          </button>
        )}
        {data.scan.truncated && !stale && (
          <span className="inline-flex items-center gap-0.5 text-[12.5px] font-semibold text-amber-700 dark:text-amber-400">
            Partial
            <InfoTip label="About a partial scan">A limit (depth, count or time) stopped the scan short, so some repos may be missing. Narrow the folders in the scanning settings.</InfoTip>
          </span>
        )}
        <div className="order-2 ml-auto flex items-center">
          <Button variant="ghost" size="sm" icon={<RefreshCw className="size-4" />} aria-label="Scan now" title={actions.denied.scan ?? 'Scan now'} disabled={!data.running || !!actions.denied.scan} loading={scanLive} onClick={() => void scanAll()} />
          <Button variant="ghost" size="sm" icon={<SlidersHorizontal className="size-4" />} aria-label="Scanning settings" title="Scanning settings" onClick={() => setSettingsOpen(true)} />
        </div>
        {finding && (
          <div className="order-3 flex h-10 w-full items-center rounded-full border border-line bg-surface px-3.5 transition-[border-color,box-shadow] duration-150 focus-within:border-ink/40 focus-within:ring-4 focus-within:ring-[var(--ring)] hover:border-line-strong tap:h-11 sm:order-none sm:w-auto sm:min-w-28 sm:flex-1">
            <input
              type="search"
              aria-label="Find a repo"
              maxLength={100}
              placeholder="Find a repo"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-full w-full min-w-0 bg-transparent text-base text-ink outline-none placeholder:text-muted/70"
            />
          </div>
        )}
      </div>

      <ProblemLine error={stale ?? data.scan.error} onRetry={stale ? reload : undefined} />

      {empty ? (
        <p className="py-6 text-center text-sm text-muted">
          {!data.running ? 'Start the workspace to scan for repos.' : data.scan.at ? 'No repos found.' : data.scan.running ? 'Looking for repos…' : 'Not scanned yet.'}
        </p>
      ) : rows.length === 0 && filtering ? (
        <p className="py-6 text-center text-sm text-muted">{query.trim() !== '' ? 'No repo matches.' : 'Nothing needs attention.'}</p>
      ) : (
        <ul className="-mx-1 flex flex-col">
          {rows.map((row) => (
            <RepoRow key={row.node.id} row={row} busy={actions.busy(row.node.id)} items={actions.items(row.node)} maxChips={maxChips} onOpen={() => setTrail([row.node.id])} onFold={() => fold(row.node.id)} />
          ))}
        </ul>
      )}

      <RepoSheet
        node={open}
        nodes={nodes}
        maxChips={maxChips}
        running={data.running}
        actions={actions}
        canGoBack={trail.length > 1}
        onBack={() => setTrail((t) => t.slice(0, -1))}
        onOpen={(id) => setTrail((t) => [...t, id])}
        onClose={() => setTrail([])}
      />
      <SettingsDialog
        workspaceId={workspace.id}
        settings={data.settings}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(_saved, rootsChanged) => {
          setSettingsOpen(false);
          toast('Saved');
          // New folders are only looked at by a walk: do it now.
          if (rootsChanged) void scanAll();
          else void reload();
        }}
      />
      {actions.dialogs}
      <ClampTipHost />
    </div>
  );
}

/** Why the tree may not be right, in one line when there is a reason: the last copy is all there is (the portal can't be reached) or a scan failed. */
function ProblemLine({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-danger [overflow-wrap:anywhere]">
      {error}
      {onRetry && (
        <button type="button" onClick={onRetry} className="-my-2 inline-flex min-h-11 items-center font-semibold text-ink-soft underline underline-offset-2 hover:text-ink">
          Retry
        </button>
      )}
    </p>
  );
}
