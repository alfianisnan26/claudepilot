import type { NotifyHistoryItem, NotifyKind } from '@portal/contracts';

/** Kinds whose toast is red: something went wrong. */
const BAD = new Set<NotifyKind>(['session_failed', 'ci_failed', 'trigger_failed']);
export const toastTone = (kind: NotifyKind): 'success' | 'error' => (BAD.has(kind) ? 'error' : 'success');

/** The line a toast shows: the title, then the body when there is one. Fixed templates from the server, so no free text. */
export const toastText = (i: Pick<NotifyHistoryItem, 'title' | 'body'>) => (i.body ? `${i.title} · ${i.body}` : i.title);

/**
 * Items to toast: newer than what this tab has already seen, unread, oldest first. `seenAt` is the ISO time of the newest item the tab
 * has looked at (null on the first load, which toasts nothing: opening the page is not an event).
 */
export function freshItems(items: readonly NotifyHistoryItem[], seenAt: string | null): NotifyHistoryItem[] {
  if (seenAt === null) return [];
  return items.filter((i) => i.at > seenAt && !i.readAt).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export const newest = (items: readonly NotifyHistoryItem[]): string | null => items.reduce<string | null>((m, i) => (m === null || i.at > m ? i.at : m), null);

/** The event ids of notifications on this device that are dealt with elsewhere (the app closes them when it opens). */
export const resolvedIds = (items: readonly NotifyHistoryItem[]): Set<string> => new Set(items.filter((i) => i.resolvedAt).map((i) => i.id));

/** Day heading of the Inbox: Today, Yesterday, or the date. */
export function dayLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const day = (t: Date) => Math.floor(new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() / 86_400_000);
  const diff = day(new Date(now)) - day(d);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(d);
}
