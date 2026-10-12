// Claude Code version pinning: the settings this area defines in the shared settings store (settings PRD). Imported for its effect: the Settings
// page and `GET /api/settings` list what is defined, so the cadence of the scheduled canary shows up under "Claude Code" with no page of its own.

import { CLAUDE_CANARY_DEFAULT_DAYS, CLAUDE_SETTING_KEYS } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';

defineSettingGroup('claude', 'Claude Code', 40);

defineSetting({
  key: CLAUDE_SETTING_KEYS.canaryDays,
  type: 'number',
  default: CLAUDE_CANARY_DEFAULT_DAYS,
  scope: 'global',
  group: 'claude',
  order: 10,
  label: 'Canary every (days)',
  help: 'How often the portal runs its compatibility canary on the installed Claude Code and on the newest one the npm registry offers, in a throwaway container with no real login. 0 turns the schedule off. Running it by hand always works.',
  min: 0,
  max: 90,
});
