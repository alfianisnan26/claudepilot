import { Button, cn, LoadError, useToast } from '@isnanme/ui';
import { isCiActive, type CiDeployment, type CiDiagnostic, type CiJob, type CiRun } from '@portal/contracts';
import { ChevronDown, ChevronLeft, ChevronRight, Hand, RotateCw, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { ciApi } from './api';
import { LogView } from './LogView';
import { elapsed, formatDuration, MONO, reasonLabel, refLabel, shortSha, StatusIcon } from './parts';
import { reportLine } from './report';
import { startedBy } from './startedBy';

/** Jobs in the order they run: by how deep their `needs` go, then as written. */
function byDepth(jobs: CiJob[]): CiJob[] {
  const depth = new Map<string, number>();
  const visit = (j: CiJob, seen: Set<string>): number => {
    const known = depth.get(j.id);
    if (known !== undefined) return known;
    if (seen.has(j.id)) return 0;
    seen.add(j.id);
    const d = j.needs.reduce((m, n) => {
      const dep = jobs.find((x) => x.id === n);
      return dep ? Math.max(m, visit(dep, seen) + 1) : m;
    }, 0);
    depth.set(j.id, d);
    return d;
  };
  jobs.forEach((j) => visit(j, new Set()));
  return [...jobs].sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0));
}

/**
 * One run (local-git-ci PRD §15): its state, the jobs it ran with their steps, and each step's log. The first step that failed
 * opens by itself (or the one running), since that is what a person came to see. Follows the live socket and, while the run
 * is going, asks again every few seconds in case a push was missed.
 */
export function RunPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const [run, setRun] = useState<CiRun | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const opened = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await ciApi.run(id);
      if (mine !== seq.current) return;
      setRun(r);
      setFailed(false);
    } catch {
      if (mine === seq.current) setFailed(true);
    }
  }, [id]);
  useEffect(() => {
    opened.current = false;
    setRun(null);
    setOpen(new Set());
    void load();
  }, [load]);
  useLive('ci', () => void load());

  const active = run ? isCiActive(run.status) : false;
  useEffect(() => {
    if (!active) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => void load(), 4000);
    return () => (window.clearInterval(tick), window.clearInterval(poll));
  }, [active, load]);

  // Open what a person wants to see first: the failed step, else the running one.
  useEffect(() => {
    if (!run || opened.current || !run.detail.length) return;
    const pick = (status: string) => {
      for (const j of run.detail) {
        const s = j.steps.find((x) => x.status === status);
        if (s) return [j.id, `${j.id}/${s.idx}`] as const;
      }
      return null;
    };
    const target = pick('failed') ?? pick('running');
    if (target) setOpen(new Set(target));
    else if (run.detail.length === 1) setOpen(new Set([run.detail[0]!.id]));
    opened.current = true;
  }, [run]);

  const jobs = useMemo(() => (run ? byDepth(run.detail) : []), [run]);
  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  const act = async (fn: () => Promise<CiRun>, done?: (r: CiRun) => void) => {
    try {
      const r = await fn();
      done?.(r);
      await load();
    } catch (e) {
      toast(errorText(e, 'That did not work.'), 'error');
    }
  };

  if (failed && !run) return <LoadError onRetry={load} />;
  if (!run) return <div className="skeleton h-40 rounded-[24px]" aria-busy="true" />;

  const reason = reasonLabel(run.reason);
  const duration = run.durationMs ?? elapsed(run.startedAt ?? run.createdAt, now);
  const stopped = run.workspaceState !== 'running' && active;
  const report = reportLine(run.reports);

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <Link to="/admin/ci" aria-label="CI" title="CI" className="press -ml-2 flex size-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
          <ChevronLeft className="size-5" />
        </Link>
        <StatusIcon status={run.status} className="[&_svg]:size-6" />
        <h1 className="min-w-0 flex-1 truncate text-xl font-bold tracking-tight sm:text-2xl">
          {run.pipeline} <span className="font-semibold text-muted">#{run.number}</span>
        </h1>
        {active && (
          <Button variant="secondary" size="icon" aria-label="Cancel" title="Cancel" icon={<Square className="size-4" />} onClick={() => act(() => ciApi.cancel(run.id))} />
        )}
        {!active && (
          <Button
            variant="secondary"
            size="icon"
            aria-label="Run again"
            title="Run again"
            icon={<RotateCw className="size-4" />}
            onClick={() => act(() => ciApi.rerun(run.id), (r) => navigate(`/admin/ci/runs/${r.id}`))}
          />
        )}
      </div>

      <div className="mb-5 flex flex-col gap-1 text-[13.5px] text-muted">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className={cn(MONO, 'max-w-full truncate text-ink')}>{refLabel(run.branch, run.tag)}</span>
          <span className={MONO} title={run.sha}>
            {shortSha(run.sha)}
          </span>
          {duration !== null && <span className="tabular-nums">{formatDuration(duration)}</span>}
          <span title={run.createdAt}>{timeAgo(run.createdAt)}</span>
        </p>
        {run.subject && (
          <p className="truncate text-ink-soft" title={run.subject}>
            {run.subject}
          </p>
        )}
        {(reason || stopped) && (
          <p className={cn('text-[13px] font-medium', stopped ? 'text-gold' : run.reason === 'rejected' ? 'text-muted' : 'text-danger')}>{stopped ? 'Workspace stopped' : reason}</p>
        )}
        {report &&
          (report.sessionId ? (
            <Link to={`/admin/sessions/${report.sessionId}`} className="-my-2.5 inline-flex min-h-11 items-center self-start text-[13px] text-accent hover:underline">
              {report.text}
            </Link>
          ) : (
            <p className="text-[13px]">{report.text}</p>
          ))}
      </div>

      {run.deployments
        .filter((d) => d.approval === 'waiting')
        .map((d) => (
          <Approval key={d.id} run={run} deployment={d} onDecided={() => void load()} />
        ))}

      {run.diagnostics.length > 0 && <Diagnostics items={run.diagnostics} />}

      {run.detail.length === 0 && run.diagnostics.length === 0 && <p className="text-[14px] text-muted">No jobs</p>}
      <ul className="flex flex-col gap-2">
        {jobs.map((j) => {
          const isOpen = open.has(j.id);
          return (
            <li key={j.id} className="rounded-2xl border border-line bg-surface">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggle(j.id)}
                title={j.needs.length ? `after ${j.needs.join(', ')}` : undefined}
                className="flex w-full min-w-0 items-center gap-3 rounded-2xl px-3.5 py-3 text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                <StatusIcon status={j.status} />
                <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold">{j.name}</span>
                {j.environment && <EnvironmentTag name={j.environment} deployment={run.deployments.find((d) => d.job === j.id)} />}
                {j.ignored && <span className="text-[12px] text-muted">ignored</span>}
                {/* A rejection is said once, on the job a person refused, and is no error. */}
                {reasonLabel(j.reason) && j.status !== 'skipped' && (j.reason !== 'rejected' || j.environment) && (
                  <span className={cn('hidden text-[12px] sm:inline', j.reason === 'rejected' ? 'text-muted' : 'text-danger')}>{reasonLabel(j.reason)}</span>
                )}
                <span className="text-[12.5px] text-muted tabular-nums">{formatDuration(j.durationMs ?? (j.status === 'running' ? elapsed(j.startedAt, now) : null))}</span>
                {isOpen ? <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />}
              </button>
              {isOpen && (
                <ul className="border-t border-line px-2 py-1.5">
                  {j.steps.map((s) => {
                    const key = `${j.id}/${s.idx}`;
                    const stepOpen = open.has(key);
                    const can = s.status !== 'pending' && s.status !== 'skipped';
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          disabled={!can}
                          aria-expanded={can ? stepOpen : undefined}
                          onClick={() => toggle(key)}
                          className="flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:opacity-60 disabled:hover:bg-transparent"
                        >
                          <StatusIcon status={s.status} className="[&_svg]:size-4" />
                          <span className="min-w-0 flex-1 truncate text-[13.5px]">{s.name}</span>
                          {s.ignored && <span className="text-[12px] text-muted">ignored</span>}
                          {s.status === 'failed' && s.exitCode !== null && <span className={cn(MONO, 'text-danger')}>exit {s.exitCode}</span>}
                          {s.status === 'failed' && reasonLabel(s.reason) && <span className="text-[12px] text-danger">{reasonLabel(s.reason)}</span>}
                          <span className="text-[12px] text-muted tabular-nums">{formatDuration(s.durationMs ?? (s.status === 'running' ? elapsed(s.startedAt, now) : null))}</span>
                        </button>
                        {stepOpen && can && <LogView key={`${run.archived}`} runId={run.id} job={j.id} step={s.idx} active={s.status === 'running'} className="mt-1 mb-2 px-1" />}
                      </li>
                    );
                  })}
                  {j.artifacts.length > 0 && (
                    <li className="px-2 py-2 text-[12.5px] text-muted" title={j.artifacts.map((a) => a.path).join('\n')}>
                      {j.artifacts.length} {j.artifacts.length === 1 ? 'artifact' : 'artifacts'}
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

const DECIDED: Partial<Record<CiDeployment['approval'], string>> = { approved: 'approved', rejected: 'rejected', auto: 'not protected', expired: 'not decided' };

/** The environment a job deploys to; its title says who decided (a hover note: the approval bar is where it is decided). */
function EnvironmentTag({ name, deployment }: { name: string; deployment: CiDeployment | undefined }) {
  const decided = deployment ? DECIDED[deployment.approval] : undefined;
  const note = decided ? `${name}: ${decided}${deployment?.decidedBy ? ` by ${deployment.decidedBy.replace(/^user:/, '')}` : ''}${deployment?.decidedAt ? `, ${timeAgo(deployment.decidedAt)}` : ''}` : name;
  return (
    <span title={note} className={cn(MONO, 'hidden max-w-[10rem] truncate rounded-full border border-line px-2 py-0.5 text-muted sm:inline')}>
      {name}
    </span>
  );
}

/**
 * A deployment held for a person (PRD FR41): where it goes, what, and the two answers. Approving lets the job start now; rejecting ends the run.
 * Only a person can do either here; an agent can start a deployment but never approve it.
 */
function Approval({ run, deployment, onDecided }: { run: CiRun; deployment: CiDeployment; onDecided: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const decide = async (what: 'approve' | 'reject') => {
    setBusy(what);
    try {
      await (what === 'approve' ? ciApi.approve(run.id, deployment.job) : ciApi.reject(run.id, deployment.job));
      toast(what === 'approve' ? `Deploying to ${deployment.environment}` : 'Rejected');
      onDecided();
    } catch (e) {
      toast(errorText(e, 'That did not work.'), 'error');
    } finally {
      setBusy(null);
    }
  };
  const by = startedBy(run);
  return (
    <section aria-label={`Approve deploy to ${deployment.environment}`} className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-gold/50 bg-gold-soft px-3.5 py-3">
      <Hand className="size-5 shrink-0 text-gold" aria-hidden="true" />
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-[14px]">
        <span className="truncate font-semibold">{deployment.environment}</span>
        <span className={cn(MONO, 'text-muted')} title={run.sha}>
          {shortSha(run.sha)}
        </span>
        <InfoTip label="About this approval">
          Job {deployment.job} deploys to {deployment.environment}. It was started by {by} and runs only once a person approves it here. Reject ends the run.
        </InfoTip>
      </p>
      {/* On a phone the two answers take their own row, so the environment's name is never cut. */}
      <span className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
        <Button variant="secondary" size="sm" className="flex-1 sm:flex-none" loading={busy === 'reject'} disabled={busy !== null} onClick={() => void decide('reject')}>
          Reject
        </Button>
        <Button size="sm" className="flex-1 sm:flex-none" loading={busy === 'approve'} disabled={busy !== null} onClick={() => void decide('approve')}>
          Approve
        </Button>
      </span>
    </section>
  );
}

/** What is wrong with a pipeline file, one line each: where, what, and what to write instead. Plain text. */
export function Diagnostics({ items }: { items: CiDiagnostic[] }) {
  return (
    <ul className="mb-4 flex flex-col gap-1.5 rounded-2xl border border-line bg-surface px-3.5 py-3" aria-label="Problems">
      {items.map((d, i) => (
        <li key={i} className="text-[13px] leading-snug">
          <span className={cn(MONO, 'mr-1.5', d.severity === 'error' ? 'text-danger' : 'text-gold')}>
            {d.file}
            {d.line ? `:${d.line}` : ''}
          </span>
          <span className="text-ink">{d.message}</span>
          {d.hint && <span className="text-muted"> {d.hint}</span>}
        </li>
      ))}
    </ul>
  );
}
