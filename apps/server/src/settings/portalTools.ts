// `settings_get` on the Portal MCP (general-manager PRD §9.1, T-968 S2a): the shared settings as the Settings page shows them, read only.
// Declared in ./authz.ts (`view` on the platform's `settings` area): the dispatch refuses anyone else with NOT_FOUND before this runs, and a
// key that does not exist answers the same bytes. A string value shaped like a credential is never returned: it reads `[set]`; an empty
// string reads `[missing]` ("set or missing only", PRD §9.1). Both the value and the default are masked.

import { AppError } from '@isnanme/core';
import { SETTING_MISSING, SETTING_SECRET_SET, type ManagerSettingRow, type SettingView } from '@portal/contracts';
import { looksLikeSecret } from '../portalmcp/sanitize.js';
import { portalTools, z, type ToolRegistry } from '../portalmcp/registry.js';
import type { Settings } from './store.js';

/** What a denial and a missing key both answer (the seam's platform refusal says the same). */
export const NO_SETTING = 'Not found.';

const masked = <T,>(v: T): T => {
  if (typeof v !== 'string') return v;
  if (v.trim() === '') return SETTING_MISSING as T;
  return looksLikeSecret(v) ? (SETTING_SECRET_SET as T) : v;
};

export function settingRow(s: SettingView): ManagerSettingRow {
  return {
    key: s.key,
    group: s.group,
    label: s.label,
    type: s.type,
    value: masked(s.value),
    default: masked(s.default),
    source: s.updatedAt ? 'changed' : 'default',
    needs_confirmation: s.protective !== undefined,
    ...(s.choices ? { choices: s.choices } : {}),
    updated_at: s.updatedAt,
    updated_by: s.updatedBy,
  };
}

export function registerSettingsTools(settings: Pick<Settings, 'view'>, registry: ToolRegistry = portalTools): void {
  registry.register({
    name: 'settings_get',
    title: 'Read the settings',
    description:
      'The portal-wide settings as the Settings page shows them: key, group, label, the effective value and its default, whether it was changed and by whom, and whether changing it needs a person\'s confirmation (a security switch). ' +
      '`key` returns one; `group` narrows the list. A value shaped like a credential reads "[set]", an empty one "[missing]". Read only: no tool changes a setting.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      key: z.string().max(100).optional().describe('One setting, e.g. sessions.maxChildren.'),
      group: z.string().max(40).optional().describe('One section, e.g. sessions.'),
    }),
    handler(_ctx, args) {
      const view = settings.view();
      if (args.key) {
        const one = view.settings.find((s) => s.key === args.key);
        if (!one) throw new AppError('NOT_FOUND', NO_SETTING);
        return { summary: `${one.key}: ${String(masked(one.value))}`, setting: settingRow(one) };
      }
      const rows = view.settings.filter((s) => !args.group || s.group === args.group).map(settingRow);
      const changed = rows.filter((r) => r.source === 'changed').length;
      return {
        summary: `${rows.length} setting${rows.length === 1 ? '' : 's'}${changed ? `, ${changed} changed from the default` : ''}`,
        groups: view.groups.filter((g) => !args.group || g.id === args.group),
        settings: rows,
      };
    },
  });
}
