import { useToast } from '@isnanme/ui';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { userKey } from '@/lib/usage';
import { alertsTab, alertsToast } from './alertText';
import { useClaudeUsage } from './useClaudeUsage';
import { useSpendAlerts } from '../spend/useSpendAlerts';

/** Which alerts this browser has shown is per user (`userKey`); the key it used before users were told apart is read once as a fallback. */
const KEY = userKey('pilot.claudeusage.seen');
const LEGACY_KEY = 'pilot.claudeusage.seen';
const KEEP = 200;

/** The alerts this device has already shown (their ids), kept in the browser: a reload or a second tab shows none of them again. */
function loadSeen(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function saveSeen(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(-KEEP)));
  } catch {
    // not remembered on this device
  }
}

/**
 * Tells the person, wherever they are in the app, when a Claude crosses 80 %, 95 % or runs out, is estimated to run out before it resets
 * (PRD claude-usage §12, §20.4), or when a budget or a spike alert fires (§23.4, §24.2): one toast for the alerts this device hasn't shown yet,
 * with a way to the tab that explains it. The portal lists the last day's alerts that aren't snoozed; this shows each once. Renders nothing.
 */
export function ClaudeUsageWatcher() {
  const { report } = useClaudeUsage();
  const spend = useSpendAlerts();
  const toast = useToast();
  const navigate = useNavigate();
  useEffect(() => {
    if (!report && !spend) return;
    const seen = loadSeen();
    const plan = (report?.alerts ?? []).filter((a) => !seen.has(a.id));
    const more = (spend ?? []).filter((a) => !seen.has(a.id));
    if (!plan.length && !more.length) return;
    saveSeen([...seen, ...plan.map((a) => a.id), ...more.map((a) => a.id)]);
    toast(alertsToast(plan, more), 'error', { label: 'View', onClick: () => navigate(`/admin/usage?tab=${alertsTab(plan, more)}`) });
  }, [report, spend, toast, navigate]);
  return null;
}
