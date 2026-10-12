import { Badge, Button, Spinner, useToast } from '@isnanme/ui';
import type { Workspace, WorkspacePoolAssignment, WorkspaceSkills, WorkspaceSkillset } from '@portal/contracts';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { formatUntil } from '@/lib/format';
import { useLive } from '@/lib/live';
import { skillsApi } from './api';
import { MONO, VERIFY } from './labels';

/** §10.4: after a change, open sessions need `/reload-plugins` or a restart: shown for an hour. */
const RELOAD_NOTICE_MS = 60 * 60_000;
const SHOWN = 6;
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * The Skills row's detail in a workspace's Configuration (Skillset PRD §13, FR24): each set with its
 * revision, delivery and verification status, the commands it gives (`/<prefix>:<name>`) with Manual and
 * Scripted marked, skills left out and why, commands blocked after a revocation, whether Claude Code is
 * too old (FR20), and when open sessions need `/reload-plugins`.
 */
export function SkillsConfiguration({ workspace, assignments }: { workspace: Workspace; assignments: WorkspacePoolAssignment[] }) {
  const toast = useToast();
  const [data, setData] = useState<WorkspaceSkills | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = workspace.id;

  const load = useCallback(async () => {
    try {
      setData(await skillsApi.workspace(id));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);
  useEffect(() => void load(), [load, assignments.length]);
  useLive('pools', () => void load());

  const verify = async () => {
    setBusy(true);
    try {
      setData(await skillsApi.verify(id));
      toast('Checked the skills in the workspace');
    } catch (e) {
      toast(errorText(e, 'Could not check them.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (assignments.every((a) => a.state !== 'assigned')) return null;
  if (failed && !data) return <p className="text-[13px] text-muted">Could not load the skills’ status.</p>;
  if (!data) return null;
  const changedRecently = data.changedAt && Date.now() - new Date(data.changedAt).getTime() < RELOAD_NOTICE_MS;
  const running = workspace.status === 'running';
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      {data.tooOld && (
        <p className="flex items-start gap-2 rounded-xl bg-flame-soft px-3 py-2 text-ink-soft">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-flame" />
          <span>
            Claude Code {data.claudeVersion?.replace(/\s*\(Claude Code\)/, '')} is too old (needs {data.minClaudeVersion}).
          </span>
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {data.sets.map((s) => (
          <SetLine key={s.poolId} set={s} showName={data.sets.length > 1} />
        ))}
      </ul>
      <div className="flex items-center gap-1.5 text-[12px] text-muted">
        {data.verification && (
          <span>
            {VERIFY[data.verification.status].label} {clock(data.verification.at)}
          </span>
        )}
        {changedRecently && data.changedAt && (
          <>
            <span>· changed {clock(data.changedAt)}</span>
            <InfoTip label="About the change">Open sessions need /reload-plugins, or start a new session.</InfoTip>
          </>
        )}
        <Button variant="ghost" size="icon" aria-label="Verify again" title="Verify again" onClick={() => void verify()} disabled={!running || busy} className="ml-auto size-8">
          {busy ? <Spinner className="size-3" /> : <RefreshCw className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

function SetLine({ set: s, showName }: { set: WorkspaceSkillset; showName: boolean }) {
  const [all, setAll] = useState(false);
  const status = VERIFY[s.status];
  const shown = all ? s.skills : s.skills.slice(0, SHOWN);
  return (
    <li className="flex flex-col gap-1.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {showName && <span className="font-medium text-ink">{s.poolName}</span>}
        {showName && s.revision > 0 && <span className="text-[12px] text-muted">r{s.revision}</span>}
        <Badge tone={status.tone}>
          {s.status === 'pending' && <Spinner className="size-3" />}
          {status.label}
        </Badge>
      </span>
      {s.message && <span className="text-muted">{s.message}</span>}
      {s.skills.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {shown.map((k) => (
            <li key={k.name} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-ink-soft" title={`${k.hash}${k.mode === 'manual' ? ' · only when typed' : ''}`}>
              <span style={{ fontFamily: MONO }}>{k.command}</span>
              {k.mode === 'manual' && <span className="text-muted">typed only</span>}
              {k.scripted && <span className="text-flame">scripted</span>}
            </li>
          ))}
          {s.skills.length > SHOWN && (
            <li>
              <button type="button" onClick={() => setAll((v) => !v)} className="rounded-full px-2.5 py-1 text-[12px] font-semibold text-accent hover:underline">
                {all ? 'Show fewer' : `+${s.skills.length - SHOWN} more`}
              </button>
            </li>
          )}
        </ul>
      )}
      {s.leftOut.map((l) => {
        const blocked = s.blocked.filter((b) => b.command.endsWith(`:${l.name}`));
        return (
          <span key={l.name} className="flex items-center gap-1 text-muted">
            <span>
              <span style={{ fontFamily: MONO }}>{l.name}</span> isn’t delivered: {l.reason}
            </span>
            {blocked.length > 0 && <InfoTip label={`About ${l.name}`}>Its command stays blocked until {formatUntil(blocked[0]!.until)}.</InfoTip>}
          </span>
        );
      })}
      {s.blocked
        .filter((b) => !s.leftOut.some((l) => b.command.endsWith(`:${l.name}`)))
        .map((b) => (
          <span key={b.command} className="text-muted">
            <span style={{ fontFamily: MONO }}>{b.command}</span> blocked until {formatUntil(b.until)}
          </span>
        ))}
    </li>
  );
}
