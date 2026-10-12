// What a budget row says (docs/prd/claude-usage.md §23) and how the form's text becomes a `BudgetInput`, as pure functions so the wording and
// the rules are tested without a browser. Dollars are always estimated dollars (the budget's own tip says so); tokens are input + output + cache writes.

import type { Budget, BudgetInput, BudgetLevel, BudgetPeriod, BudgetScope, BudgetState } from '@portal/contracts';
import { formatCost, formatTokens } from '@/lib/usage/format';
import { leftText, type Tone } from '../claude/format';

/** The tone of a budget's bar: accent while within it, gold from 80 %, red from 95 % and once used up (the thresholds of the plan windows). */
export const LEVEL_TONE: Record<BudgetLevel, Tone> = { ok: 'ok', near: 'gold', high: 'danger', exhausted: 'danger' };

const SEVERITY: Record<BudgetLevel, number> = { exhausted: 3, high: 2, near: 1, ok: 0 };

/** The neediest first: used up, then 95 %, then 80 %; within a level the fuller one; a disabled budget last. */
export function sortBudgets(budgets: readonly BudgetState[]): BudgetState[] {
  const pct = (b: BudgetState) => (b.usedPct.basis === 'unavailable' ? 0 : b.usedPct.value);
  return [...budgets].sort((a, b) => Number(!a.budget.enabled) - Number(!b.budget.enabled) || SEVERITY[b.level] - SEVERITY[a.level] || pct(b) - pct(a) || a.budget.createdAt.localeCompare(b.budget.createdAt));
}

/** What the budget is called: its own name, else its scope and period ("Satria · uuws · day"). A scope that is gone reads "Removed". */
export function budgetName(s: Pick<BudgetState, 'budget' | 'scopeLabel'>): string {
  if (s.budget.name) return s.budget.name;
  const scope = s.scopeLabel ?? 'Removed';
  return `${scope} · ${s.budget.period}`;
}

/** The limit as the person set it: "$1.04", "500k tokens", or both. */
export function limitText(b: Pick<Budget, 'limitUsd' | 'limitTokens'>): string {
  const parts: string[] = [];
  if (b.limitUsd !== null) parts.push(formatCost(b.limitUsd));
  if (b.limitTokens !== null) parts.push(`${formatTokens(b.limitTokens)} tokens`);
  return parts.join(' · ');
}

/** "$1 of $1.04": what was used of the limit that decides (`limiting`), in that limit's own unit. */
export function usedText(s: Pick<BudgetState, 'budget' | 'usedUsd' | 'usedTokens' | 'limiting'>): string {
  if (s.limiting === 'usd' && s.budget.limitUsd !== null) return `${s.usedUsd.basis === 'unavailable' ? '-' : formatCost(s.usedUsd.value)} of ${formatCost(s.budget.limitUsd)}`;
  if (s.budget.limitTokens !== null) return `${s.usedTokens.basis === 'unavailable' ? '-' : formatTokens(s.usedTokens.value)} of ${formatTokens(s.budget.limitTokens)} tokens`;
  return '';
}

/** "resets in 18 h": when the period being counted ends and the count starts again. */
export function resetWords(periodEnd: string, nowMs: number): string {
  const left = leftText(periodEnd, nowMs);
  return !left || left === 'now' ? 'resets now' : `resets in ${left}`;
}

/**
 * The sentence the portal answers a refused message with when a pausing budget is used up (usagespend/service.ts, `USAGE_BUDGET`), worded from the
 * budget's state the same way, so the row that pauses says what the composer says. Dollars are said to be estimated.
 */
export function pausedSentence(s: Pick<BudgetState, 'budget' | 'scopeLabel' | 'usedUsd' | 'usedTokens' | 'periodEnd' | 'timezone'>): string {
  const b = s.budget;
  const label = b.name || `${s.scopeLabel ?? 'removed'} ${b.period === 'day' ? 'daily' : 'monthly'}`;
  const amounts = [
    b.limitUsd !== null ? `$${(s.usedUsd.value ?? 0).toFixed(2)} of $${b.limitUsd.toFixed(2)}, estimated` : null,
    b.limitTokens !== null ? `${(s.usedTokens.value ?? 0).toLocaleString('en-US')} of ${b.limitTokens.toLocaleString('en-US')} tokens` : null,
  ].filter(Boolean);
  const resets = new Intl.DateTimeFormat('en-GB', { timeZone: s.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s.periodEnd));
  return `The ${label} budget is used up (${amounts.join('; ')}). New messages are paused until it resets on ${resets} (${s.timezone}), or until it is raised or set to alerts only (Usage › Budgets).`;
}

/* ---------- The form ---------- */

export interface BudgetForm {
  name: string;
  /** `all`, `claude:<id>` or `workspace:<id>`. */
  scope: string;
  period: BudgetPeriod;
  /** Estimated dollars, as typed. */
  usd: string;
  /** Tokens, as typed. */
  tokens: string;
  pause: boolean;
}

export const EMPTY_FORM: BudgetForm = { name: '', scope: 'all', period: 'day', usd: '', tokens: '', pause: false };

export function scopeValue(scope: BudgetScope): string {
  return scope.kind === 'all' ? 'all' : `${scope.kind}:${scope.id}`;
}

export function parseScope(value: string): BudgetScope {
  if (value === 'all') return { kind: 'all', id: null };
  const at = value.indexOf(':');
  const kind = value.slice(0, at);
  return { kind: kind === 'workspace' ? 'workspace' : 'claude', id: value.slice(at + 1) };
}

export function formFrom(b: Budget): BudgetForm {
  return { name: b.name, scope: scopeValue(b.scope), period: b.period, usd: b.limitUsd === null ? '' : String(b.limitUsd), tokens: b.limitTokens === null ? '' : String(b.limitTokens), pause: b.mode === 'pause' };
}

export interface FormErrors {
  name?: string;
  usd?: string;
  tokens?: string;
  limits?: string;
}

/** A number typed in the form: empty is "no limit", otherwise above zero (and a whole number for tokens). `NaN` for something that is not a number. */
function limit(text: string, whole: boolean): number | null {
  const t = text.trim().replace(/,/g, '');
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) && v > 0 && (!whole || Number.isInteger(v)) ? v : Number.NaN;
}

/**
 * The form's text as a `BudgetInput`, or what is wrong with it. At least one limit is needed; a dollar limit is above zero; a token limit is a
 * whole number above zero; a name is at most 60 characters.
 */
export function toInput(f: BudgetForm): { input: BudgetInput; errors: null } | { input: null; errors: FormErrors } {
  const errors: FormErrors = {};
  const usd = limit(f.usd, false);
  const tokens = limit(f.tokens, true);
  if (Number.isNaN(usd)) errors.usd = 'Above 0.';
  if (Number.isNaN(tokens)) errors.tokens = 'A whole number above 0.';
  if (f.name.trim().length > 60) errors.name = 'At most 60 characters.';
  if (!errors.usd && !errors.tokens && usd === null && tokens === null) errors.limits = 'Set a dollar or a token limit.';
  if (Object.keys(errors).length) return { input: null, errors };
  return { input: { name: f.name.trim(), scope: parseScope(f.scope), period: f.period, limitUsd: usd, limitTokens: tokens, mode: f.pause ? 'pause' : 'alert' }, errors: null };
}
