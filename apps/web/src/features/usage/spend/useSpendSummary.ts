import type { SpendSummary } from '@portal/contracts';
import { usageSpendApi } from './api';
import { useLoad } from './useLoad';

/** The spend summary, for the tab badges (budgets that need a look, spikes of the last day). A failure leaves the badges off: they are a hint, not a page. */
export function useSpendSummary(): SpendSummary | null {
  return useLoad(() => usageSpendApi.summary(), 'summary').data;
}
