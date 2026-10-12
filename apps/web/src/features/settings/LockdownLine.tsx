import { Badge, type BadgeTone } from '@isnanme/ui';
import type { LockdownState, LockdownStatus } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { useLive } from '@/lib/live';
import { settingsApi } from './api';

const STATE: Record<Exclude<LockdownState, 'off'>, { label: string; tone: BadgeTone }> = {
  locked: { label: 'Locked', tone: 'success' },
  pending: { label: 'Pending', tone: 'warning' },
  not_protected: { label: 'Not protected', tone: 'danger' },
};

/** What the lockdown covers, as the few words a Locked line says. */
const covers = (s: LockdownStatus) => [s.accountOff && 'Account MCP off', s.poolOnly && 'Pool MCP only'].filter(Boolean).join(' · ');

/**
 * One terse line in a workspace's Configuration sheet: where it stands with the MCP lockdown (settings
 * page). Nothing while both switches are off. Pending says why, with the sessions to restart: Claude Code
 * never applies a change to a session that started before it.
 */
export function LockdownLine({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<LockdownStatus | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus(await settingsApi.lockdown(workspaceId));
    } catch {
      setStatus(null);
    }
  }, [workspaceId]);
  useEffect(() => {
    setStatus(null);
    void load();
  }, [load]);
  // A delivery finished, or a switch changed.
  useLive('workspaces', () => void load());

  if (!status || status.state === 'off') return null;
  const s = STATE[status.state];
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-surface-2 px-4 py-2.5 text-[13px]">
      <Badge tone={s.tone}>{s.label}</Badge>
      <span className="min-w-0 flex-1 truncate text-ink-soft" title={status.reason ?? covers(status)}>
        {status.state === 'locked' ? covers(status) : (status.reason ?? covers(status))}
      </span>
      <InfoTip label="About the MCP lockdown">Set on the Settings page. A session that started before a change has to be restarted to get it.</InfoTip>
    </div>
  );
}
