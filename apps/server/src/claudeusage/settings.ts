// Claude usage: its one shared setting (the settings registry; the Settings page lists it under "Usage"). Read at each use.

import { defineSetting, defineSettingGroup } from '../settings/registry.js';

/** T-1707: minutes between two primes of one Claude; 0 turns priming off. */
export const PRIME_MIN_SETTING = 'claude.usage.primeMin';
export const PRIME_MIN_DEFAULT = 30;

defineSettingGroup('usage', 'Usage', 40);

defineSetting({
  key: PRIME_MIN_SETTING,
  type: 'number',
  default: PRIME_MIN_DEFAULT,
  min: 0,
  max: 1440,
  integer: true,
  scope: 'global',
  group: 'usage',
  order: 5,
  label: 'Usage prime',
  help: 'Claude Code reads 0 % with no reset time both for an unused session window and for an account already at its limit, so such a Claude counts as unknown. When a probe reads that and no session runs on the Claude, the portal sends one tiny request on it (Haiku, no tools, "ok") and probes again: the window opens and reads a number, or the refusal marks the Claude used up until its reset. At most once per Claude in this many minutes; 0 turns it off.',
});
