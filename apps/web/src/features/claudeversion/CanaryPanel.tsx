import { Badge, Button, Spinner, useToast, type BadgeTone } from '@isnanme/ui';
import type { ClaudeCanaryRun, ClaudeCanarySubject, ClaudeVersionOverview } from '@portal/contracts';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { versionApi } from './api';
import { Clamp } from './Bounded';
import { CanaryResults } from './CanaryResults';
import { STATUS_TONE, VERDICT_TONE } from './labels';

const CANDIDATE: Record<string, { label: string; tone: BadgeTone }> = {
  newer: { label: 'Newer', tone: 'neutral' },
  same: { label: 'Current', tone: 'success' },
  older: { label: 'Ahead', tone: 'neutral' },
  unavailable: { label: 'Unavailable', tone: 'warning' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

/**
 * The platform's Claude Code view (Settings): the installed version and the latest candidate, the scheduled canary's report
 * item by item (a break is the candidate failing what the installed version passes), warnings, Run now and the run history.
 * The cadence is the "Canary" setting in the Claude group below.
 */
export function CanaryPanel() {
  const toast = useToast();
  const [o, setO] = useState<ClaudeVersionOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [runs, setRuns] = useState<ClaudeCanaryRun[]>([]);
  const [history, setHistory] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ov, rs] = await Promise.all([versionApi.overview(), versionApi.runs(10)]);
      setO(ov);
      setRuns(rs);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLive('claudeversion', () => void load());

  if (!o) return failed ? (
      <div className="flex items-center gap-2 px-1 text-[13px] text-muted">
        <span className="flex-1">Claude Code: could not load.</span>
        <Button size="sm" variant="ghost" className="min-h-11" onClick={() => void load()}>Retry</Button>
      </div>
    ) : (
      <div className="skeleton h-24 rounded-[24px]" aria-busy="true" aria-label="Loading Claude Code" />
    );

  const run = async (subject: ClaudeCanarySubject) => {
    setBusy(subject);
    try {
      await versionApi.startCanary({ subject });
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not start the canary.'), 'error');
    } finally {
      setBusy(null);
    }
  };
  const refresh = async () => {
    setBusy('refresh');
    try {
      await versionApi.refreshCandidate();
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not read the registry.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const cand = o.report.candidateInfo;
  const cs = CANDIDATE[cand.status] ?? CANDIDATE.unknown!;
  const running = o.schedule.running;
  const sched = o.schedule.everyDays > 0 ? `every ${o.schedule.everyDays} day${o.schedule.everyDays === 1 ? '' : 's'}` : 'off';

  return (
    <section aria-labelledby="settings-claude-code">
      <h2 id="settings-claude-code" className="mb-2 px-1 text-[13px] font-semibold text-muted">
        Claude Code
      </h2>
      <Card>
        <ul className="divide-y divide-line">
          <li className="flex min-h-14 items-center gap-2 px-4 py-2.5 sm:px-5">
            <span className="flex min-w-0 flex-1 items-center gap-1 font-semibold">
              Installed
              <InfoTip label="About the installed version">
                What new workspaces are built with (default pin {o.defaultVersion}). Canary {sched}
                {o.schedule.nextAt ? `, next ${timeAgo(o.schedule.nextAt)}` : ''}; the cadence is the Canary setting below.
              </InfoTip>
            </span>
            <span className="min-w-0 truncate font-mono text-sm tabular-nums">{o.installed ?? o.defaultVersion}</span>
          </li>
          <li className="flex min-h-14 items-center gap-2 px-4 py-2.5 sm:px-5">
            <span className="flex min-w-0 flex-1 items-center gap-1 font-semibold">
              Candidate
              <InfoTip label="About the candidate">
                The registry’s newest version{cand.checkedAt ? `, read ${timeAgo(cand.checkedAt)}` : ''}.
                {cand.reason ? ` ${cand.reason}` : ''}
                {Object.keys(cand.channels).length ? ` Channels: ${Object.entries(cand.channels).map(([k, v]) => `${k} ${v}`).join(', ')}.` : ''}
              </InfoTip>
            </span>
            <Badge tone={cs.tone}>{cs.label}</Badge>
            <span className="min-w-0 truncate font-mono text-sm tabular-nums">{cand.version ?? '–'}</span>
            <Button size="icon" variant="ghost" className="min-h-11 min-w-11" aria-label="Read the registry again" onClick={refresh} loading={busy === 'refresh'}>
              <RefreshCw className="size-4" />
            </Button>
          </li>
          {o.warnings.slice(0, 5).map((w) => (
            <li key={w.id} className="flex items-center gap-2 px-4 py-2.5 text-[13px] sm:px-5">
              <Badge tone={w.severity === 'info' ? 'neutral' : w.severity === 'urgent' ? 'danger' : 'warning'}>{w.title}</Badge>
              <Clamp text={w.workspaceId ?? w.version ?? ''} className="flex-1 text-ink-soft" />
              <InfoTip label={`About ${w.title}`}>{w.detail}</InfoTip>
            </li>
          ))}
          {o.report.items.length > 0 && (
            <li className="px-4 py-2.5 sm:px-5">
              <table className="w-full text-[13px]">
                <thead className="text-left text-[12px] text-muted">
                  <tr>
                    <th className="py-1 font-medium">Check</th>
                    <th className="py-1 text-right font-medium">Installed</th>
                    <th className="py-1 text-right font-medium">Candidate</th>
                  </tr>
                </thead>
                <tbody>
                  {o.report.items.map((i) => (
                    <tr key={i.id} className={i.breaks ? 'text-danger' : undefined}>
                      <td className="py-1 pr-2">{i.label}</td>
                      <td className="py-1 text-right">{i.installed ? <Badge tone={STATUS_TONE[i.installed].tone}>{STATUS_TONE[i.installed].label}</Badge> : '–'}</td>
                      <td className="py-1 text-right">{i.candidate ? <Badge tone={STATUS_TONE[i.candidate].tone}>{STATUS_TONE[i.candidate].label}</Badge> : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!o.report.comparable && <p className="mt-1 text-[12px] text-muted">The two runs used different suites.</p>}
            </li>
          )}
          {o.report.items.length === 0 && (
            <li className="px-4 py-2.5 text-[13px] text-muted sm:px-5">No canary yet.</li>
          )}
          <li className="flex items-center gap-2 px-4 py-2.5 sm:px-5">
            <span className="min-w-0 flex-1 text-[13px] font-semibold">Run now</span>
            {running && <span role="status" aria-live="polite"><Spinner className="size-4" /><span className="sr-only">Canary running</span></span>}
            <Button size="sm" variant="secondary" className="min-h-11" onClick={() => void run('installed')} loading={busy === 'installed'} disabled={running}>
              Installed
            </Button>
            <Button size="sm" variant="secondary" className="min-h-11" onClick={() => void run('candidate')} loading={busy === 'candidate'} disabled={running || cand.status === 'unavailable'} title={cand.status === 'unavailable' ? 'The registry could not be read.' : undefined}>
              Candidate
            </Button>
          </li>
          {runs.length > 0 && (
            <li className="px-4 py-2.5 text-[13px] sm:px-5">
              <button type="button" onClick={() => setHistory((v) => !v)} aria-expanded={history} className="press flex min-h-11 items-center gap-1 text-muted">
                <ChevronRight className={`size-3.5 transition-transform motion-reduce:transition-none ${history ? 'rotate-90' : ''}`} aria-hidden />
                History
              </button>
              {history && (
                <ul className="mt-2 flex flex-col gap-2">
                  {runs.slice(0, 10).map((r) => {
                    const v = r.verdict ? VERDICT_TONE[r.verdict] : null;
                    return (
                      <li key={r.id}>
                        <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="press flex min-h-11 w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-left">
                          <span className="font-mono text-[12px]">{r.version ?? '?'}</span>
                          <span className="text-muted">{r.subject}</span>
                          {v ? <Badge tone={v.tone}>{v.label}</Badge> : <Badge tone={r.status === 'running' ? 'neutral' : 'warning'}>{r.status}</Badge>}
                          <span className="ml-auto text-muted" title={formatDateTime(r.startedAt)}>
                            {timeAgo(r.startedAt)}
                          </span>
                        </button>
                        {open === r.id && (
                          <div className="mt-1.5">
                            <CanaryResults run={r} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          )}
        </ul>
      </Card>
    </section>
  );
}
