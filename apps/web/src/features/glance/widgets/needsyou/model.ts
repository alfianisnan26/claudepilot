import { ATTENTION_KIND_LABEL, ATTENTION_KINDS, attentionDeckPath, type AttentionItem, type AttentionKind, type AttentionList } from '@portal/contracts';
import type { GlanceCompact } from '../../types';
import { chipCount, plural } from '../shared/format';

// Home's Review card (docs/prd/attention.md, T-146 slice 2): the Needs you registry's count by source and its newest item. Pure, tested.

export interface ReviewView {
  total: number;
  /** One figure per source the server has; null is "unavailable" (drawn as -), never a guessed zero. */
  sources: { kind: AttentionKind; label: string; count: number | null }[];
  /** The item that appeared last, and the deck's link to its card. */
  newest: { item: AttentionItem; to: string } | null;
}

export function reviewView(list: AttentionList): ReviewView {
  const sources = ATTENTION_KINDS.filter((k) => k in list.counts && (list.counts[k] !== null || list.unavailable.includes(k))).map((k) => ({
    kind: k,
    label: ATTENTION_KIND_LABEL[k],
    count: list.counts[k],
  }));
  const newest = list.items.reduce<AttentionItem | null>((best, i) => (!best || i.since > best.since ? i : best), null);
  return { total: list.total, sources, newest: newest ? { item: newest, to: attentionDeckPath(newest) } : null };
}

/** The chip: how many things wait; amber while any does, unknown when it could not be read. */
export function reviewCompact(list: AttentionList | null, failed: boolean): GlanceCompact {
  if (!list) return failed ? { value: '-', level: 'unknown', title: 'Review: not available', stale: true } : { value: null, level: 'unknown', title: 'Review: loading', loading: true };
  const missing = list.unavailable.length ? `, ${list.unavailable.map((k) => ATTENTION_KIND_LABEL[k]).join(', ')} unavailable` : '';
  return {
    value: chipCount(list.total),
    level: list.total ? 'warn' : 'idle',
    title: `Review: ${list.total ? `${plural(list.total, 'thing')} wait for you` : 'nothing waits for you'}${missing}`,
  };
}
