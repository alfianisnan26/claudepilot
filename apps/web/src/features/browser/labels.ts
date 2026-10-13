import type { BadgeTone } from '@isnanme/ui';
import type { BrowserState } from '@portal/contracts';

/** One word per state (browser PRD §15.5) and the tone it takes. */
export const STATE: Record<BrowserState, { label: string; tone: BadgeTone }> = {
  none: { label: 'None', tone: 'neutral' },
  workspace_stopped: { label: 'Stopped', tone: 'neutral' },
  restart_needed: { label: 'Restart needed', tone: 'warning' },
  starting: { label: 'Starting', tone: 'neutral' },
  asleep: { label: 'Asleep', tone: 'neutral' },
  ready: { label: 'Ready', tone: 'success' },
  working: { label: 'Working', tone: 'success' },
  needs_input: { label: 'Needs you', tone: 'warning' },
  in_control: { label: 'In control', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
};
