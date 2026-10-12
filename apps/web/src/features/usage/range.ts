import { CHAT_USAGE_RANGES, type ChatUsageRange } from '@portal/contracts';
import { userKey } from '@/lib/usage';

export const RANGE_LABEL: Record<ChatUsageRange, string> = { '30m': '30m', '1h': '1h', '12h': '12h', '1d': '1d', '7d': '7d', '30d': '1M' };
export const RANGE_WORDS: Record<ChatUsageRange, string> = {
  '30m': 'last 30 minutes',
  '1h': 'last hour',
  '12h': 'last 12 hours',
  '1d': 'last day',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
};
export const RANGE_OPTIONS = CHAT_USAGE_RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }));

/** The saved window is a per-user preference of this browser (`userKey`); the key it used before users were told apart is read once as a fallback. */
const RANGE_KEY = userKey('pilot.usage.range');
const LEGACY_RANGE_KEY = 'pilot.usage.range';

export function savedRange(): ChatUsageRange {
  try {
    const v = localStorage.getItem(RANGE_KEY) ?? localStorage.getItem(LEGACY_RANGE_KEY);
    return (CHAT_USAGE_RANGES as readonly string[]).includes(v ?? '') ? (v as ChatUsageRange) : '1d';
  } catch {
    return '1d';
  }
}

export function saveRange(r: ChatUsageRange): void {
  try {
    localStorage.setItem(RANGE_KEY, r);
  } catch {
    // not remembered on this device
  }
}
