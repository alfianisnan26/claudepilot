import { defineErrorCodes } from '@isnanme/core';
import type { SettingType, SettingValue } from '@portal/contracts';

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    CONFIRMATION_REQUIRED: true;
  }
}
/** Turning a security switch off, or an agent permission on, needs the admin's confirmation: the server asks for it (409), the page shows the dialog. */
defineErrorCodes({ CONFIRMATION_REQUIRED: { status: 409, message: 'Confirm this change.' } });

/**
 * One portal-wide setting (settings-policies PRD, the shared settings store). Areas define their own at
 * import time with `defineSetting`, so the Settings page and `GET /api/settings` list them all without
 * knowing any of them. The key is the contract other code reads (`settings.get(key)`).
 */
export interface SettingDef<T extends SettingValue = SettingValue> {
  /** Dotted, lowercase start: `mcp.poolOnly`. */
  key: string;
  type: SettingType;
  default: T;
  /** Global for now; per-workspace overrides come with the Configuration sheet. */
  scope: 'global';
  /** The page's section. */
  group: string;
  /** One or two words. */
  label: string;
  /** The explanation behind the ⓘ. */
  help?: string;
  /** For a `protective` setting: the one terse line of the confirmation dialog. */
  confirmText?: string;
  /**
   * For a security switch: the value that protects. Moving away from it (switching the protection off, or
   * an agent permission on) needs `confirm: true`; the change is audited either way.
   */
  protective?: T;
  /** Position within the group (default 100). */
  order?: number;
  /** Strings: the longest allowed (default 500). Numbers: the range. */
  max?: number;
  min?: number;
  /** Numbers only: whole numbers. */
  integer?: boolean;
  /** Strings only: the values it may take (the page shows a choice). */
  choices?: string[];
  /** A check of its own on save: why the value is refused, or null. `get` reads the other settings as they are now. */
  validate?: (value: T, get: (key: string) => unknown) => string | null;
}

const KEY = /^[a-z][a-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const defs = new Map<string, SettingDef>();
const groups = new Map<string, { label: string; order: number }>();

/** Registers a setting. Defining the same key twice with the same definition is fine (modules load more than once in tests). */
export function defineSetting<T extends SettingValue>(def: SettingDef<T>): SettingDef<T> {
  if (!KEY.test(def.key)) throw new Error(`Setting key “${def.key}” must look like group.name.`);
  if (typeof def.default !== def.type) throw new Error(`Setting ${def.key}: the default must be a ${def.type}.`);
  if (def.protective !== undefined && typeof def.protective !== def.type) throw new Error(`Setting ${def.key}: protective must be a ${def.type}.`);
  if (def.choices && (def.type !== 'string' || !def.choices.includes(def.default as string))) throw new Error(`Setting ${def.key}: choices need a string default that is one of them.`);
  const known = defs.get(def.key);
  if (known && JSON.stringify(known) !== JSON.stringify(def)) throw new Error(`Setting ${def.key} is already defined differently.`);
  defs.set(def.key, def as unknown as SettingDef);
  if (!groups.has(def.group)) groups.set(def.group, { label: def.group[0]!.toUpperCase() + def.group.slice(1), order: 100 });
  return def;
}

/** Names and orders a section of the Settings page (`sessions` is A2's, to fill later). */
export function defineSettingGroup(id: string, label: string, order = 100): void {
  groups.set(id, { label, order });
}

export const settingDef = (key: string): SettingDef | undefined => defs.get(key);

/** Every definition, in page order: groups by their order, settings by theirs, then by key. */
export function settingDefs(): SettingDef[] {
  const g = (id: string) => groups.get(id)?.order ?? 100;
  return [...defs.values()].sort((a, b) => g(a.group) - g(b.group) || a.group.localeCompare(b.group) || (a.order ?? 100) - (b.order ?? 100) || a.key.localeCompare(b.key));
}

export function settingGroups(): { id: string; label: string }[] {
  const used = new Set([...defs.values()].map((d) => d.group));
  return [...groups.entries()]
    .filter(([id]) => used.has(id))
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .map(([id, g]) => ({ id, label: g.label }));
}
