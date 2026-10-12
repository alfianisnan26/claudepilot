/** What this browser can do about Web Push, worked out from facts passed in (so a test can pass its own). */
export type PushSupport = 'unsupported' | 'install' | 'blocked' | 'off' | 'on';

export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** `Notification.permission`, or null without the API. */
  permission: 'default' | 'granted' | 'denied' | null;
  /** This browser has a push subscription for the portal. */
  subscribed: boolean;
  /** Installed to the Home Screen / standalone. */
  standalone: boolean;
  /** iPhone or iPad: push there needs the Home Screen app. */
  ios: boolean;
}

export function pushSupport(e: PushEnv): PushSupport {
  if (e.ios && !e.standalone) return 'install';
  if (!e.hasServiceWorker || !e.hasPushManager || !e.hasNotification) return 'unsupported';
  if (e.permission === 'denied') return 'blocked';
  if (e.permission === 'granted' && e.subscribed) return 'on';
  return 'off';
}

/** A VAPID key (base64url) as the bytes `PushManager.subscribe` wants. */
export function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** "Chrome · Android": a name for this device from its user agent; the person can rename it. */
export function deviceName(ua: string): string {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X|Macintosh/i.test(ua) ? 'Mac' : /Linux|CrOS/i.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} · ${os}`;
}

/** The words for each state: a title and one line. */
export const SUPPORT_TEXT: Record<PushSupport, { label: string; help: string | null }> = {
  unsupported: { label: 'Unsupported', help: "This browser can't receive notifications from the portal." },
  install: { label: 'Add to Home Screen', help: 'On iPhone and iPad, notifications work from the Home Screen app. Share, then Add to Home Screen, then open it from there.' },
  blocked: { label: 'Blocked', help: "Notifications are blocked for this site. Allow them in the browser's site settings, then come back." },
  off: { label: 'Off', help: null },
  on: { label: 'On', help: null },
};
