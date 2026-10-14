import { useToast } from '@isnanme/ui';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '@/lib/auth';
import { useLive, usePresenceSender } from '@/lib/live';
import { notifyApi } from './api';
import { freshItems, newest, resolvedIds, toastText, toastTone } from './inbox';
import { presenceOf, samePresence } from './presence';
import { browserZone, needsZoneRepair } from './quiet';
import { loadNotifyOverview, useNotifyOverview } from './store';
import { thisDeviceId } from './deviceId';
import { syncPush } from './usePush';

/** Closes notifications on this device whose event was dealt with elsewhere (PWA PRD 11.2, "Resolved elsewhere"). */
async function closeResolved(ids: Set<string>) {
  if (ids.size === 0) return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    for (const n of (await reg?.getNotifications()) ?? []) {
      const id = (n.data as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && ids.has(id)) n.close();
    }
  } catch {
    // no worker, nothing to close
  }
}

/**
 * Mounted once, signed in, over every page: reports presence (this tab is visible and used, and which session it shows), turns new
 * history items into toasts while the tab is in use, and closes notifications that are dealt with. Renders nothing.
 */
export function NotifyRoot() {
  const { state } = useAuth();
  return state.status === 'in' ? <NotifyRootInner /> : null;
}

function NotifyRootInner() {
  const toast = useToast();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const send = usePresenceSender();
  const { overview } = useNotifyOverview();
  const lastInput = useRef(Date.now());
  const sent = useRef<ReturnType<typeof presenceOf> | null>(null);
  const seenAt = useRef<string | null>(null);
  const path = useRef(pathname);
  path.current = pathname;

  // Presence: on every visibility change, on input (at most once a second) and on a 20 s tick that lets "active" lapse.
  useEffect(() => {
    if (!send) return;
    const report = () => {
      const p = presenceOf({ visible: document.visibilityState === 'visible', lastInput: lastInput.current, now: Date.now(), device: thisDeviceId(), pathname: path.current });
      if (samePresence(sent.current, p)) return;
      sent.current = p;
      send(p);
    };
    let last = 0;
    const input = () => {
      const now = Date.now();
      lastInput.current = now;
      if (now - last > 1000) {
        last = now;
        report();
      }
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, input, { passive: true });
    document.addEventListener('visibilitychange', report);
    const tick = window.setInterval(report, 20_000);
    report();
    return () => {
      for (const e of events) window.removeEventListener(e, input);
      document.removeEventListener('visibilitychange', report);
      window.clearInterval(tick);
    };
  }, [send]);
  // A route change moves "the session this tab shows".
  useEffect(() => {
    if (!send) return;
    const p = presenceOf({ visible: document.visibilityState === 'visible', lastInput: lastInput.current, now: Date.now(), device: thisDeviceId(), pathname });
    if (samePresence(sent.current, p)) return;
    sent.current = p;
    send(p);
  }, [send, pathname, overview]);

  // The history: the first look sets the mark, every "changed" after it toasts what is new.
  const look = useRef<(announce: boolean) => Promise<void>>(async () => undefined);
  useEffect(() => {
    look.current = async (announce: boolean) => {
      try {
        const page = await notifyApi.history({ limit: 10 });
        if (announce && document.visibilityState === 'visible' && !path.current.startsWith('/admin/notifications')) {
          for (const item of freshItems(page.items, seenAt.current)) {
            toast(toastText(item), toastTone(item.kind), item.path ? { label: 'Open', onClick: () => navigate(item.path!) } : undefined);
          }
        }
        seenAt.current = newest(page.items) ?? seenAt.current ?? new Date(0).toISOString();
        void closeResolved(resolvedIds(page.items));
      } catch {
        // the Inbox shows the error when it is opened
      }
    };
  }, [toast, navigate]);
  useEffect(() => void look.current(false), []);
  useLive('notify', () => {
    void loadNotifyOverview();
    void look.current(true);
  });

  // A browser with a subscription the portal no longer knows (signed out elsewhere, the database restored): register it again. So does
  // one the portal knows in UTC while this device is elsewhere (T-126): the registration repairs the zone its notifications are written in.
  const synced = useRef(false);
  useEffect(() => {
    if (!overview || synced.current) return;
    synced.current = true;
    const id = thisDeviceId();
    const known = id ? overview.destinations.find((d) => d.id === id) : undefined;
    if (known && !needsZoneRepair(known.quiet.tz, browserZone())) return;
    void syncPush(overview.vapidPublicKey).then(() => loadNotifyOverview());
  }, [overview]);

  return null;
}
