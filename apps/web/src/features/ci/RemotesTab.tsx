import { Button, cn, ConfirmDialog, CopyButton, EmptyState, LoadError, Menu, RowsSkeleton, useToast } from '@isnanme/ui';
import { type CiBranch, type CiPipelineInfo, type CiRepo, type CiStatus } from '@portal/contracts';
import { AlertTriangle, ChevronDown, ChevronRight, GitBranch, GitMerge, Lock, Play, Plus, Power } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { ciApi } from './api';
import { MONO, StatusIcon } from './parts';
import { ConnectDialog, MergeDialog, NewRemoteDialog, PipelineDialog, ProtectedDialog, RunDialog } from './RemoteDialogs';

/** The remotes workspaces host: their branches with where the checks stand, and the pipelines in them (local-git-ci PRD §15). */
export function RemotesTab({ creating, onCloseCreate, onNew }: { creating: boolean; onCloseCreate: () => void; onNew: () => void }) {
  const toast = useToast();
  const [repos, setRepos] = useState<CiRepo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [protectedFor, setProtectedFor] = useState<CiRepo | null>(null);
  const [connectFor, setConnectFor] = useState<CiRepo | null>(null);
  const [removeFor, setRemoveFor] = useState<CiRepo | null>(null);
  const [removing, setRemoving] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const list = await ciApi.repos();
      if (mine !== seq.current) return;
      setRepos(list);
      setFailed(false);
    } catch {
      if (mine === seq.current) setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLive('ci', () => void load());

  const remove = async () => {
    if (!removeFor) return;
    setRemoving(true);
    try {
      await ciApi.removeRepo(removeFor.id);
      toast(`${removeFor.name} removed`);
      setRemoveFor(null);
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not remove it.'), 'error');
      setRemoveFor(null);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <>
      {failed && !repos && <LoadError onRetry={load} />}
      {!repos && !failed && <RowsSkeleton rows={2} lines={1} icon="rounded-2xl" />}
      {repos &&
        (repos.length === 0 ? (
          <EmptyState icon={<GitBranch className="size-6" />} title="No remotes" action={<Button icon={<Plus className="size-4" />} onClick={onNew}>New remote</Button>} />
        ) : (
          <ul className="flex flex-col gap-2">
            {repos.map((r) => (
              <RemoteRow
                key={r.id}
                repo={r}
                open={open === r.id}
                onToggle={() => setOpen((o) => (o === r.id ? null : r.id))}
                onProtected={() => setProtectedFor(r)}
                onConnect={() => setConnectFor(r)}
                onRemove={() => setRemoveFor(r)}
              />
            ))}
          </ul>
        ))}

      <NewRemoteDialog
        open={creating}
        onClose={onCloseCreate}
        onCreated={(r) => {
          onCloseCreate();
          toast(`${r.name} created`);
          setOpen(r.id);
          void load();
        }}
      />
      <ProtectedDialog repo={protectedFor} onClose={() => setProtectedFor(null)} onSaved={() => (setProtectedFor(null), void load())} />
      <ConnectDialog repo={connectFor} onClose={() => setConnectFor(null)} onSaved={() => (setConnectFor(null), toast('Connected'), void load())} />
      <ConfirmDialog
        open={!!removeFor}
        title={`Remove ${removeFor?.name ?? ''}`}
        description="Deletes the remote's folder in the workspace. Connected repositories keep their pilot remote."
        confirmLabel="Remove"
        loading={removing}
        onConfirm={() => void remove()}
        onClose={() => setRemoveFor(null)}
      />
    </>
  );
}

function RemoteRow({ repo, open, onToggle, onProtected, onConnect, onRemove }: { repo: CiRepo; open: boolean; onToggle: () => void; onProtected: () => void; onConnect: () => void; onRemove: () => void }) {
  const stopped = repo.workspaceState !== 'running';
  return (
    <li className="rounded-2xl border border-line bg-surface">
      <div className="flex items-center gap-1 pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-3.5 py-3 text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          <GitBranch className="size-5 shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14.5px] font-semibold">{repo.name}</span>
            <span className="block truncate text-[12.5px] text-muted">
              {repo.workspaceId} · {repo.defaultBranch}
            </span>
          </span>
          {stopped && (
            <span title={repo.workspaceState === 'gone' ? 'Workspace gone' : 'Workspace stopped'} className="text-muted">
              <Power className="size-4" aria-hidden="true" />
              <span className="sr-only">{repo.workspaceState === 'gone' ? 'Workspace gone' : 'Workspace stopped'}</span>
            </span>
          )}
          {repo.hooks !== 'ok' && repo.hooks !== 'unknown' && !stopped && (
            <span title="The push hook is not in place" className="text-gold">
              <AlertTriangle className="size-4" aria-hidden="true" />
              <span className="sr-only">The push hook is not in place</span>
            </span>
          )}
          {open ? <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />}
        </button>
        <Menu
          label={`${repo.name} actions`}
          items={[
            { label: 'Protected branches', onSelect: onProtected },
            { label: 'Connect folder', onSelect: onConnect, disabled: stopped },
            { label: 'Remove', onSelect: onRemove, danger: true },
          ]}
        />
      </div>
      {open && <RemoteDetail repo={repo} />}
    </li>
  );
}

/** One icon for a branch: what is going on first, then what failed, then the rest. */
function worst(statuses: CiStatus[]): CiStatus {
  for (const s of ['running', 'failed', 'queued', 'cancelled'] as const) if (statuses.includes(s)) return s;
  return 'passed';
}

function RemoteDetail({ repo }: { repo: CiRepo }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [branches, setBranches] = useState<CiBranch[] | null>(null);
  const [pipelines, setPipelines] = useState<CiPipelineInfo[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [runFor, setRunFor] = useState<string | null>(null);
  const [mergeFor, setMergeFor] = useState<string | null>(null);
  const [info, setInfo] = useState<CiPipelineInfo | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    if (repo.workspaceState !== 'running') return setProblem('Start the workspace to see its branches.');
    try {
      const [b, p] = await Promise.all([ciApi.branches(repo.id), ciApi.pipelines(repo.id)]);
      if (mine !== seq.current) return;
      setBranches(b);
      setPipelines(p);
      setProblem(null);
    } catch (e) {
      if (mine === seq.current) setProblem(errorText(e, 'Could not read the remote.'));
    }
  }, [repo.id, repo.workspaceState]);
  useEffect(() => void load(), [load]);
  useLive('ci', () => void load());

  if (problem && !branches) return <p className="border-t border-line px-4 py-3 text-[13.5px] text-muted">{problem}</p>;
  if (!branches) return <div className="skeleton m-3 h-16 rounded-xl" aria-busy="true" />;

  return (
    <div className="border-t border-line px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5 px-1 text-[12.5px] text-muted">
        <span className={cn(MONO, 'min-w-0 flex-1 truncate')} title={repo.path}>
          {repo.path}
        </span>
        <CopyButton value={repo.path} label="Copy the remote's path" toastMessage="Path copied" showLabel={false} />
      </div>

      <ul className="flex flex-col">
        {branches.map((b) => (
          <li key={b.name} className="flex min-w-0 items-center gap-2 rounded-xl px-1 py-1.5">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className={cn(MONO, 'truncate font-semibold')}>{b.name}</span>
                {b.protected && (
                  <span title="Protected" className="text-muted">
                    <Lock className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">Protected</span>
                  </span>
                )}
              </span>
              <span className="block truncate text-[12.5px] text-muted" title={b.subject}>
                {b.subject} · {timeAgo(b.at)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {b.runs.length > 0 && (
                <Link
                  to={`/admin/ci?repo=${encodeURIComponent(repo.id)}&branch=${encodeURIComponent(b.name)}`}
                  aria-label={`Runs of ${b.name}: ${b.runs.map((r) => `${r.pipeline} ${r.status}`).join(', ')}`}
                  title={b.runs.map((r) => `${r.pipeline}: ${r.status}`).join('\n')}
                  className="press flex size-8 items-center justify-center rounded-full hover:bg-surface-2"
                >
                  <StatusIcon status={worst(b.runs.map((r) => r.status))} className="[&_svg]:size-[18px]" />
                </Link>
              )}
              <Button variant="ghost" size="icon" aria-label={`Run on ${b.name}`} title="Run" icon={<Play className="size-4" />} onClick={() => setRunFor(b.name)} />
              <Button variant="ghost" size="icon" aria-label={`Merge ${b.name}`} title="Merge" icon={<GitMerge className="size-4" />} onClick={() => setMergeFor(b.name)} />
            </span>
          </li>
        ))}
        {branches.length === 0 && <li className="px-1 py-2 text-[13.5px] text-muted">No branches</li>}
      </ul>

      {pipelines && pipelines.length > 0 && (
        <ul className="mt-2 flex flex-col border-t border-line pt-2">
          {pipelines.map((p) => {
            const errors = p.diagnostics.filter((d) => d.severity === 'error').length;
            const warnings = p.diagnostics.length - errors;
            return (
              <li key={p.file}>
                <button
                  type="button"
                  onClick={() => setInfo(p)}
                  className="flex w-full min-w-0 items-center gap-2 rounded-xl px-1 py-1.5 text-left hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <span className={cn(MONO, 'min-w-0 flex-1 truncate')}>{p.file.replace(/^\.pilot\//, '')}</span>
                  <span className="text-[12px] text-muted">{p.triggers.join(' ')}</span>
                  {errors > 0 && (
                    <span className="inline-flex items-center gap-1 text-[12px] text-danger" title={`${errors} errors`}>
                      <AlertTriangle className="size-3.5" aria-hidden="true" />
                      {errors}
                    </span>
                  )}
                  {errors === 0 && warnings > 0 && (
                    <span className="inline-flex items-center gap-1 text-[12px] text-gold" title={`${warnings} warnings`}>
                      <AlertTriangle className="size-3.5" aria-hidden="true" />
                      {warnings}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <RunDialog repo={runFor !== null ? repo : null} branch={runFor ?? ''} onClose={() => setRunFor(null)} onStarted={(r) => (setRunFor(null), navigate(`/admin/ci/runs/${r.id}`))} />
      <MergeDialog repo={mergeFor !== null ? repo : null} source={mergeFor ?? ''} branches={branches} onClose={() => setMergeFor(null)} onMerged={() => (setMergeFor(null), toast('Merged'), void load())} />
      <PipelineDialog info={info} onClose={() => setInfo(null)} />
    </div>
  );
}
