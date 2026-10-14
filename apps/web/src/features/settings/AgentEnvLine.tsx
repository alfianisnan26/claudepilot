import { Badge, type BadgeTone } from '@isnanme/ui';
import type { AgentEnvStatus } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { useLive } from '@/lib/live';
import { settingsApi } from './api';

const STATE: Record<AgentEnvStatus['state'], { label: string; tone: BadgeTone }> = {
  applied: { label: 'Applied', tone: 'success' },
  pending: { label: 'Pending', tone: 'warning' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
};

/**
 * One terse line in a workspace's Configuration sheet: the agent policy (Settings, Agents) as it stands here.
 * The values in effect are behind the ⓘ; one that never landed is "unavailable", never the setting's value.
 */
export function AgentEnvLine({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<AgentEnvStatus | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus(await settingsApi.agentEnv(workspaceId));
    } catch {
      setStatus(null);
    }
  }, [workspaceId]);
  useEffect(() => {
    setStatus(null);
    void load();
  }, [load]);
  // A delivery finished, or a setting changed.
  useLive('workspaces', () => void load());

  if (!status) return null;
  const s = STATE[status.state];
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-surface-2 px-4 py-2.5 text-[13px]" data-testid="agent-env-line">
      <Badge tone={s.tone}>{s.label}</Badge>
      <span className="min-w-0 flex-1 truncate text-ink-soft">Agent policy</span>
      <InfoTip label="About the agent policy">
        <span className="block">Set on the Settings page, under Agents. A running Claude reads a change at its next start.</span>
        <span className="mt-2 block">
          {status.values.map((v) => (
            <span key={v.env} className="block break-all">
              {v.env}: {v.applied ?? 'unavailable'}
              {v.applied !== null && v.applied !== v.desired ? ` (next: ${v.desired})` : ''}
            </span>
          ))}
        </span>
      </InfoTip>
    </div>
  );
}
