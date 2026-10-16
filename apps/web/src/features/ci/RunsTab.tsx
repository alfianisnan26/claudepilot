import { Button, cn, EmptyState, LoadError, Menu, RowsSkeleton, useToast } from '@isnanme/ui';
import { isCiActive, type CiRunList, type CiRunSummary, type CiStatus } from '@portal/contracts';
import { ChevronDown, ChevronsUp, CircleCheck, CircleX, List, LoaderCircle, Plus, Server, Workflow, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { ciApi } from './api';
import { elapsed, formatDuration, MONO, reasonLabel, refLabel, runLook, shortSha, StatusIcon } from './parts';
import { runnerLine } from './runners';
import { RunBumpDialog } from './RunBump';

type Scope = 'all' | 'active' | 'failed' | 'passed';

const SCOPES: { id: Scope; label: string; Icon: typeof List; status?: CiStatus[] }[] = [
  { id: 'all', label: 'All runs', Icon: List },
  { id: 'active', label: 'Running', Icon: LoaderCircle, status: ['queued', 'running'] },
  { id: 'failed', label: 'Failed', Icon: CircleX, status: ['failed'] },
  { id: 'passed', label: 'Passed', Icon: CircleCheck, status: ['passed'] },
];

/** The runs of every remote, newest first (local-git-ci PRD §15). Follows the live socket; while something runs it also asks every few seconds. */
export function RunsTab({ onNewRemote }: { onNewRemote: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const scope = (SCOPES.find((s) => s.id === params.get('s'))?.id ?? 'all') as Scope;
  const repo = params.get('repo');
  const branch = params.get('branch');
  const [data, setData] = useState<CiRunList | null>(null);
  const [repos, setRepos] = useState<{ id: string; name: string; workspaceId: string }[]>([]);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [bumping, setBumping] = useState<CiRunSummary | null>(null);
  const seq = useRef(0);

  const set = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) v === null || v === '' ? next.delete(k) : next.set(k, v);
        return next;
      },
      { replace: true },
    );

  const status = SCOPES.find((s) => s.id === scope)?.status;
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [list, r] = await Promise.all([ciApi.runs({ status, repo: repo ?? undefined, branch: branch ?? undefined, limit: 100 }), ciApi.repos()]);
      if (mine !== seq.current) return;
      setData(list);
      setRepos(r.map((x) => ({ id: x.id, name: x.name, workspaceId: x.workspaceId })));
      setFailed(false);
    } catch {
      if (mine === seq.current) setFailed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, repo, branch]);
  useEffect(() => void load(), [load]);
  useLive('ci', () => void load());

  const anyActive = data?.items.some((r) => isCiActive(r.status)) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => void load(), 5000);
    return () => (window.clearInterval(tick), window.clearInterval(poll));
  }, [anyActive, load]);

  const filtered = scope !== 'all' || !!repo || !!branch;
  const names = useMemo(() => new Map(repos.map((r) => [r.id, r.name])), [repos]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Show" className="flex shrink-0 rounded-full border border-line bg-surface p-0.5">
          {SCOPES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={scope === id}
              aria-label={label}
              title={label}
              onClick={() => set({ s: id === 'all' ? null : id })}
              className={cn('press flex size-11 items-center justify-center sm:size-10 rounded-full', scope === id ? 'bg-primary text-primary-ink' : 'text-muted hover:text-ink')}
            >
              <Icon className="size-[18px]" />
            </button>
          ))}
        </div>
        {repos.length > 1 && (
          <label className="relative shrink-0">
            <span className="sr-only">Remote</span>
            <select
              value={repo ?? ''}
              onChange={(e) => set({ repo: e.target.value || null })}
              className={cn('h-11 appearance-none sm:h-9 rounded-full border bg-surface pr-8 pl-3.5 text-[16px] font-semibold focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:text-[13.5px]', repo ? 'border-primary text-ink' : 'border-line text-ink-soft')}
            >
              <option value="">All remotes</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          </label>
        )}
        {branch && (
          <button type="button" onClick={() => set({ branch: null })} className="press inline-flex h-11 items-center sm:h-9 gap-1.5 rounded-full border border-primary bg-surface pr-2.5 pl-3.5 text-[13.5px] font-semibold" aria-label={`Clear branch ${branch}`}>
            <span className={cn(MONO, 'max-w-40 truncate')}>{branch}</span>
            <X className="size-3.5 text-muted" aria-hidden="true" />
          </button>
        )}
      </div>

      {failed && !data && <LoadError onRetry={load} />}
      {!data && !failed && <RowsSkeleton rows={4} lines={1} icon="rounded-full" />}
      {data &&
        (data.items.length === 0 ? (
          <EmptyState
            icon={<Workflow className="size-6" />}
            title={filtered ? 'No match' : 'No runs yet'}
            action={filtered ? undefined : repos.length === 0 ? <Button icon={<Plus className="size-4" />} onClick={onNewRemote}>New remote</Button> : undefined}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {data.items.map((r) => (
              <RunRow key={r.id} run={r} now={now} remote={repos.length > 1 ? names.get(r.repoId) : undefined} onOpen={() => navigate(`/admin/ci/runs/${r.id}`)} onBump={() => setBumping(r)} />
            ))}
          </ul>
        ))}
      <RunBumpDialog
        run={bumping}
        onClose={() => setBumping(null)}
        onBumped={(r) => {
          setBumping(null);
          toast(`Bumped #${r.number}`);
          void load();
        }}
      />
    </>
  );
}

/** A row opens the run; its ⋯ (outside the row's button, on the right) has Bump (FR37a). */
function RunRow({ run: r, now, remote, onOpen, onBump }: { run: CiRunSummary; now: number; remote?: string; onOpen: () => void; onBump: () => void }) {
  const duration = r.durationMs ?? (isCiActive(r.status) ? elapsed(r.startedAt ?? r.createdAt, now) : null);
  const reason = r.status === 'failed' ? reasonLabel(r.reason) : null;
  const on = runnerLine(r);
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface py-3 pr-12 pl-3.5 text-left transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <StatusIcon status={runLook(r)} className="[&_svg]:size-[22px]" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn(MONO, 'truncate text-[13.5px] font-semibold')}>{refLabel(r.branch, r.tag)}</span>
            <span className="shrink-0 text-[12.5px] font-semibold text-muted tabular-nums">#{r.number}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
            <span className={MONO} title={r.sha}>
              {shortSha(r.sha)}
            </span>
            <span>{r.pipeline}</span>
            {remote && <span>{remote}</span>}
            {on.runner && (
              <span className="inline-flex min-w-0 items-center gap-1" title={`Ran on ${on.runner}`}>
                <Server className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{on.runner}</span>
              </span>
            )}
            {on.labels.length > 0 && <span className={cn(MONO, 'truncate')}>{on.labels.join(' ')}</span>}
            {duration !== null && <span className="tabular-nums">{formatDuration(duration)}</span>}
            <span title={r.createdAt}>{timeAgo(r.createdAt)}</span>
            {reason && <span className="text-danger">{reason}</span>}
          </span>
        </span>
      </button>
      <div className="absolute top-1/2 right-1.5 -translate-y-1/2">
        <Menu label={`More for #${r.number}`} align="right" items={[{ label: 'Bump…', icon: <ChevronsUp className="size-4" />, onSelect: onBump }]} />
      </div>
    </li>
  );
}
