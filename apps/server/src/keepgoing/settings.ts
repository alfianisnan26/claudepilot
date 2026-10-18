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

defineSetting({
  key: K.coordinator,
  type: 'string',
  default: '',
  scope: 'global',
  group: 'keepgoing',
  order: 20,
  max: 80,
  label: 'Coordinator',
  help: 'The chat (its session id) that is told when a watched chat is left down (the cap, a start refused, still ended 15 minutes on), next to the notification, the Needs you item and the ticket. Empty: the chat that started it, if any.',
});

defineSetting({
  key: K.statusTicket,
  type: 'string',
  default: '',
  scope: 'global',
  group: 'keepgoing',
  order: 30,
  max: 20,
  label: 'Status ticket',
  help: 'A ticket id (T-123) that gets one short comment each time Keep going reports a chat (left down, a tool approval waiting, out of Bypass), next to the report’s own ticket. Empty: no comment.',
});

/** T-257 A: the status ticket a report is also written on, as `T-<n>`; null when none is set, it is not a ticket id, or the store cannot be read. */
export function keepGoingStatusTicket(r: KeepGoingSettingsReader | null): string | null {
  try {
    const v = r?.get(K.statusTicket);
    const m = typeof v === 'string' ? /^\s*t-(\d{1,9})\s*$/i.exec(v) : null;
    return m ? `T-${Number(m[1])}` : null;
  } catch {
    return null;
  }
}

/** The coordinator's chat a chat left down is told to (T-257 item 4); null when none is set or the store cannot be read. */
export function keepGoingCoordinator(r: KeepGoingSettingsReader | null): string | null {
  try {
    const v = r?.get(K.coordinator);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** The kill switch (an unreadable store reads as on, the default: the per-chat policy is what turns anything on). */
export function keepGoingOn(r: KeepGoingSettingsReader | null): boolean {
  try {
    const v = r?.get(K.enabled);
    return typeof v === 'boolean' ? v : true;
  } catch {
    return true;
  }
}
