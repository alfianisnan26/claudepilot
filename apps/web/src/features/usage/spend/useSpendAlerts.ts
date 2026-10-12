import type { SpendAlert } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@/lib/live';
import { usageSpendApi } from './api';

/**
 * The last day's budget and spike alerts that are not snoozed (null until they are read): loaded on mount and again on each `claudeusage` push, which
 * is how the portal says a budget or spike alert fired (no socket type of its own). A failed read leaves what there was: a toast is a hint, not a page.
 */
export function useSpendAlerts(): SpendAlert[] | null {
  const [alerts, setAlerts] = useState<SpendAlert[] | null>(null);
  const load = useCallback(() => {
    usageSpendApi.alerts().then(setAlerts, () => undefined);
  }, []);
  useEffect(() => load(), [load]);
  useLive('claudeusage', load);
  return alerts;
}
