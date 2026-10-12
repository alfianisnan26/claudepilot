import { useSyncExternalStore } from 'react';

// The installed app's icon badge (Badging API). The page sets it while it runs; Chromium on desktop and Android and Safari 16.4+
// on an installed iPhone/iPad app have it, Firefox does not. A badge set here stays on the icon until it is set again or cleared, so
// after the app is closed it can go stale: only a push (a service worker waking the app) could keep it true, and there is no push
// yet (PRD web-app-pwa §11, not built). The count comes from widgets with `badge: true` (Needs attention).

type BadgeNavigator = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

/** The number on the icon: the whole, non-negative counts added up. Null until every badge widget has reported (so a slow one never clears it). */
export function badgeTotal(counts: readonly (number | null | undefined)[]): number | null {
  if (counts.some((c) => c === null || c === undefined)) return null;
  return counts.reduce<number>((sum, c) => sum + (Number.isFinite(c) && c! > 0 ? Math.floor(c!) : 0), 0);
}

export const badgeSupported = (nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean => !!nav && typeof (nav as BadgeNavigator).setAppBadge === 'function';

/** Sets the badge (0 clears it). Resolves false when the platform has none or refuses (iOS wants notification permission first). */
export async function applyBadge(total: number, nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): Promise<boolean> {
  const n = nav as BadgeNavigator | undefined;
  if (!n || typeof n.setAppBadge !== 'function') return false;
  try {
    if (total > 0) await n.setAppBadge(total);
    else await (n.clearAppBadge ? n.clearAppBadge() : n.setAppBadge(0));
    return true;
  } catch {
    return false;
  }
}

// What each badge widget last reported (null while it is still loading), as a small store.
const reported = new Map<string, number | null>();
const listeners = new Set<() => void>();
let total: number | null = null;

export function reportBadgeCount(id: string, count: number | null | undefined) {
  if (count === undefined) reported.delete(id);
  else reported.set(id, count);
  const next = badgeTotal([...reported.values()]);
  if (next !== total) {
    total = next;
    listeners.forEach((fn) => fn());
  }
}

export function forgetBadgeWidget(id: string) {
  reportBadgeCount(id, undefined);
}

/** The number to show on the icon (null: not known yet). */
export function useBadgeTotal(): number | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => total,
    () => null,
  );
}
