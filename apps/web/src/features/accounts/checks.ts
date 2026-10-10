import type { BadgeTone } from '@isnanme/ui';
import type { AccountHealthState, CheckResult } from '@portal/contracts';

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

/** Health that failover acts on (Account Pool PRD §11.3). While `ok`, the check result shows instead. */
export const HEALTH: Record<Exclude<AccountHealthState, 'ok'>, { label: string; tone: BadgeTone; tag: string; clear: string }> = {
  cooling: { label: 'Cooling', tone: 'warning', tag: '429', clear: 'End cooldown' },
  exhausted: { label: 'Exhausted', tone: 'danger', tag: 'CAP', clear: 'End cooldown' },
  billing: { label: 'Billing problem', tone: 'danger', tag: 'BILL', clear: 'Mark as working' },
  invalid: { label: 'Invalid key', tone: 'danger', tag: 'AUTH', clear: 'Mark as working' },
  attention: { label: 'Needs attention', tone: 'danger', tag: 'ERR', clear: 'Mark as working' },
};
