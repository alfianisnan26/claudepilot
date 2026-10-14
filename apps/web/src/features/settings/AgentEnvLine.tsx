import { Badge, type BadgeTone } from '@isnanme/ui';
import type { AgentEnvApplies, AgentEnvStatus } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { useLive } from '@/lib/live';
import { settingsApi } from './api';

const STATE: Record<AgentEnvStatus['state'], { label: string; tone: BadgeTone }> = {
  applied: { label: 'Applied', tone: 'success' },
  pending: { label: 'Pending', tone: 'warning' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
};

/** When a change takes effect (T-302, T-309): sub-agent values at once for new sub-agents, the rest at the next start. */
const GROUPS: { applies: AgentEnvApplies; title: string }[] = [
  { applies: 'new-subagents', title: 'At once, for new sub-agents' },
  { applies: 'restart', title: 'At the next start (a new chat or a Restart)' },
];

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
  const overridden = status.values.filter((v) => v.overriddenPool);
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-surface-2 px-4 py-2.5 text-[13px]" data-testid="agent-env-line">
      <Badge tone={s.tone}>{s.label}</Badge>
      <span className="min-w-0 flex-1 truncate text-ink-soft">{overridden.length ? `${overridden.length} overridden by policy` : 'Agent policy'}</span>
      <InfoTip label="About the agent policy">
        <span className="block">Set on the Settings page, under Agents.</span>
        {GROUPS.map((g) => {
          const values = status.values.filter((v) => v.applies === g.applies);
          if (!values.length) return null;
          return (
            <span key={g.applies} className="mt-2 block" data-applies={g.applies}>
              <span className="block font-medium">{g.title}</span>
              {values.map((v) => (
                <span key={v.env} className="block [overflow-wrap:anywhere]">
                  {v.env}: {v.applied ?? 'unavailable'}
                  {v.applied !== null && v.applied !== v.desired ? ` (next: ${v.desired})` : ''}
                  {v.overriddenPool ? ` (overridden by policy: the entry in “${v.overriddenPool}” is skipped)` : ''}
                </span>
              ))}
            </span>
          );
        })}
      </InfoTip>
    </div>
  );
}
