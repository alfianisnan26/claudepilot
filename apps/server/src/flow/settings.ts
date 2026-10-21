// The flow watchdog's settings (T-1966, docs/prd/flow-watchdog.md), group "Flow". Owner only: the settings route needs `settings` `manage`
// and no agent tool writes them, so a lead cannot change who it is told about nor turn the watchdog off for itself.

import { FLOW_DEFAULT_PROGRAMS, FLOW_SETTING_KEYS as K } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';

export interface FlowSettingsReader {
  get(key: string): unknown;
}

defineSettingGroup('flow', 'Flow', 49);

defineSetting({
  key: K.enabled,
  type: 'boolean',
  default: true,
  scope: 'global',
  group: 'flow',
  order: 10,
  label: 'Flow watchdog',
  help: 'On: every 5 minutes the portal looks at each program below and messages the lead that can move a stuck ticket: a QA PASS not merged, a ticket in review nobody verifies, an idle lead with open work. It tells you only when nothing was done for hours after it nudged. It never answers an approval and never turns Bypass on. Off: nothing is looked at.',
});

defineSetting({
  key: K.programs,
  type: 'string',
  default: FLOW_DEFAULT_PROGRAMS,
  max: 1000,
  scope: 'global',
  group: 'flow',
  order: 20,
  label: 'Programs',
  help: 'One program per ";": name|tag|group|merge gate|on. tag: the tickets it watches. group: which group of Peer leads (Tickets settings) runs it, 1 for the first; empty: the first group whose leads hold its tickets. merge gate: the lead id told about QA PASS tickets; empty: the first lead of the group. Add |off to stop one program.',
});

const minutes = (key: string, order: number, label: string, def: number, help: string) =>
  defineSetting({ key, type: 'number', default: def, min: 5, max: 1440, integer: true, scope: 'global', group: 'flow', order, label, help });

minutes(K.mergeAfterMin, 30, 'Merge after', 20, 'Minutes a ticket may wait in review with a QA PASS on its head before the merge-gate lead is told.');
minutes(K.qaAfterMin, 40, 'QA after', 60, 'Minutes a ticket may wait in review with no verdict and nobody working on it before a peer lead is asked to verify it.');
minutes(K.idleAfterMin, 50, 'Idle lead', 30, 'Minutes a lead may be idle while its unit holds open work and it runs fewer workers than its cap before it is told its next tickets.');
minutes(K.repeatMin, 60, 'Repeat', 30, 'Each lead hears about each condition at most once in this many minutes.');

defineSetting({
  key: K.stallHours,
  type: 'number',
  default: 3,
  min: 1,
  max: 48,
  integer: true,
  scope: 'global',
  group: 'flow',
  order: 70,
  label: 'Stall window',
  help: 'Hours without a ticket done, while tickets wait in review, that count as a stall.',
});

defineSetting({
  key: K.notifyAfterHours,
  type: 'number',
  default: 3,
  min: 1,
  max: 48,
  integer: true,
  scope: 'global',
  group: 'flow',
  order: 80,
  label: 'Tell me after',
  help: 'Hours a stall must last after the first nudge before you get one notification (once per stall).',
});

export interface FlowThresholds {
  mergeAfterMs: number;
  qaAfterMs: number;
  idleAfterMs: number;
  repeatMs: number;
  stallMs: number;
  notifyAfterMs: number;
}

const MIN = 60_000;

function read(r: FlowSettingsReader | null, key: string, def: number, lo: number, hi: number): number {
  try {
    const v = r?.get(key);
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
  } catch {
    return def;
  }
}

/** The thresholds in milliseconds; an unreadable or odd value reads as its default (clamped to the setting's range). */
export function flowThresholds(r: FlowSettingsReader | null): FlowThresholds {
  return {
    mergeAfterMs: read(r, K.mergeAfterMin, 20, 5, 1440) * MIN,
    qaAfterMs: read(r, K.qaAfterMin, 60, 5, 1440) * MIN,
    idleAfterMs: read(r, K.idleAfterMin, 30, 5, 1440) * MIN,
    repeatMs: read(r, K.repeatMin, 30, 5, 1440) * MIN,
    stallMs: read(r, K.stallHours, 3, 1, 48) * 60 * MIN,
    notifyAfterMs: read(r, K.notifyAfterHours, 3, 1, 48) * 60 * MIN,
  };
}

/** The kill switch (an unreadable store reads as on, the default). */
export function flowOn(r: FlowSettingsReader | null): boolean {
  try {
    const v = r?.get(K.enabled);
    return typeof v === 'boolean' ? v : true;
  } catch {
    return true;
  }
}

export function flowProgramsRaw(r: FlowSettingsReader | null): string {
  try {
    const v = r?.get(K.programs);
    return typeof v === 'string' ? v : FLOW_DEFAULT_PROGRAMS;
  } catch {
    return FLOW_DEFAULT_PROGRAMS;
  }
}
