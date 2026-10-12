// Usage spend: the Settings (docs/prd/claude-usage.md §23.2, §24.3). Portal-wide, through the shared settings store, so the Settings page
// lists them under "Usage" without knowing about them. Read each time they are needed, so a change applies from the next request.

import type { SettingValue, SpikeSettings } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';
import { isTimeZone } from './periods.js';

export const SPEND_SETTING = {
  timezone: 'usage.timezone',
  spikesEnabled: 'usage.spikes.enabled',
  rateFactor: 'usage.spikes.rateFactor',
  burstRequests: 'usage.spikes.burstRequests',
  outlierFactor: 'usage.spikes.outlierFactor',
  minUsd: 'usage.spikes.minUsd',
} as const;

export const SPIKE_DEFAULTS: SpikeSettings = { enabled: true, rateFactor: 3, burstRequests: 20, burstWindowMin: 10, outlierFactor: 10, minUsd: 0.5 };

defineSettingGroup('usage', 'Usage', 40);

defineSetting({
  key: SPEND_SETTING.timezone,
  type: 'string',
  default: 'UTC',
  scope: 'global',
  group: 'usage',
  order: 10,
  max: 64,
  label: 'Time zone',
  help: 'The clock budgets count days and months by, as a time zone name such as Asia/Jakarta or America/New_York. UTC when it is empty or not a name this portal knows. Changing it moves every budget’s period boundaries.',
});

defineSetting({
  key: SPEND_SETTING.spikesEnabled,
  type: 'boolean',
  default: SPIKE_DEFAULTS.enabled,
  scope: 'global',
  group: 'usage',
  order: 20,
  label: 'Spike alerts',
  help: 'Look for unusual spending and raise an alert. Three rules of thumb (rate, loop, single request), each shown with its evidence and labelled as a heuristic. They only alert; nothing is stopped.',
});

defineSetting({
  key: SPEND_SETTING.rateFactor,
  type: 'number',
  default: SPIKE_DEFAULTS.rateFactor,
  scope: 'global',
  group: 'usage',
  order: 30,
  min: 1.5,
  max: 100,
  label: 'Rate factor',
  help: 'Rate spike: a Claude spent in the last 15 minutes at least this many times the 90th percentile of its active 15-minute periods over the 7 days before (and at least the minimum below). Lower is more sensitive. Needs 8 active periods of history.',
});

defineSetting({
  key: SPEND_SETTING.burstRequests,
  type: 'number',
  default: SPIKE_DEFAULTS.burstRequests,
  scope: 'global',
  group: 'usage',
  order: 40,
  min: 3,
  max: 1000,
  label: 'Loop requests',
  help: 'Loop spike: one session finished at least this many requests within 10 minutes, which is how sessions answering each other (tickets, CI, another session) look. Lower is more sensitive. The cost does not matter for this one.',
});

defineSetting({
  key: SPEND_SETTING.outlierFactor,
  type: 'number',
  default: SPIKE_DEFAULTS.outlierFactor,
  scope: 'global',
  group: 'usage',
  order: 50,
  min: 2,
  max: 1000,
  label: 'Request factor',
  help: 'Single-request spike: one request cost at least this many times the median request of its Claude over the 7 days before (and at least the minimum below). Lower is more sensitive. Needs 20 earlier requests.',
});

defineSetting({
  key: SPEND_SETTING.minUsd,
  type: 'number',
  default: SPIKE_DEFAULTS.minUsd,
  scope: 'global',
  group: 'usage',
  order: 60,
  min: 0,
  max: 1000,
  label: 'Spike minimum',
  help: 'In estimated US dollars (a plan’s “cost” is what the same use would cost on the API, not a bill): rate and single-request spikes below this are ignored, however unusual.',
});

/** The shared store's reader, as this module needs it. */
export interface SettingsReader {
  get<T extends SettingValue = SettingValue>(key: string): T;
}

const num = (v: unknown, dflt: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : dflt);

/** The clock for days and months: the setting, or UTC when it is not a time zone this runtime knows. */
export function timezoneOf(settings: SettingsReader): string {
  try {
    const v = settings.get<string>(SPEND_SETTING.timezone);
    return isTimeZone(v) ? v : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The spike thresholds in force; a value that is missing or out of range falls back to its default. */
export function spikeSettingsOf(settings: SettingsReader): SpikeSettings {
  const d = SPIKE_DEFAULTS;
  try {
    const enabled = settings.get<boolean>(SPEND_SETTING.spikesEnabled);
    return {
      enabled: typeof enabled === 'boolean' ? enabled : d.enabled,
      rateFactor: num(settings.get(SPEND_SETTING.rateFactor), d.rateFactor, 1.5, 100),
      burstRequests: num(settings.get(SPEND_SETTING.burstRequests), d.burstRequests, 3, 1000),
      burstWindowMin: d.burstWindowMin,
      outlierFactor: num(settings.get(SPEND_SETTING.outlierFactor), d.outlierFactor, 2, 1000),
      minUsd: num(settings.get(SPEND_SETTING.minUsd), d.minUsd, 0, 1000),
    };
  } catch {
    return { ...d };
  }
}
