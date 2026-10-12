import type { NotifyDestination } from '@portal/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorText } from '@/lib/api';
import { notifyApi } from './api';
import { deviceName, keyBytes, pushSupport, type PushEnv, type PushSupport } from './push';
import { browserZone } from './quiet';
import { loadNotifyOverview, useNotifyOverview } from './store';
import { currentSubscription, rememberDevice, thisDeviceId } from './deviceId';

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

async function registration(): Promise<ServiceWorkerRegistration> {
  // The worker registers itself in a production build; in a dev server it has not, so register it here (the page asked for push).
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing.active ? existing : navigator.serviceWorker.ready;
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

export interface UsePush {
  support: PushSupport;
  /** The destination of this browser, when the portal has it. */
  device: NotifyDestination | null;
  busy: boolean;
  error: string | null;
  turnOn: () => Promise<void>;
  turnOff: () => Promise<void>;
}

/** This browser's push registration: its state, "Turn on" and "Turn off". Asks for the permission only inside `turnOn`, which a tap calls. */
export function usePush(): UsePush {
  const { overview } = useNotifyOverview();
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState<PushEnv['permission']>(() => (typeof Notification === 'undefined' ? null : Notification.permission));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setPermission(typeof Notification === 'undefined' ? null : Notification.permission);
    setSubscribed(!!(await currentSubscription()));
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const env: PushEnv = {
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    hasNotification: typeof Notification !== 'undefined',
    permission,
    subscribed,
    standalone: typeof window !== 'undefined' && isStandalone(),
    ios: typeof navigator !== 'undefined' && isIos(),
  };
  const support = pushSupport(env);

  const id = thisDeviceId();
  const device = useMemo(() => overview?.destinations.find((d) => d.type === 'push' && d.id === id) ?? null, [overview, id]);

  const turnOn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const key = overview?.vapidPublicKey;
      if (!key) throw new Error('The portal has no push key yet. Try again in a moment.');
      const permission = await Notification.requestPermission();
      setPermission(permission);
      if (permission !== 'granted') return;
      const reg = await registration();
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser gave an incomplete subscription.');
      const created = await notifyApi.registerPush({
        subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, expirationTime: json.expirationTime ?? null },
        name: deviceName(navigator.userAgent),
        tz: browserZone(),
      });
      rememberDevice(created.id);
      setSubscribed(true);
      await loadNotifyOverview();
    } catch (e) {
      setError(errorText(e, 'Could not turn on notifications.'));
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [overview?.vapidPublicKey, refresh]);

  const turnOff = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const dev = thisDeviceId();
      if (dev) await notifyApi.remove(dev).catch((e: unknown) => ((e as { status?: number }).status === 404 ? undefined : Promise.reject(e)));
      await (await currentSubscription())?.unsubscribe();
      rememberDevice(null);
      await loadNotifyOverview();
    } catch (e) {
      setError(errorText(e, 'Could not turn off notifications.'));
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [refresh]);

  return { support, device, busy, error, turnOn, turnOff };
}

/**
 * Signed in again on a browser that already has a subscription: register it again (the portal updates the same endpoint), so a push
 * destination removed at sign-out comes back without the person turning anything on. Does nothing without a granted permission.
 */
export async function syncPush(vapidPublicKey: string | null): Promise<void> {
  try {
    if (!vapidPublicKey || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const sub = await currentSubscription();
    const json = sub?.toJSON();
    if (!json?.endpoint || !json.keys?.p256dh || !json.keys.auth) return;
    const dev = await notifyApi.registerPush({
      subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, expirationTime: json.expirationTime ?? null },
      tz: browserZone(),
    });
    rememberDevice(dev.id);
  } catch {
    // the page works without it
  }
}
