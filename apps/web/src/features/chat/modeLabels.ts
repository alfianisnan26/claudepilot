// A permission mode's name and one-line hint as the chat's mode chip reads them (Controls.tsx adds the icons). No React: the reporter
// panel's chat header shows the same names (PILOT-1111).
import type { ChatPermissionMode } from '@portal/contracts';

export const MODE_LABELS: Record<ChatPermissionMode, { label: string; hint: string; danger?: boolean }> = {
  plan: { label: 'Plan', hint: 'Reads and plans; changes nothing until you approve.' },
  default: { label: 'Manual', hint: 'Asks before edits and commands.' },
  acceptEdits: { label: 'Edit', hint: 'Edits files without asking; asks before commands.' },
  auto: { label: 'Auto', hint: 'A classifier approves routine actions and blocks risky ones.' },
  dontAsk: { label: 'Don’t ask', hint: 'Runs only pre-approved actions and denies the rest.' },
  bypassPermissions: { label: 'Bypass', hint: 'Runs everything without asking.', danger: true },
};
