// Notifications: the platform-wide settings (docs/prd/web-app-pwa.md §11.8). An admin's: the ceiling on answering from a notification,
// where links in channel messages point, and the VAPID contact. Each person's own answer switches are in `notify_user_prefs`, not here.

import { NOTIFY_SETTING_KEYS } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';

/** The settings store, as far as this module reads it (`Settings.get`). */
export interface NotifySettingsReader {
  get(key: string): unknown;
}

defineSettingGroup('notify', 'Notifications', 45);

defineSetting({
  key: NOTIFY_SETTING_KEYS.actions,
  type: 'boolean',
  default: true,
  scope: 'global',
  group: 'notify',
  order: 10,
  protective: false,
  confirmText: 'People may answer approvals from a notification, within their own switches.',
  label: 'Answers',
  help: 'The ceiling on answering from a notification, for everyone. Off: notifications carry Review only, and every pending answer is refused. On: each person’s own switches decide (Deny on; Read, Edit and Command off until they turn them on).',
});

defineSetting({
  key: NOTIFY_SETTING_KEYS.baseUrl,
  type: 'string',
  default: '',
  scope: 'global',
  group: 'notify',
  order: 20,
  max: 200,
  label: 'Link address',
  help: 'Where links in notifications point, such as https://pilot.example.com. Empty: PORTAL_UI_URL; with neither, channel messages carry no link.',
});

defineSetting({
  key: NOTIFY_SETTING_KEYS.contact,
  type: 'string',
  default: '',
  scope: 'global',
  group: 'notify',
  order: 30,
  max: 200,
  label: 'Push contact',
  help: 'The contact push services see with each push (VAPID `sub`): a mailto: address or an https: page. Empty: PORTAL_PUSH_CONTACT, else the link address when it is https.',
});

/** An https origin, or null. */
export function httpsOrigin(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}

/** Where deep links point (`notify.baseUrl`, else `PORTAL_UI_URL`); an http address is allowed (a LAN portal), anything else is not. */
export function baseUrlOf(settings: NotifySettingsReader | null, fallback: string | null): string | null {
  const pick = (v: string | null | undefined) => {
    if (!v?.trim()) return null;
    try {
      const u = new URL(v.trim());
      return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.origin : null;
    } catch {
      return null;
    }
  };
  let configured: string | null = null;
  try {
    const v = settings?.get(NOTIFY_SETTING_KEYS.baseUrl);
    configured = typeof v === 'string' ? v : null;
  } catch {
    configured = null;
  }
  return pick(configured) ?? pick(fallback);
}

/** The VAPID `sub`: the setting, else `PORTAL_PUSH_CONTACT`, else the https link address; null when none qualifies. */
export function contactOf(settings: NotifySettingsReader | null, envContact: string | null, baseUrl: string | null): string | null {
  const ok = (v: string | null | undefined) => {
    const s = v?.trim();
    if (!s) return null;
    if (/^mailto:[^\s@]{1,64}@[^\s@]{1,190}$/i.test(s)) return s;
    return httpsOrigin(s);
  };
  let configured: string | null = null;
  try {
    const v = settings?.get(NOTIFY_SETTING_KEYS.contact);
    configured = typeof v === 'string' ? v : null;
  } catch {
    configured = null;
  }
  return ok(configured) ?? ok(envContact) ?? httpsOrigin(baseUrl);
}

export function actionsCeiling(settings: NotifySettingsReader | null): boolean {
  try {
    return settings?.get(NOTIFY_SETTING_KEYS.actions) !== false;
  } catch {
    return true;
  }
}
