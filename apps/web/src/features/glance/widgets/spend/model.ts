import { spendTokens, type SpendSummary, type SpendTotals } from '@portal/contracts';
import { formatCost, formatTokens } from '../../../../lib/usage/format';
import type { GlanceCompact } from '../../types';

// The Usage widget and its Home card (docs/prd/glance-widgets.md §18): what was spent today and this week. Dollars are Claude Code's
// own price estimate (for a plan, what the use would cost at API prices, not a bill): always labelled "est."; tokens and requests are
// counts of recorded requests (measured). Terminal use of Claude Code is not recorded, so it is not in here.

export interface SpendFigure {
  /** "$3.20" */
  cost: string;
  /** "1.2M" (input + output + cache writes) */
  tokens: string;
  requests: number;
}

const figure = (t: SpendTotals): SpendFigure => ({ cost: formatCost(t.costUsd), tokens: formatTokens(spendTokens(t)), requests: t.requests });

export interface SpendView {
  today: SpendFigure;
  /** Since Monday's midnight; null from a portal that does not send it (unavailable, not zero). */
  week: SpendFigure | null;
  month: SpendFigure;
  timezone: string;
}

export function spendView(s: SpendSummary): SpendView {
  return { today: figure(s.today), week: s.week ? figure(s.week) : null, month: figure(s.month), timezone: s.timezone };
}

/** The chip: today's estimated cost (five characters at most), the counts in the title. */
export function spendCompact(v: SpendView | null, failed: boolean): GlanceCompact {
  if (!v) return failed ? { value: '-', level: 'unknown', title: 'Usage: not available', stale: true } : { value: null, level: 'unknown', title: 'Usage: loading', loading: true };
  const value = v.today.cost.length <= 5 ? v.today.cost : v.today.cost.replace(/\.\d+/, '');
  return { value, level: 'idle', title: `Usage today: ${v.today.cost} (estimate), ${v.today.tokens} tokens in ${v.today.requests} ${v.today.requests === 1 ? 'request' : 'requests'}` };
}
