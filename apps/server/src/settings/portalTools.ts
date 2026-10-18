// `settings_get` on the Portal MCP (general-manager PRD §9.1, T-968 S2a): the shared settings as the Settings page shows them, read only.
// Declared in ./authz.ts (`view` on the platform's `settings` area): the dispatch refuses anyone else with NOT_FOUND before this runs, and a
// key that does not exist answers the same bytes. A string value shaped like a credential is never returned: it reads `[set]`; an empty
// string reads `[missing]` ("set or missing only", PRD §9.1). Both the value and the default are masked, at every depth (arrays, objects).

import { AppError } from '@isnanme/core';
import { SETTING_MISSING, SETTING_SECRET_SET, type ManagerSettingRow, type SettingView } from '@portal/contracts';
import { looksLikeSecret } from '../portalmcp/sanitize.js';
import { portalTools, z, type ToolRegistry } from '../portalmcp/registry.js';
import type { Settings } from './store.js';

/** What a denial and a missing key both answer (the seam's platform refusal says the same). */
export const NO_SETTING = 'Not found.';

/** How deep `masked` walks into an array or object value; anything deeper is not shown at all (it reads `[set]`). */
export const MASK_DEPTH = 8;

/**
 * Every string in the value, at any depth up to MASK_DEPTH, through arrays and objects (T-968 S2b, QA #11080 gap 1): a credential-shaped
 * one reads `[set]`, an empty one `[missing]`. An object key shaped like a credential is replaced too (`[set]`, then `[set] 2` …). A
 * value nested deeper than MASK_DEPTH is not walked further and reads `[set]`, so depth never lets a string through unmasked.
 */
const masked = <T,>(v: T, depth = 0): T => {
  if (typeof v === 'string') {
    if (v.trim() === '') return SETTING_MISSING as T;
    return looksLikeSecret(v) ? (SETTING_SECRET_SET as T) : v;
  }
  if (v === null || typeof v !== 'object') return v;
  if (depth >= MASK_DEPTH) return SETTING_SECRET_SET as T;
  if (Array.isArray(v)) return v.map((x) => masked(x, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  let hidden = 0;
  for (const [k, x] of Object.entries(v)) {
    const key = looksLikeSecret(k) ? `${SETTING_SECRET_SET}${++hidden > 1 ? ` ${hidden}` : ''}` : k;
    out[key] = masked(x, depth + 1);
  }
  return out as T;
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
