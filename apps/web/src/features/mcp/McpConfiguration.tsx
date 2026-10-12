import { Badge, Button, Spinner, useToast } from '@isnanme/ui';
import type { McpServerStatus, McpWorkspaceStatus, Workspace, WorkspacePoolAssignment } from '@portal/contracts';
import { KeyRound, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { mcpApi } from './api';
import { clock, DELIVERY, VERIFY } from './labels';
import { MONO } from './parts';

/**
 * The MCP sets row's detail in a workspace's Configuration (PRD §15, FR17): each server's delivery state
 * with its next step, the npm pre-install (§12) with Retry, whether Claude Code lists the set's servers
 * (FR16) with "Verify again", names the workspace's Secrets sets don't provide (US3), FR11's warnings,
 * and when changes apply (§10.3). Every in-workspace status says "as of HH:MM".
 */
export function McpConfiguration({ workspace, assignments }: { workspace: Workspace; assignments: WorkspacePoolAssignment[] }) {
  const toast = useToast();
  const [data, setData] = useState<McpWorkspaceStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<'installs' | 'verify' | null>(null);
  const running = workspace.status === 'running';
  const id = workspace.id;

  const load = useCallback(async () => {
    try {
      setData(await mcpApi.workspace(id));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);
  useEffect(() => void load(), [load, assignments.length]);
  useLive('pools', () => void load());

  const run = async (what: 'installs' | 'verify') => {
    setBusy(what);
    try {
      await (what === 'installs' ? mcpApi.retryInstalls(id) : mcpApi.verify(id));
      toast(what === 'installs' ? 'Installing again' : 'Checking the sets in the workspace');
    } catch (e) {
      toast(errorText(e, 'Could not start it.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (failed && !data) return <p className="text-[13px] text-muted">Could not load the servers’ status.</p>;
  if (!data) return null;
  const { servers, verify, missingNames, warnings } = data;
  const sets = new Set(servers.map((s) => s.poolId)).size;
  const latest = [...servers.map((s) => s.updatedAt), ...verify.map((v) => v.at)].sort().at(-1);
  const installFailed = servers.some((s) => s.install?.state === 'failed');
  const unverified = verify.filter((v) => v.result !== 'ok');
  const delivered = servers.some((s) => s.state === 'delivered' || s.state === 'pending_start');

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      {servers.length === 0 ? (
        <p className="text-muted">Nothing delivered yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((s) => (
            <ServerLine key={`${s.plugin}/${s.key}`} server={s} showSet={sets > 1} />
          ))}
        </ul>
      )}
      {missingNames.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl bg-flame-soft px-3 py-2 text-ink-soft">
          <KeyRound className="mt-0.5 size-4 shrink-0" />
          <span>
            Needs{' '}
            <span className="text-[12px]" style={{ fontFamily: MONO }}>
              {missingNames.join(', ')}
            </span>
            : assign a Secrets set that has {missingNames.length === 1 ? 'it' : 'them'}.
          </span>
        </p>
      )}
      {unverified.map((v) => (
        <p key={v.plugin} className="text-ink-soft">
          <Badge tone={VERIFY[v.result].tone}>{VERIFY[v.result].label}</Badge>{' '}
          <span className="text-[12px]" style={{ fontFamily: MONO }}>
            {v.plugin}
          </span>
          {v.detail ? `: ${v.detail}` : ''} <span className="text-muted">as of {clock(v.at)}</span>
        </p>
      ))}
      {warnings.map((w) => (
        <p key={w} className="flex items-start gap-2 text-ink-soft">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-flame" />
          {w}
        </p>
      ))}
      {(servers.length > 0 || installFailed) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {latest && <span className="text-[12px] text-muted">As of {clock(latest)}</span>}
          {delivered && <InfoTip label="When changes apply">Applies in new sessions, or after /reload-plugins. In portal chat, start a new session.</InfoTip>}
          <span className="flex-1" />
          {installFailed && (
            <Button variant="secondary" size="sm" onClick={() => void run('installs')} disabled={!running || !!busy}>
              {busy === 'installs' ? <Spinner className="size-3" /> : 'Retry installs'}
            </Button>
          )}
          {delivered && (
            <Button variant="ghost" size="icon" aria-label="Verify again" title="Verify again" onClick={() => void run('verify')} disabled={!running || !!busy} className="size-8">
              {busy === 'verify' ? <Spinner className="size-3" /> : <RefreshCw className="size-4" />}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ServerLine({ server: s, showSet }: { server: McpServerStatus; showSet: boolean }) {
  const state = DELIVERY[s.state];
  const notListed = s.listed === false;
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-ink" style={{ fontFamily: MONO }}>
          {s.key}
        </span>
        <span className="text-ink-soft">
          {s.entryName} {s.version}
        </span>
        {showSet && <span className="text-muted">in {s.poolName}</span>}
        <Badge tone={state.tone}>{state.label}</Badge>
        {s.install?.state === 'installing' && <Badge tone="neutral">Installing</Badge>}
        {s.install?.state === 'failed' && <Badge tone="danger">Install failed</Badge>}
        {notListed && <Badge tone="danger">Not loaded</Badge>}
      </span>
      {s.reason && <span className="text-muted">{s.reason}</span>}
      {s.install?.state === 'failed' && s.install.error && <span className="text-muted">{s.install.error}</span>}
    </li>
  );
}
