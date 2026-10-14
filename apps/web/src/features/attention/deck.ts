import { attentionItemKey, type AttentionItem } from '@portal/contracts';

// The swipe deck's pure parts (docs/prd/attention.md, T-146 slice 2): which cards are in the deck, which are put off, where the deck
// opens, and what a drag means. Tested on their own (deck.test.ts); Deck.tsx only draws them.

/** Put off by the person and not yet due (`snoozedUntil` in the future). */
export const isLater = (i: AttentionItem, now: number): boolean => !!i.snoozedUntil && Date.parse(i.snoozedUntil) > now;

/** The deck: every item not put off, in the server's order (grouped by why, the oldest first). */
export const deckOf = (items: readonly AttentionItem[], now: number): AttentionItem[] => items.filter((i) => !isLater(i, now));

/** Put off: the soonest back first. */
export const laterOf = (items: readonly AttentionItem[], now: number): AttentionItem[] =>
  items.filter((i) => isLater(i, now)).sort((a, b) => a.snoozedUntil!.localeCompare(b.snoozedUntil!));

/** Where the deck opens: the card a link names (`?item=kind:id`, a push or the Home widget), else the first. */
export function startIndex(deck: readonly AttentionItem[], key: string | null | undefined): number {
  if (!key) return 0;
  const n = deck.findIndex((i) => attentionItemKey(i) === key);
  return n < 0 ? 0 : n;
}

/** The card shown after the one at `index` left the deck (acted on or put off): the next one, or the last when it was the last. */
export const nextIndex = (index: number, length: number): number => (length <= 0 ? 0 : Math.min(index, length - 1));

export type SwipeOutcome = 'act' | 'later' | null;

/** How far a card must travel to count: a third of its width, between 72 and 140 px. */
export const swipeThreshold = (width: number): number => Math.min(140, Math.max(72, Math.round(width / 3)));

/**
 * What a drag that ended at (dx, dy) means: right far enough is act (open the item's own action), left far enough is later. A mostly
 * vertical drag is a scroll, never a decision; a short one snaps back.
 */
export function swipeOutcome(dx: number, dy: number, width: number): SwipeOutcome {
  if (Math.abs(dy) > Math.abs(dx)) return null;
  const t = swipeThreshold(width);
  if (dx >= t) return 'act';
  if (dx <= -t) return 'later';
  return null;
}

/** The arrow keys: right acts, left puts off (the buttons are always there too). */
export const keyOutcome = (key: string): SwipeOutcome => (key === 'ArrowRight' ? 'act' : key === 'ArrowLeft' ? 'later' : null);

/** "until 14:05" in the person's clock, or the day too when it is not today. */
export function untilText(iso: string, now: number): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const hm = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === t.toDateString() ? hm : `${t.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
}
