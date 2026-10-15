import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  USAGE_SPEND_API,
  type AttributionBy,
  type AttributionReport,
  type BudgetInput,
  type BudgetSnoozeUntil,
  type BudgetsReport,
  type BudgetState,
  type ChatUsageRange,
  type SpendAlert,
  type SpendSummary,
  type SpikesReport,
  type SpikeSnoozeUntil,
} from '@portal/contracts';
import { ApiError } from '@/lib/api';
import { attributionUrl } from './attribution';

/** Same shape as the other features' `request`: same-origin credentials, the `{ data }` / `{ error }` envelope unwrapped. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await track(
      fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<T>(json)) return json.data;
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

/** The usage-spend routes (docs/prd/claude-usage.md §21 to §26): who spent what, budgets with alerts, spike events. */
export const usageSpendApi = {
  summary: () => request<SpendSummary>('GET', USAGE_SPEND_API.summary),
  /** The last day's budget and spike alerts that are not snoozed, newest first. */
  alerts: () => request<SpendAlert[]>('GET', USAGE_SPEND_API.alerts),
  /** `done`: by ticket, only tickets closed as done in the window. */
  attribution: (by: AttributionBy, range: ChatUsageRange, done = false) => request<AttributionReport>('GET', attributionUrl(USAGE_SPEND_API.attribution, by, range, { done })),
  /** A download link for the same rows, the same filter (the browser sends the session cookie). */
  attributionCsv: (by: AttributionBy, range: ChatUsageRange, done = false) => attributionUrl(USAGE_SPEND_API.attribution, by, range, { done, csv: true }),
  budgets: () => request<BudgetsReport>('GET', USAGE_SPEND_API.budgets),
  createBudget: (input: BudgetInput) => request<BudgetState>('POST', USAGE_SPEND_API.budgets, input),
  updateBudget: (id: string, input: Partial<BudgetInput>) => request<BudgetState>('PUT', USAGE_SPEND_API.budget(id), input),
  deleteBudget: (id: string) => request<{ id: string }>('DELETE', USAGE_SPEND_API.budget(id)),
  snoozeBudget: (id: string, until: BudgetSnoozeUntil) => request<BudgetState>('PUT', USAGE_SPEND_API.budgetSnooze(id), { until }),
  unsnoozeBudget: (id: string) => request<BudgetState>('DELETE', USAGE_SPEND_API.budgetSnooze(id)),
  spikes: (range: '1d' | '7d' | '30d') => request<SpikesReport>('GET', `${USAGE_SPEND_API.spikes}?range=${range}`),
  snoozeSpike: (subject: string, until: SpikeSnoozeUntil) => request<SpikesReport>('PUT', USAGE_SPEND_API.spikeSnooze, { subject, until }),
  unsnoozeSpike: (subject: string) => request<SpikesReport>('DELETE', `${USAGE_SPEND_API.spikeSnooze}?subject=${encodeURIComponent(subject)}`),
};

/** The portal refused to show this to the person asking (several users are coming: PLAN-10). The page says so instead of pretending it is empty. */
export const isForbidden = (e: unknown): boolean => e instanceof ApiError && (e.status === 403 || e.code === 'FORBIDDEN' || e.code === 'FORBIDDEN_ACTION');
