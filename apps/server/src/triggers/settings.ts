// Triggers: the platform-wide settings (docs/prd/triggers.md FR11, §13), an admin's. The master switch is off until an admin turns it on
// (a confirmation: it lets the portal start work by itself); the caps bound runs starting or running across all triggers and per owner.

import { TRIGGER_SETTING_KEYS } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';
import { validZone } from './cron.js';

export interface TriggerSettingsReader {
  get(key: string): unknown;
}

defineSettingGroup('triggers', 'Triggers', 46);

defineSetting({
  key: TRIGGER_SETTING_KEYS.enabled,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'triggers',
  order: 10,
  protective: false,
  confirmText: 'Triggers will start sessions and tickets by themselves, within their limits.',
  label: 'Triggers',
  help: 'The master switch. Off: no schedule fires, webhook deliveries are recorded as skipped, nothing starts. Each trigger still has its own limits and approval rule.',
});

defineSetting({
  key: TRIGGER_SETTING_KEYS.maxParallelTotal,
  type: 'number',
  default: 3,
  min: 1,
  max: 20,
  scope: 'global',
  group: 'triggers',
  order: 20,
  label: 'Runs at once',
  help: 'Trigger runs starting or running at the same time, across every trigger. A run beyond it is skipped (parallel limit), never queued.',
});

defineSetting({
  key: TRIGGER_SETTING_KEYS.maxParallelPerOwner,
  type: 'number',
  default: 2,
  min: 1,
  max: 20,
  scope: 'global',
  group: 'triggers',
  order: 30,
  label: 'Per person',
  help: 'Trigger runs starting or running at once for one owner, so one person cannot use up the others’ share.',
});

defineSetting({
  key: TRIGGER_SETTING_KEYS.timezone,
  type: 'string',
  default: '',
  max: 64,
  scope: 'global',
  group: 'triggers',
  order: 40,
  label: 'Time zone',
  help: 'The zone of a schedule that names none, and of “today” for the daily limits. An IANA name such as Asia/Jakarta. Empty: the server’s zone.',
});

/** The settings as the runner reads them; a value out of range or a bad zone falls back to the default. */
export function triggerSettings(s: TriggerSettingsReader | null) {
  const num = (key: string, d: number, max: number) => {
    const v = s?.get(key);
    return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(max, Math.floor(v)) : d;
  };
  const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return {
    enabled: () => s?.get(TRIGGER_SETTING_KEYS.enabled) === true,
    maxParallelTotal: () => num(TRIGGER_SETTING_KEYS.maxParallelTotal, 3, 20),
    maxParallelPerOwner: () => num(TRIGGER_SETTING_KEYS.maxParallelPerOwner, 2, 20),
    timezone: () => {
      const v = s?.get(TRIGGER_SETTING_KEYS.timezone);
      return typeof v === 'string' && v && validZone(v) ? v : validZone(serverZone) ? serverZone : 'UTC';
    },
  };
}
