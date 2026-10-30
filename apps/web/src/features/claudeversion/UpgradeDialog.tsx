import { Badge, Button, ConfirmDialog, Dialog, useToast } from '@isnanme/ui';
import { isExactClaudeVersion, type ClaudeCanaryRun, type ClaudeUpgradePlan, type ClaudeVersionInfo } from '@portal/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ApiError, errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { timeAgo } from '@/lib/format';
import { versionApi } from './api';
import { Bounded } from './Bounded';
import { CanaryResults } from './CanaryResults';
import { VERDICT_TONE } from './labels';

/**
 * Upgrade (claude-version-pinning PRD §7): pick an exact version, run the canary on it, read the checks, Apply. Apply needs a
 * canary that finished and passed, or the failed items accepted by name; the confirm names the running sessions and what a
 * recreate does not keep. Nothing is applied without that last tap.
 */
export function UpgradeDialog({ open, workspaceId, info, onClose, onStarted }: { open: boolean; workspaceId: string; info: ClaudeVersionInfo; onClose: () => void; onStarted: () => void }) {
  const toast = useToast();
  const [version, setVersion] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [plan, setPlan] = useState<ClaudeUpgradePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [run, setRun] = useState<ClaudeCanaryRun | null>(null);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const wanted = useRef('');

  // The versions worth offering: the candidate, the default and every image that is built.
  useEffect(() => {
    if (!open) return;
    setVersion('');
    setPlan(null);
    setRun(null);
    setAccepted([]);
    versionApi
      .overview()
      .then((o) => {
        const all = [o.report.candidateInfo.version, o.defaultVersion, ...o.images.map((i) => i.version)].filter((v): v is string => isExactClaudeVersion(v) && v !== info.running);
        setSuggestions([...new Set(all)].slice(0, 4));
      })
      .catch(() => setSuggestions([]));
  }, [open, info.running]);

  const valid = isExactClaudeVersion(version);
  const loadPlan = useCallback(async () => {
    if (!isExactClaudeVersion(wanted.current)) return;
    const v = wanted.current;
    try {
      const p = await versionApi.plan(workspaceId, v);
      if (wanted.current !== v) return;
      setPlan(p);
      setPlanError(null);
      // The newest canary on that version, unless this dialog started one that is newer.
      const id = p.canary?.runId;
      if (id) {
        const r = await versionApi.run(id).catch(() => null);
        if (r && wanted.current === v) setRun((cur) => (cur && cur.id > r.id ? cur : r));
      }
    } catch (e) {
      if (wanted.current === v) {
        setPlan(null);
        setPlanError(errorText(e, 'Could not plan this version.'));
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    wanted.current = valid ? version : '';
    setPlan(null);
    setPlanError(null);
    setRun(null);
    setAccepted([]);
    if (valid && open) void loadPlan();
  }, [version, valid, open, loadPlan]);

  // Canary progress and the end of it arrive as "load it again".
  useLive(
    'claudeversion',
    () => {
      if (run && run.status === 'running') versionApi.run(run.id).then(setRun, () => undefined);
      void loadPlan();
    },
    open,
  );
  useEffect(() => {
    if (run?.status === 'done') void loadPlan();
  }, [run?.status, loadPlan]);

  const startCanary = async () => {
    setStarting(true);
    try {
      setRun(await versionApi.startCanary({ subject: 'target', version }));
      setAccepted([]);
    } catch (e) {
      toast(errorText(e, 'Could not start the canary.'), 'error');
    } finally {
      setStarting(false);
    }
  };

  const failed = run?.results.filter((r) => r.status === 'fail').map((r) => r.id) ?? [];
  const unaccepted = failed.filter((id) => !accepted.includes(id));
  const finished = run?.status === 'done';
  const same = valid && version === info.running;
  // Why Apply is off, in a few words (the title of the disabled button and one line under the footer).
  const why = denied
    ? denied
    : !valid
    ? 'Enter an exact version.'
    : same
      ? 'It already runs this version.'
      : !plan
        ? (planError ?? 'Checking…')
        : !finished
          ? run?.status === 'running'
            ? 'The canary is running.'
            : 'Run the canary first.'
          : unaccepted.length
            ? 'Accept the failed checks to continue.'
            : plan.appliable
              ? null
              : (plan.blockers[0] ?? 'Not possible now.');

  const apply = async () => {
    if (!plan || !run) return;
    setApplying(true);
    try {
      await versionApi.apply(workspaceId, { version, canaryRunId: run.id, acceptFailed: accepted, confirm: true });
      setConfirming(false);
      onStarted();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setDenied(e.message || 'You cannot change this workspace.');
      toast(errorText(e, 'Could not apply.'), 'error');
    } finally {
      setApplying(false);
    }
  };

  const verdict = run?.verdict ? VERDICT_TONE[run.verdict] : null;
  const stale = plan?.canary?.stale && run?.id === plan.canary.runId;

  return (
    <>
      <Dialog
        open={open && !confirming}
        onClose={onClose}
        title="Upgrade"
        footer={
          <>
            <Button variant="secondary" onClick={startCanary} loading={starting} disabled={!valid || same || run?.status === 'running'}>
              {run ? 'Run again' : 'Run canary'}
            </Button>
            <Button onClick={() => setConfirming(true)} disabled={!!why} title={why ?? undefined}>
              Apply
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <div className="flex items-center gap-1.5 text-[13px] text-muted">
              <label htmlFor="claude-target-version">Version</label>
              <InfoTip label="About versions">
                An exact x.y.z. The canary runs on a throwaway container first; Apply recreates this workspace from that version’s image and keeps its home folder.
              </InfoTip>
              <span className="ml-auto font-mono text-[12px]">now {info.running ?? 'unknown'}</span>
            </div>
            <input
              id="claude-target-version"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="2.1.300"
              value={version}
              onChange={(e) => setVersion(e.target.value.trim())}
              className="mt-1.5 h-11 w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink rounded-xl border border-line bg-surface px-3 font-mono text-sm"
            />
            {version && !valid && <p role="alert" className="mt-1 text-[12px] text-danger">Use three numbers, like 2.1.300.</p>}
            {suggestions.filter((s) => s !== version).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {suggestions.filter((s) => s !== version).map((s) => (
                  <button key={s} type="button" onClick={() => setVersion(s)} className="press min-h-11 rounded-full border border-line px-3 font-mono text-[12px] text-ink-soft">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {run && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[13px]">
                <span className="font-semibold">Canary</span>
                {verdict && <Badge tone={verdict.tone}>{verdict.label}</Badge>}
                {run.finishedAt && <span className="text-muted">{timeAgo(run.finishedAt)}</span>}
                {stale && <Badge tone="warning">Stale</Badge>}
              </div>
              <CanaryResults run={run} accepted={accepted} onAccept={(id, on) => setAccepted((a) => (on ? [...a, id] : a.filter((x) => x !== id)))} />
            </div>
          )}
          {!run && plan && !plan.canary && valid && <p className="text-[13px] text-muted">No canary on this version yet.</p>}
          {plan && !plan.imageReady && <p className="text-[12.5px] text-muted">Its image is built when the canary runs.</p>}
          {why && valid && plan && (finished || same) && <p role="status" aria-live="polite" className="text-[12.5px] text-amber-700 dark:text-amber-400">{why}</p>}
          {planError && valid && <p className="text-[12.5px] text-danger">{planError}</p>}
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirming}
        title={`Apply ${version}?`}
        tone="primary"
        confirmLabel="Apply"
        loading={applying}
        onConfirm={() => void apply()}
        onClose={() => !applying && setConfirming(false)}
        description={
          <span className="flex flex-col gap-1.5 text-left">
            <span>Recreates the workspace from the new image. Its home folder is kept.</span>
            {plan && plan.sessions.length > 0 && (
              <span className="font-medium text-ink">
                Interrupts {plan.sessions.length === 1 ? 'a running agent' : `${plan.sessions.length + (plan.hiddenSessions ?? 0)} running agents`}: <Bounded label="More agents" items={plan.sessions.map((s) => s.title || s.id)} />{plan.hiddenSessions ? ` and ${plan.hiddenSessions} you cannot see` : ''}.
              </span>
            )}
            {plan && plan.terminals > 0 && <span className="font-medium text-ink">Closes {plan.terminals} terminal{plan.terminals === 1 ? '' : 's'}.</span>}
            {plan?.willLose.slice(0, 4).map((l) => (
              <span key={l}>Not kept: {l}</span>
            ))}
            {accepted.length > 0 && <span className="font-medium text-ink">Accepted failures: <Bounded label="More accepted failures" items={accepted} />.</span>}
          </span>
        }
      />
    </>
  );
}
