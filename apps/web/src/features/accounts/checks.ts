import type { BadgeTone } from '@isnanme/ui';
import type { CheckResult } from '@portal/contracts';

/** How each check result reads in the UI (Account Pool PRD §11.2 and §13). */
export const CHECK: Record<CheckResult, { label: string; tone: BadgeTone; tag?: string; working: boolean }> = {
  unknown: { label: 'Not checked', tone: 'neutral', working: false },
  ok: { label: 'Working', tone: 'success', working: true },
  rate_limited: { label: 'Working · rate limited', tone: 'warning', tag: '429', working: true },
  invalid: { label: 'Invalid key', tone: 'danger', tag: 'AUTH', working: false },
  no_permission: { label: 'No permission', tone: 'danger', tag: 'AUTH', working: false },
  billing: { label: 'Billing problem', tone: 'danger', tag: 'BILL', working: false },
  spend_limit: { label: 'Spend limit reached', tone: 'danger', tag: 'CAP', working: false },
  wrong_path: { label: 'Wrong URL', tone: 'danger', tag: '404', working: false },
  unreachable: { label: 'Unreachable', tone: 'warning', tag: 'NET', working: false },
  error: { label: 'Error', tone: 'warning', tag: 'ERR', working: false },
};
