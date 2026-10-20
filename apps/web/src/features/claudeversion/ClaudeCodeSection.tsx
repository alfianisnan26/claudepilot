import { Badge, Button, ConfirmDialog, Spinner, useToast } from '@isnanme/ui';
import { claudeFeature, type ClaudeVersionHistoryEntry, type ClaudeWorkspaceVersion, type Workspace } from '@portal/contracts';
import { ChevronRight, RotateCcw, Rocket } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ApiError, errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { versionApi } from './api';
import { VERDICT_TONE, FLAG_TEXT } from './labels';
import { Bounded } from './Bounded';
import { UpgradeDialog } from './UpgradeDialog';

/**
 * The "Claude Code" part of a workspace's Configuration: the version it runs next to the one its image is pinned to, what is
 * below its minimum, Upgrade (canary first), Rollback and the small history. Refused actions stay visible and disabled, with why.
 */
export function ClaudeCodeSection({ workspace: w }: { workspace: Workspace }) {
  const toast = useToast();
  const [data, setData] = useState<ClaudeWorkspaceVersion | null>(null);
  const [failed, setFailed] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await versionApi.workspace(w.id));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [w.id]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  useLive('claudeversion', () => void load());
  useLive('workspaces', () => void load());

  if (!data) {
    return (
      <div className="flex items-center gap-2 rounded-2xl bg-surface-2 px-4 py-2.5 text-[13px] text-muted">
        {failed ? (<><span className="flex-1">Claude Code: could not load.</span><Button size="sm" variant="ghost" className="min-h-11" onClick={() => void load()}>Retry</Button></>) : <div className="skeleton h-6 w-full rounded-lg" aria-busy="true" aria-label="Loading Claude Code" />}
      </div>
    );
  }
  const { info, history } = data;
  const op = info.operation?.status === 'running' ? info.operation : null;
  const stopped = w.status !== 'running' && w.status !== 'stopped';
  // Why Upgrade or Rollback is off (shown as the button's title and in the aria label).
  const refused = denied
    ? denied
    : op
    ? 'An upgrade is running.'
    : !info.canRecreate
      ? 'This target cannot recreate the workspace.'
      : stopped
        ? 'The workspace is busy.'
        : null;
  const rollbackRefused = refused ?? (info.previous ? null : 'Nothing to go back to.');

  const rollback = async () => {
    setBusy(true);
    try {
      await versionApi.rollback(w.id);
      setRollingBack(false);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setDenied(e.message || 'You cannot change this workspace.');
      toast(errorText(e, 'Could not roll back.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-surface-2 px-4 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="whitespace-nowrap font-semibold">Claude Code</span>
        <span className="min-w-0 max-w-40 truncate font-mono tabular-nums text-ink-soft" title={info.running ?? undefined}>{info.running ?? 'unknown'}</span>
        {info.flags.some((f) => f !== 'untested') && <span className="size-1.5 rounded-full bg-amber-500" role="img" aria-label="Needs a look" />}
        <InfoTip label="About the Claude Code version">
          <span className="flex flex-col gap-1">
            <span>Pinned to {info.pinned ?? 'unknown'}{info.imageTag ? ` (${info.imageTag})` : ''}.</span>
            <span>Running {info.running ?? 'unknown'}{info.checkedAt ? `, read ${timeAgo(info.checkedAt)}` : ''}.</span>
            <span>Auto-update: {info.autoUpdate}.</span>
            {info.flags.map((f) => (
              <span key={f}>{FLAG_TEXT[f]}</span>
            ))}
          </span>
        </InfoTip>
        <span className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="secondary" className="min-h-11" icon={<Rocket className="size-4" />} onClick={() => setUpgrading(true)} disabled={!!refused} title={refused ?? undefined} aria-label="Upgrade">
            <span className="hidden min-[420px]:inline">Upgrade</span>
          </Button>
          <Button size="icon" variant="ghost" className="min-h-11 min-w-11" aria-label="Roll back" onClick={() => setRollingBack(true)} disabled={!!rollbackRefused} title={rollbackRefused ?? `Back to ${info.previous?.version ?? info.previous?.image}`}>
            <RotateCcw className="size-4" />
          </Button>
        </span>
      </div>
      {info.differs && <p className="text-amber-700 dark:text-amber-400">Pinned {info.pinned}, running {info.running}.</p>}
      {info.belowMinimum.length > 0 && (
        <p className="flex items-start gap-1 text-amber-700 dark:text-amber-400">
          <span className="min-w-0">
            Below minimum: <Bounded label="More features below minimum" items={info.belowMinimum.map((b) => `${b.label} (${b.needs})`)} />
          </span>
          <InfoTip label="About the minimums">
            {info.belowMinimum.map((b) => (
              <span key={b.feature} className="mb-1 block last:mb-0">
                {b.label}: {claudeFeature(b.feature).why} {b.enforced ? (claudeFeature(b.feature).degrades ?? '') : 'The portal only warns.'}
              </span>
            ))}
          </InfoTip>
        </p>
      )}
      {op && (
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-muted">
          <Spinner className="size-3.5" /> <span className="min-w-0 truncate" title={op.detail}>{op.kind === 'rollback' ? 'Rolling back' : `Upgrading to ${op.to ?? '…'}`}: {op.detail}</span>
        </p>
      )}
      {info.operation?.status === 'failed' && <p className="line-clamp-2 min-w-0 text-danger [overflow-wrap:anywhere]" title={info.operation.detail}>Last change failed: {info.operation.detail}</p>}
      {history.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory} className="press flex min-h-11 items-center gap-1 text-muted">
            <ChevronRight className={`size-3.5 transition-transform motion-reduce:transition-none ${showHistory ? 'rotate-90' : ''}`} aria-hidden />
            History
          </button>
          {showHistory && (
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {history.slice(0, 10).map((h) => (
                <HistoryRow key={h.id} h={h} />
              ))}
            </ul>
          )}
        </div>
      )}
      <UpgradeDialog open={upgrading} workspaceId={w.id} info={info} onClose={() => setUpgrading(false)} onStarted={() => void load()} />
      <ConfirmDialog
        open={rollingBack}
        title={`Roll back to ${info.previous?.version ?? 'the previous image'}?`}
        description="Recreates the workspace from the previous image and keeps its home folder. Running agents and terminals are interrupted."
        confirmLabel="Roll back"
        loading={busy}
        onConfirm={() => void rollback()}
        onClose={() => !busy && setRollingBack(false)}
      />
    </div>
  );
}

function HistoryRow({ h }: { h: ClaudeVersionHistoryEntry }) {
  const v = h.canary !== 'none' ? VERDICT_TONE[h.canary] : null;
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ink-soft">
      <span className="min-w-0 font-mono text-[12px] tabular-nums [overflow-wrap:anywhere]">
        {h.fromVersion ?? '?'} → {h.toVersion ?? '?'}
      </span>
      <span className="text-muted">{h.kind}</span>
      {v && <Badge tone={v.tone}>{v.label}</Badge>}
      {h.outcome === 'failed' && <Badge tone="danger">Failed</Badge>}
      <span className="ml-auto text-muted" title={formatDateTime(h.at)}>
        {timeAgo(h.at)}
      </span>
    </li>
  );
}
