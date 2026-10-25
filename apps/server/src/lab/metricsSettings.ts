// Pilot metrics (T-2360, §28.16): the one setting, group Usage. Which ticket tags make a program, and the targets its effectiveness score
// measures against. Owner only (the settings route needs `settings` `manage`; no agent tool writes settings).

import { defineSetting, defineSettingGroup } from '../settings/registry.js';
import { DEFAULT_METRICS_PROGRAMS, DEFAULT_TARGETS, DEFAULT_ALL_TARGETS, parseMetricsPrograms } from './flowMetrics.js';

export const METRICS_SETTING = { programs: 'lab.metricsPrograms' } as const;

defineSettingGroup('usage', 'Usage', 40);

defineSetting({
  key: METRICS_SETTING.programs,
  type: 'string',
  default: DEFAULT_METRICS_PROGRAMS,
  max: 1000,
  scope: 'global',
  group: 'usage',
  order: 90,
  label: 'Metrics programs',
  help:
    'The programs of the Metrics view, split by ";". Each is id=Label|tags|targets: the ticket tags (split by commas) whose tickets are the program, ' +
    'and three targets split by "/": done tickets per hour over 6 hours, median hours from created to done over 24 hours, and the hours the oldest ' +
    `ticket may wait in review. Without targets a program uses ${DEFAULT_TARGETS.closuresPerHour}/${DEFAULT_TARGETS.resolveHours}/${DEFAULT_TARGETS.reviewHours}. ` +
    `The id all with tags * sets the whole view's targets (default ${DEFAULT_ALL_TARGETS.closuresPerHour}/${DEFAULT_ALL_TARGETS.resolveHours}/${DEFAULT_ALL_TARGETS.reviewHours}). ` +
    'Tags "commits" mark a program without tickets: shown as unavailable. A program-* tag or a Flow program no entry covers is added by itself.',
  validate: (v) => {
    const { errors } = parseMetricsPrograms(v);
    return errors.length ? errors.slice(0, 3).join('; ') : null;
  },
});
