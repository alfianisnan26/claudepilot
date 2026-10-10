import { Badge, Spinner, type BadgeTone } from '@isnanme/ui';
import type { ChatSessionState } from '@portal/contracts';

/** State → label and badge tone. `starting`/`working` spin; `waiting`/`interrupted` ask for you. */
export const SESSION_STATE: Record<ChatSessionState, { label: string; tone: BadgeTone; busy?: boolean }> = {
  starting: { label: 'Starting', tone: 'neutral', busy: true },
  idle: { label: 'Idle', tone: 'neutral' },
  working: { label: 'Working', tone: 'success', busy: true },
  waiting: { label: 'Needs you', tone: 'warning' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
  ended: { label: 'Ended', tone: 'neutral' },
};

/** The session's state as a pill, matching the workspace/account rows. */
export function StateBadge({ state }: { state: ChatSessionState }) {
  const s = SESSION_STATE[state];
  return (
    <Badge tone={s.tone}>
      {s.busy && <Spinner className="size-3" />}
      {s.label}
    </Badge>
  );
}

/** Which sub-agent a line came from, when it's not the main one. */
export function AgentTag({ label }: { label: string }) {
  return (
    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-muted uppercase">{label}</span>
  );
}

/** A small dollar amount: more decimals the smaller it is, so cents still read. */
export const formatUsd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
