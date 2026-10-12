import { useToast } from '@isnanme/ui';
import type { ClaudeUsageAlert } from '@portal/contracts';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { localTime, pctText } from './format';
import { useClaudeUsage } from './useClaudeUsage';

const KEY = 'pilot.claudeusage.seen';
const KEEP = 200;

/** The alerts this device has already shown (their ids), kept in the browser: a reload or a second tab shows none of them again. */
function loadSeen(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
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

/** "Satria: week 95 %", or for a window that stops the Claude "Satria: out until 14:20". */
const words = (a: ClaudeUsageAlert): string =>
  a.level === 'exhausted' ? (a.window === 'session' || a.window === 'week' ? `${a.claudeName}: out${a.resetsAt ? ` until ${localTime(a.resetsAt)}` : ''}` : `${a.claudeName}: ${a.label.toLowerCase()} used up`) : `${a.claudeName}: ${a.label.toLowerCase()} ${pctText(a.usedPct)}`;

/** The text of one toast for the alerts that are new here: the first two, and how many more. */
export function alertToast(alerts: ClaudeUsageAlert[]): string {
  const [a, b] = alerts;
  return alerts.length > 2 ? `${words(a!)} · ${words(b!)} · +${alerts.length - 2}` : alerts.length === 2 ? `${words(a!)} · ${words(b!)}` : words(a!);
}

/**
 * Tells the person, wherever they are in the app, when a Claude crosses 80 %, 95 % or runs out (PRD claude-usage §12): one
 * toast for the alerts this device hasn't shown yet, with a way to the tab. The portal lists the last day's alerts of Claudes
 * that aren't snoozed; this shows each once. Renders nothing.
 */
export function ClaudeUsageWatcher() {
  const { report } = useClaudeUsage();
  const toast = useToast();
  const navigate = useNavigate();
  useEffect(() => {
    if (!report) return;
    const seen = loadSeen();
    const fresh = report.alerts.filter((a) => !seen.has(a.id));
    if (!fresh.length) return;
    saveSeen([...seen, ...fresh.map((a) => a.id)]);
    toast(alertToast(fresh), 'error', { label: 'View', onClick: () => navigate('/admin/usage?tab=claudes') });
  }, [report, toast, navigate]);
  return null;
}
