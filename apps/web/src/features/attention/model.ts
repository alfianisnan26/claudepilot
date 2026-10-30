import { ATTENTION_WHY, ATTENTION_WHY_LABEL, type AttentionItem, type AttentionKind, type AttentionList, type AttentionWhy } from '@portal/contracts';

// Needs you, the page's pure parts (docs/prd/attention.md): grouping, the age, the badge text, the filter's choices. Tested on their own.

export const ATTENTION_PATH = '/admin/attention';

/**
 * The real asks grouped by why (the class order the server sorts by), each group oldest first. Empty groups are left out. Refused calls
 * (T-3114, `group: 'refusal'`) are not here: {@link refusalsOf} is their own collapsed group, below these.
 */
export function groupByWhy(items: readonly AttentionItem[]): { why: AttentionWhy; label: string; items: AttentionItem[] }[] {
  const asks = items.filter((i) => i.group !== 'refusal');
  return ATTENTION_WHY.map((why) => ({ why, label: ATTENTION_WHY_LABEL[why], items: asks.filter((i) => i.why === why).sort((a, b) => a.since.localeCompare(b.since)) })).filter(
    (g) => g.items.length > 0,
  );
}

/** T-3114: the refused calls, oldest first, and how many calls they stand for (a card refused 3 times counts 3). */
export function refusalsOf(items: readonly AttentionItem[]): { items: AttentionItem[]; calls: number } {
  const refused = items.filter((i) => i.group === 'refusal').sort((a, b) => a.since.localeCompare(b.since));
  return { items: refused, calls: refused.reduce((n, i) => n + Math.max(1, i.count ?? 1), 0) };
}

/** "Agents refused 1 call" / "Agents refused 7 calls": the collapsed group's one line. */
export const refusedTitle = (calls: number): string => `Agents refused ${calls} ${calls === 1 ? 'call' : 'calls'}`;

/** How long it has waited, in one short word: `now`, `12m`, `3h`, `2d`. */
export function waited(since: string, now: number): string {
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The nav's number: nothing at zero or unknown, 99+ when large. */
export const badgeText = (n: number | null | undefined): string | null => (!n || n <= 0 ? null : n > 99 ? '99+' : String(Math.trunc(n)));

/** The filter's choices: All, then each kind that has something or could not be read, with its count. */
export function kindChoices(list: AttentionList | null, labels: Record<AttentionKind, string>): { value: AttentionKind | 'all'; label: string; count: number | null }[] {
  if (!list) return [];
  const kinds = (Object.keys(list.counts) as AttentionKind[]).filter((k) => (list.counts[k] ?? 0) > 0 || list.unavailable.includes(k));
  return [{ value: 'all' as const, label: 'All', count: list.total }, ...kinds.map((k) => ({ value: k, label: labels[k], count: list.counts[k] }))];
}
