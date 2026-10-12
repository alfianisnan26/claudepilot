// Usage spend: budgets (docs/prd/claude-usage.md §23). A daily or monthly budget for everything, one Claude or one workspace, in
// estimated dollars and/or tokens. Pure: how a budget's level is read off its numbers, and what a request to make or change one may say.
//
// Levels reuse the plan windows' thresholds (80 % near, 95 % high, 100 % exhausted). A budget alerts and nothing else unless its mode is
// `pause`, which a person has to choose; then, once used up, new messages are refused (a running turn is never stopped).

import { AppError } from '@isnanme/core';
import {
  BUDGET_PERIODS,
  USAGE_THRESHOLDS,
  type BudgetLevel,
  type BudgetMode,
  type BudgetPeriod,
  type BudgetScope,
  type BudgetScopeKind,
} from '@portal/contracts';

export const BUDGET_NAME_MAX = 60;
export const MAX_BUDGETS = 50;
const MAX_USD = 10_000_000;
const MAX_TOKENS = 10_000_000_000_000;
const SCOPE_KINDS: readonly string[] = ['all', 'claude', 'workspace'];
const MODES: readonly string[] = ['alert', 'pause'];
const EPS = 1e-9;

/** Percent of a limit used, to the level it is at. Exactly 80 is near, exactly 100 is used up. */
export function levelOf(pct: number): BudgetLevel {
  if (pct + EPS >= 100) return 'exhausted';
  if (pct + EPS >= USAGE_THRESHOLDS.critical) return 'high';
  if (pct + EPS >= USAGE_THRESHOLDS.warn) return 'near';
  return 'ok';
}

/** The fuller of the dollar and the token ratios (dollars when they tie), as a percent that can exceed 100. */
export function measure(used: { usd: number; tokens: number }, limit: { usd: number | null; tokens: number | null }): { pct: number; limiting: 'usd' | 'tokens' } {
  const usd = limit.usd !== null ? (used.usd * 100) / limit.usd : null;
  const tokens = limit.tokens !== null ? (used.tokens * 100) / limit.tokens : null;
  if (usd !== null && (tokens === null || usd >= tokens)) return { pct: usd, limiting: 'usd' };
  return { pct: tokens ?? 0, limiting: 'tokens' };
}

export interface BudgetFields {
  name: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  limitUsd: number | null;
  limitTokens: number | null;
  mode: BudgetMode;
  enabled: boolean;
}

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function parseScope(v: unknown): BudgetScope {
  if (!isObject(v) || typeof v.kind !== 'string' || !SCOPE_KINDS.includes(v.kind)) throw invalid('scope', 'Pick everything, a Claude or a workspace.');
  const kind = v.kind as BudgetScopeKind;
  const id = v.id === undefined || v.id === null || v.id === '' ? null : v.id;
  if (kind === 'all') {
    if (id !== null) throw invalid('scope', 'A budget for everything has no id.');
    return { kind, id: null };
  }
  if (typeof id !== 'string' || !id.trim() || id.length > 200 || CONTROL.test(id)) throw invalid('scope', kind === 'claude' ? 'Pick a Claude.' : 'Pick a workspace.');
  return { kind, id: id.trim() };
}

function parseUsd(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid('limitUsd', 'Use a number of dollars.');
  const cents = Math.round(v * 100) / 100;
  if (cents < 0.01 || cents > MAX_USD) throw invalid('limitUsd', 'Use an amount from $0.01 to $10,000,000.');
  return cents;
}

function parseTokens(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid('limitTokens', 'Use a number of tokens.');
  const n = Math.floor(v);
  if (n < 1 || n > MAX_TOKENS) throw invalid('limitTokens', 'Use a whole number of tokens above 0.');
  return n;
}

/**
 * A budget's fields from a request body. On create `base` is undefined and the scope, the period and one limit are needed; on update `base`
 * is the budget as it is, and what the body names replaces it (`null` clears a limit, so long as the other one stays).
 */
export function parseBudget(raw: unknown, base?: BudgetFields): BudgetFields {
  if (!isObject(raw)) throw new AppError('BAD_REQUEST', 'Expected a JSON object.');
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined;
  let name = base?.name ?? '';
  if (has('name')) {
    if (typeof raw.name !== 'string') throw invalid('name', 'Use text.');
    name = raw.name.trim();
    if (name.length > BUDGET_NAME_MAX || CONTROL.test(name)) throw invalid('name', `Use at most ${BUDGET_NAME_MAX} characters, on one line.`);
  }
  const scope = has('scope') ? parseScope(raw.scope) : base?.scope;
  if (!scope) throw invalid('scope', 'Pick everything, a Claude or a workspace.');
  const period = has('period') ? raw.period : base?.period;
  if (typeof period !== 'string' || !(BUDGET_PERIODS as readonly string[]).includes(period)) throw invalid('period', 'Pick day or month.');
  const limitUsd = has('limitUsd') ? parseUsd(raw.limitUsd) : (base?.limitUsd ?? null);
  const limitTokens = has('limitTokens') ? parseTokens(raw.limitTokens) : (base?.limitTokens ?? null);
  if (limitUsd === null && limitTokens === null) throw invalid('limitUsd', 'Set a limit in dollars, in tokens, or both.');
  const mode = has('mode') ? raw.mode : (base?.mode ?? 'alert');
  if (typeof mode !== 'string' || !MODES.includes(mode)) throw invalid('mode', 'Pick alert or pause.');
  const enabled = has('enabled') ? raw.enabled : (base?.enabled ?? true);
  if (typeof enabled !== 'boolean') throw invalid('enabled', 'Use true or false.');
  return { name, scope, period: period as BudgetPeriod, limitUsd, limitTokens, mode: mode as BudgetMode, enabled };
}

/** What makes a budget a different budget for its alerts: changing it starts its alerts over (they follow the new numbers). */
export const alertKey = (f: Pick<BudgetFields, 'scope' | 'period' | 'limitUsd' | 'limitTokens'>): string =>
  `${f.scope.kind}|${f.scope.id ?? ''}|${f.period}|${f.limitUsd ?? ''}|${f.limitTokens ?? ''}`;
