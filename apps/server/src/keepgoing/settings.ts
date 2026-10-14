// Keep going's platform setting (T-259): the kill switch. On by default, because nothing happens until a person turns Keep going on for a
// chat; off stops every sweep at once (the chats' own policies stay as they are and resume when it is on again).

import { KEEPGOING_SETTING_KEYS as K } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';

export interface KeepGoingSettingsReader {
  get(key: string): unknown;
}

defineSettingGroup('keepgoing', 'Keep going', 48);

defineSetting({
  key: K.enabled,
  type: 'boolean',
  default: true,
  scope: 'global',
  group: 'keepgoing',
  order: 10,
  label: 'Keep going',
  help: 'On: chats with Keep going turned on are watched every minute: an idle one is told to continue, an interrupted one is woken, a question is told to decide by the written defaults. A tool approval is never answered and Bypass is never turned on: those are reported. Off: nothing is watched anywhere.',
});

/** The kill switch (an unreadable store reads as on, the default: the per-chat policy is what turns anything on). */
export function keepGoingOn(r: KeepGoingSettingsReader | null): boolean {
  try {
    const v = r?.get(K.enabled);
    return typeof v === 'boolean' ? v : true;
  } catch {
    return true;
  }
}
