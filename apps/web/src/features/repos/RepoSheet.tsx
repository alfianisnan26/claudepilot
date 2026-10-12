import { Button, Dialog, Switch, cn } from '@isnanme/ui';
import type { ChatSessionState, RepoNode } from '@portal/contracts';
import { ArrowLeft, Download, GitBranchPlus, RefreshCw, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { SESSION_STATE } from '@/features/chat/shared';
import { formatDateTime, timeAgo } from '@/lib/format';
import type { RepoActions } from './actions';
import { BREAK, Clamp, TIP_ID, tipProps } from './clamp';
import { useEscapeTop } from './escape';
import { branchLabel, changesTitle, errorText, homePath, KIND_WORD, operationLabel, shortSha, type Tone } from './labels';
import { RepoItem } from './RepoRow';
import { TONE_TEXT } from './tone';
import { Timeline } from './Timeline';

/** "Worktree of proj": what it is to the repository around it. */
function kindLine(n: RepoNode, byId: ReadonlyMap<string, RepoNode>): string {
  const parent = n.parentId ? byId.get(n.parentId)?.name : null;
  const main = n.kind === 'worktree' && n.mainId && n.mainId !== n.parentId ? byId.get(n.mainId)?.name : null;
  const of = main ?? parent;
  if (n.kind === 'repo' || !of) return KIND_WORD[n.kind];
  if (n.kind === 'worktree') return `Worktree of ${of}`;
  if (n.kind === 'submodule') return `Submodule of ${of}`;
  if (n.kind === 'nested') return `Nested in ${of}`;
  return `Not cloned, in ${of}`;
}

/** A row of the sheet: what it is, and its value (in a tone when the value is out of the ordinary, the one place the state is told). */
function Info({ label, children, tip, tone }: { label: string; children: ReactNode; tip?: ReactNode; tone?: Tone }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3.5 py-2.5">
      <dt className="flex shrink-0 items-center gap-1 text-muted">
        {label}
        {tip && (
          <InfoTip label={`About ${label.toLowerCase()}`} className="-my-1">
            {tip}
          </InfoTip>
        )}
      </dt>
      <dd className={cn('min-w-0 text-right font-medium', BREAK, tone && TONE_TEXT[tone])}>{children}</dd>
    </div>
  );
}

/** The line under a value: muted, or in a tone when it is about something out of the ordinary. */
const sub = (tone?: Tone) => cn('mt-0.5 block text-[12.5px] font-normal', BREAK, tone ? TONE_TEXT[tone] : 'text-muted');

/**
 * One repository: where HEAD and the branch are, its changes and remotes, the worktrees and submodules under it, the sessions
 * running in it, and its timeline. Opened from a row of the Repos tab (a bottom sheet on phones); a child opens in place with a way
 * back. The actions are the row's. What is out of the ordinary is told once, in the row of the value it is about.
 */
export function RepoSheet({
  node,
  nodes,
  maxChips,
  running,
  actions,
  canGoBack,
  onBack,
  onOpen,
  onClose,
}: {
  node: RepoNode | null;
  nodes: readonly RepoNode[];
  maxChips: number;
  running: boolean;
  actions: RepoActions;
  canGoBack: boolean;
  onBack: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  useEscapeTop(!!node, onClose);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = node ? nodes.filter((n) => n.parentId === node.id) : [];
  const s = node?.state ?? null;
  const off = !running || (node ? actions.busy(node.id) : true);
  const branch = node ? branchLabel(node) : null;
  const up = s?.upstream ?? null;
  const ahead = up?.ahead ?? 0;
  const behind = up?.behind ?? 0;
  const changed = s ? s.changes.staged + s.changes.unstaged + s.changes.untracked + s.changes.conflicted : 0;
  const unpushed = s?.unpushed ?? 0;
  const groups = [
    { title: 'Worktrees', list: kids.filter((k) => k.kind === 'worktree') },
    { title: 'Submodules', list: kids.filter((k) => k.kind === 'submodule' || k.kind === 'missing') },
    { title: 'Nested', list: kids.filter((k) => k.kind === 'nested') },
  ].filter((g) => g.list.length > 0);

  return (
    <Dialog
      open={!!node}
      onClose={onClose}
      // A name is user text: it breaks anywhere rather than widen the sheet.
      title={node ? <span dir="auto" className={cn('block', BREAK)}>{node.name}</span> : ''}
      description={node && node.kind !== 'repo' ? <span dir="auto" className={BREAK}>{kindLine(node, byId)}</span> : undefined}
      stepKey={node?.id}
      leading={
        canGoBack ? (
          <button type="button" onClick={onBack} aria-label="Back" className="press -ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
            <ArrowLeft className="size-[18px]" />
          </button>
        ) : undefined
      }
    >
      {node && (
        <div className="flex flex-col gap-5">
          {node.kind !== 'missing' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} disabled={off || !!actions.denied.scan} title={actions.denied.scan} onClick={() => actions.scan(node)}>
                Scan
              </Button>
              <Button size="sm" variant="secondary" icon={<Download className="size-4" />} disabled={off || !!actions.denied.sync} title={actions.denied.sync} onClick={() => actions.sync(node)}>
                Sync
              </Button>
              <Button size="sm" variant="secondary" icon={<GitBranchPlus className="size-4" />} disabled={off || !!actions.denied.worktree} title={actions.denied.worktree} onClick={() => actions.newWorktree(node)}>
                New worktree
              </Button>
            </div>
          )}

          <dl className="divide-y divide-line rounded-2xl border border-line text-sm tabular-nums">
            {node.error && (
              <Info label="Problem" tone="danger">
                {errorText(node.error)}
              </Info>
            )}
            {branch && (
              <Info label="Branch">
                <span dir="auto" className="font-mono [overflow-wrap:anywhere]">{s?.detached ? `Detached at ${branch}` : branch}</span>
                {up && (
                  <span className={sub(behind > 0 ? 'warning' : undefined)}>
                    <span dir="auto" className="font-mono [overflow-wrap:anywhere]">{up.name}</span>
                    {up.gone ? ' (gone)' : ''}
                    {ahead ? ` · ${ahead} ahead` : ''}
                    {behind ? ` · ${behind} behind` : ''}
                  </span>
                )}
              </Info>
            )}
            {s?.operation && (
              <Info label="Operation" tone="danger">
                {operationLabel(s.operation)}
              </Info>
            )}
            {s?.head && (
              <Info label="HEAD">
                <span dir="auto" className="block">{s.head.subject || '–'}</span>
                <span className={sub()}>
                  <span className="font-mono">{shortSha(s.head.sha)}</span>
                  {s.head.author ? <> · <span dir="auto">{s.head.author}</span></> : ''}
                  {s.head.at ? (
                    <>
                      {' · '}
                      <span title={formatDateTime(s.head.at)}>{timeAgo(s.head.at)}</span>
                    </>
                  ) : null}
                </span>
              </Info>
            )}
            {s && (
              <Info label="Changes" tone={s.changes.conflicted > 0 ? 'danger' : changed > 0 ? 'warning' : undefined}>
                {changesTitle(s.changes)}
              </Info>
            )}
            {unpushed > 0 && (!up || ahead === 0) && (
              <Info label="Unpushed" tone="warning" tip="Commits that are on no remote branch: they exist only in this workspace.">
                {unpushed >= 1000 ? '1000+' : unpushed} {unpushed === 1 ? 'commit' : 'commits'}
              </Info>
            )}
            {s && s.stash > 0 && <Info label="Stash">{s.stash}</Info>}
            {node.submodule && (
              <Info label="Recorded" tone={node.submodule.drifted ? 'warning' : undefined} tip="The commit the superproject records for this submodule. When the checked-out commit differs, it is drift.">
                <span className="font-mono">{shortSha(node.submodule.recorded) || '–'}</span>
                {node.submodule.drifted && <span className={sub('warning')}>Checked out {shortSha(s?.head?.sha)}</span>}
              </Info>
            )}
            {s && s.remotes.length > 0 && (
              <Info label="Fetched" tip="The portal never fetches by itself, so ahead and behind are as of the last fetch (by a person, a session, Sync or a worktree kept synced).">
                {s.fetchedAt ? <span title={formatDateTime(s.fetchedAt)}>{timeAgo(s.fetchedAt)}</span> : 'Never'}
              </Info>
            )}
            {s && s.filters > 0 && (
              <Info label="Filters" tip="Clean and smudge filters this repo sets. The portal never runs a repo’s filters, so files they rewrite can read as changed.">
                {s.filters}
              </Info>
            )}
            {node.worktree && (node.worktree.locked || node.worktree.prunable) && <Info label="Worktree">{[node.worktree.locked && 'Locked', node.worktree.prunable && 'Folder missing'].filter(Boolean).join(' · ')}</Info>}
            {node.kind === 'worktree' && node.sync && (
              <Info label="Keep synced" tip="Fast-forward only, and only while the worktree has no changes. Sync and the timer never merge, rebase or discard.">
                <Switch
                  label="Keep synced"
                  checked={node.sync.enabled}
                  onChange={(on) => void actions.keepSynced(node, on)}
                  disabled={off || !!actions.denied.sync}
                />
                {actions.denied.sync && <span className={sub()}>{actions.denied.sync}</span>}
                {node.sync.at && node.sync.outcome && (
                  <span className={sub(node.sync.outcome === 'failed' || node.sync.outcome === 'refused' ? 'warning' : undefined)}>
                    {node.sync.outcome === 'updated' ? 'Updated' : node.sync.outcome === 'current' ? 'Up to date' : 'Not synced'}
                    {node.sync.note ? `: ${node.sync.note}` : ''} · <span title={formatDateTime(node.sync.at)}>{timeAgo(node.sync.at)}</span>
                  </span>
                )}
              </Info>
            )}
            <Info label="Folder">
              <span dir="auto" className="font-mono text-[13px] [overflow-wrap:anywhere]" title={node.path}>
                {homePath(node.path)}
              </span>
            </Info>
          </dl>

          {node.kind === 'worktree' && (
            <button
              type="button"
              disabled={off || node.sessions.some((c) => c.live) || !!actions.denied.worktree}
              title={actions.denied.worktree ?? (node.sessions.some((c) => c.live) ? 'A session is running in it.' : undefined)}
              onClick={() => actions.removeWorktree(node)}
              // The kit's small button, in the danger colours (its own variants carry colours that would clash with these).
              className="press inline-flex h-11 shrink-0 items-center gap-1.5 self-start rounded-full px-3.5 text-[13px] font-semibold whitespace-nowrap text-danger select-none hover:bg-danger-soft disabled:pointer-events-none disabled:opacity-50"
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Remove…
            </button>
          )}

          {((s && s.remotes.length > 0) || (node.kind === 'missing' && node.submodule?.url)) && (
            <section aria-label="Remotes" className="flex flex-col gap-1.5">
              <h3 className="text-[13px] font-semibold text-muted">Remotes</h3>
              <ul className="flex flex-col">
                {(s?.remotes ?? []).map((r) => (
                  <li key={r.name} className="flex items-baseline gap-2 py-1 text-[13px]">
                    <span dir="auto" className={cn('w-16 shrink-0 font-semibold', BREAK)}>
                      {r.name}
                    </span>
                    <span dir="auto" className={cn('min-w-0 flex-1 font-mono text-[12.5px] text-ink-soft', BREAK)}>
                      {r.url}
                    </span>
                    {r.local && (
                      <Link to="/admin/ci?tab=remotes" title={`The workspace’s own remote “${r.local}”`} className="-my-2 inline-flex min-h-11 shrink-0 items-center px-1 text-[12.5px] font-semibold text-ink-soft underline underline-offset-2 hover:text-ink">
                        Local
                      </Link>
                    )}
                  </li>
                ))}
                {node.kind === 'missing' && node.submodule?.url && (
                  <li className="flex items-baseline gap-2 py-1 text-[13px]">
                    <span className="w-14 shrink-0 font-semibold">url</span>
                    <span dir="auto" className={cn('min-w-0 flex-1 font-mono text-[12.5px] text-ink-soft', BREAK)}>
                      {node.submodule.url}
                    </span>
                  </li>
                )}
              </ul>
            </section>
          )}

          {node.sessions.length > 0 && (
            <section aria-label="Sessions" className="flex flex-col gap-1.5">
              <h3 className="text-[13px] font-semibold text-muted">Sessions</h3>
              <ul className="flex flex-col">
                {node.sessions.map((c) => (
                  <li key={c.id} data-clamp-owner="" onPointerEnter={tipProps.onPointerEnter} onPointerLeave={tipProps.onPointerLeave}>
                    <Link
                      to={`/admin/sessions/${encodeURIComponent(c.id)}`}
                      onFocus={tipProps.onFocus}
                      onBlur={tipProps.onBlur}
                      aria-describedby={TIP_ID}
                      className="press flex min-h-11 items-center gap-2.5 rounded-xl px-2 py-2 hover:bg-surface-2"
                    >
                      <span className={cn('size-2 shrink-0 rounded-full', c.live ? 'bg-accent' : 'bg-line-strong')} aria-hidden="true" />
                      <Clamp className="flex-1 text-sm font-medium">{c.title || 'Session'}</Clamp>
                      <span className="shrink-0 text-[12.5px] text-muted">{SESSION_STATE[c.state as ChatSessionState]?.label ?? c.state}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {groups.map((g) => (
            <section key={g.title} aria-label={g.title} className="flex flex-col gap-1.5">
              <h3 className="text-[13px] font-semibold text-muted">{g.title}</h3>
              <ul className="flex flex-col">
                {g.list.map((k) => (
                  <RepoItem key={k.id} node={k} maxChips={maxChips} onOpen={() => onOpen(k.id)} />
                ))}
              </ul>
            </section>
          ))}

          <Timeline repoId={node.id} version={`${node.scannedAt}|${s?.head?.sha ?? ''}`} />
        </div>
      )}
    </Dialog>
  );
}
