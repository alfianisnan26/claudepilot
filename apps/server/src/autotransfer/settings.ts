// Auto transfer's platform settings (docs/prd/auto-transfer.md FR20), an admin's, group "Auto move" on the Settings page. Turning
// `enabled`, `automatic`, `allowApiKey` or `allowBypass` on asks for a confirmation (the settings store's CONFIRMATION_REQUIRED: `protective: false`).
// A user's own choices (`AutoUserPrefs`) override the defaults; the caps (pause, per chat, per day, per Claude) are the platform's only.

import { AUTO_BOUNDS, AUTO_SETTING_KEYS as K, autoModeOf, parseModelFallback, type AutoTransferSettings, type AutoUserPrefs } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';

export interface AutoSettingsReader {
  get(key: string): unknown;
}

defineSettingGroup('automove', 'Auto move', 47);

defineSetting({
  key: K.enabled,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'automove',
  order: 10,
  protective: false,
  confirmText: 'Chats can move to another Claude when a quota is low.',
  label: 'Auto move',
  help: 'Off: nothing watches a quota and nothing moves. On: when the Claude a chat runs on is nearly out, a card offers to move the chat to another Claude of the same workspace. With "Without asking" on: at the threshold the chat moves by itself to a Claude with more left (a working chat is told to finish its step first and moves when the turn ends); a Claude already out of quota moves at once, pause and caps or not; with no Claude to move to the chat waits and is looked at again every 2 minutes until one frees up or its own limit resets, then it goes on by itself.',
});
defineSetting({
  key: K.automatic,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'automove',
  order: 20,
  protective: false,
  confirmText: 'Chats move to another Claude by themselves when a quota is low.',
  label: 'Without asking',
  help: 'On: chats move by themselves at the end of a turn, within the pause and the caps below (a Claude already out of quota moves at once, and such a move is not counted); each move leaves an audit row, a notification and an Undo. Off: a card asks every time.',
});
defineSetting({
  key: K.thresholdPct,
  type: 'number',
  default: AUTO_BOUNDS.thresholdPct.default,
  min: AUTO_BOUNDS.thresholdPct.min,
  max: AUTO_BOUNDS.thresholdPct.max,
  scope: 'global',
  group: 'automove',
  order: 30,
  label: 'Threshold',
  help: 'Move when the fullest limit that stops the chat (the session, the week, or its model’s week) has this much left, in percent, or less. A person or a Claude can set its own.',
});
defineSetting({
  key: K.useProjection,
  type: 'boolean',
  default: true,
  scope: 'global',
  group: 'automove',
  order: 40,
  label: 'Projection',
  help: 'Also move when, at its current pace, a limit runs out within 2 hours, with 30 % or less left (an estimate, used only with enough readings).',
});
defineSetting({
  key: K.minPauseMin,
  type: 'number',
  default: AUTO_BOUNDS.minPauseMin.default,
  min: AUTO_BOUNDS.minPauseMin.min,
  max: AUTO_BOUNDS.minPauseMin.max,
  scope: 'global',
  group: 'automove',
  order: 50,
  label: 'Pause',
  help: 'Minutes before a chat may move again after a move or an answered card.',
});
defineSetting({
  key: K.maxPerSessionPerDay,
  type: 'number',
  default: AUTO_BOUNDS.maxPerSessionPerDay.default,
  min: AUTO_BOUNDS.maxPerSessionPerDay.min,
  max: AUTO_BOUNDS.maxPerSessionPerDay.max,
  scope: 'global',
  group: 'automove',
  order: 60,
  label: 'Per chat',
  help: 'Moves of one chat in 24 hours, at most.',
});
defineSetting({
  key: K.maxPerDay,
  type: 'number',
  default: AUTO_BOUNDS.maxPerDay.default,
  min: AUTO_BOUNDS.maxPerDay.min,
  max: AUTO_BOUNDS.maxPerDay.max,
  scope: 'global',
  group: 'automove',
  order: 70,
  label: 'Per day',
  help: 'Moves of all of one person’s chats in 24 hours, at most.',
});
defineSetting({
  key: K.maxPerDestination,
  type: 'number',
  default: AUTO_BOUNDS.maxPerDestination.default,
  min: AUTO_BOUNDS.maxPerDestination.min,
  max: AUTO_BOUNDS.maxPerDestination.max,
  scope: 'global',
  group: 'automove',
  order: 80,
  label: 'Per Claude',
  help: 'A Claude already running this many live chats (a move on its way counts) is not chosen.',
});
defineSetting({
  key: K.sameModelOnly,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'automove',
  order: 90,
  label: 'Same model',
  help: 'Only to a Claude whose week for the chat’s model is not used up. What a plan includes beyond that is not visible to the portal.',
});
defineSetting({
  key: K.allowApiKey,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'automove',
  order: 100,
  protective: false,
  confirmText: 'Chats may move to a Claude on a Console key, billed per use.',
  label: 'API keys',
  help: 'A Claude on a Console API key (billed per use) may take a chat, after any Claude with plan room.',
});

defineSetting({
  key: K.allowBypass,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'automove',
  order: 110,
  protective: false,
  confirmText: 'Chats in Bypass may move to another Claude by themselves, and stay in Bypass there.',
  label: 'Bypass too',
  help: 'A chat in Bypass may be moved without asking, like any other; it keeps Bypass on the new Claude while the policy allows it. Off: a chat in Bypass only ever gets a card. The owner asked for it on 2026-10-13.',
});

defineSetting({
  key: K.modelFallback,
  type: 'string',
  default: '',
  max: 40,
  scope: 'global',
  group: 'automove',
  order: 120,
  label: 'Other models',
  help: 'When only the chat’s own model is nearly out (its weekly limit) and the shared limits have room, the chat may change to one of these models on the same Claude instead of moving: no handoff, the conversation stays. Best first, e.g. "sonnet" or "sonnet, haiku". Empty: a chat never changes model by itself.',
});
defineSetting({
  key: K.keepModelFirst,
  type: 'boolean',
  default: true,
  scope: 'global',
  group: 'automove',
  order: 130,
  label: 'Keep the model',
  help: 'When a chat can either move to another Claude with room on its model or change model here: on, it moves and keeps its model; off, it stays here and changes model. When no Claude has room on its model, it moves with one of the other models.',
});

defineSetting({
  key: K.dryRun,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'automove',
  order: 140,
  label: 'Dry run',
  help: 'On: the engine records in the trail what it would do (move a chat, tell it to finish and stop) and does none of it. For checking a portal before trusting it to move chats by itself (T-105).',
});

const clamp = (n: unknown, b: { min: number; max: number; default: number }) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : b.default;
  return Math.min(b.max, Math.max(b.min, v));
};

/** The platform's values (an unreadable store reads as the defaults: off). */
export function platformSettings(r: AutoSettingsReader | null): AutoTransferSettings {
  const get = (k: string) => {
    try {
      return r?.get(k);
    } catch {
      return undefined;
    }
  };
  const b = (k: string, d: boolean) => (typeof get(k) === 'boolean' ? (get(k) as boolean) : d);
  return {
    mode: autoModeOf(b(K.enabled, false), b(K.automatic, false)),
    thresholdPct: clamp(get(K.thresholdPct), AUTO_BOUNDS.thresholdPct),
    useProjection: b(K.useProjection, true),
    minPauseMin: clamp(get(K.minPauseMin), AUTO_BOUNDS.minPauseMin),
    maxPerSessionPerDay: clamp(get(K.maxPerSessionPerDay), AUTO_BOUNDS.maxPerSessionPerDay),
    maxPerDay: clamp(get(K.maxPerDay), AUTO_BOUNDS.maxPerDay),
    maxPerDestination: clamp(get(K.maxPerDestination), AUTO_BOUNDS.maxPerDestination),
    sameModelOnly: b(K.sameModelOnly, false),
    allowApiKey: b(K.allowApiKey, false),
    allowBypass: b(K.allowBypass, false),
    modelFallback: parseModelFallback(get(K.modelFallback)),
    keepModelFirst: b(K.keepModelFirst, true),
    dryRun: b(K.dryRun, false),
  };
}

/**
 * A user's effective values: their own choices over the platform's defaults. The mode never goes above the platform's (`off` stays off,
 * `auto` needs the platform's `auto`); API keys only while the platform allows them; the caps are the platform's.
 */
export function effectiveSettings(platform: AutoTransferSettings, prefs: AutoUserPrefs): AutoTransferSettings {
  let mode = prefs.mode ?? platform.mode;
  if (platform.mode === 'off') mode = 'off';
  else if (mode === 'auto' && platform.mode !== 'auto') mode = 'ask';
  return {
    ...platform,
    mode,
    thresholdPct: prefs.thresholdPct ?? platform.thresholdPct,
    useProjection: prefs.useProjection ?? platform.useProjection,
    sameModelOnly: prefs.sameModelOnly ?? platform.sameModelOnly,
    allowApiKey: platform.allowApiKey && (prefs.allowApiKey ?? true),
  };
}
