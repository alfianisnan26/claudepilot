import { AppError } from '@isnanme/core';
import type { SettingChange, SettingValue, SettingView, SettingsView } from '@portal/contracts';
import type { Store } from '../store/store.js';
import { settingDef, settingDefs, settingGroups, type SettingDef } from './registry.js';

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const META = (key: string) => `setting:${key}`;

/**
 * The shared settings store: values in `portal_meta` as JSON under `setting:<key>`, defaults from the
 * registry, every change audited in `setting_changes`. Reads never fail: a portal that can't read its
 * database (Frozen, an older schema) answers with the defaults, and the Frozen banner says why. Writes need a
 * writable database.
 */
export class Settings {
  readonly #cache = new Map<string, { value: SettingValue; at: string | null; by: string | null }>();
  readonly #listeners = new Set<(key: string, value: SettingValue, old: SettingValue) => void>();

  constructor(private readonly store: Store) {}

  /** Called after each change, once it's stored: the lockdown asks every workspace to deliver again. */
  onChange(fn: (key: string, value: SettingValue, old: SettingValue) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  #stored(key: string): { value: SettingValue; at: string | null; by: string | null } | null {
    const hit = this.#cache.get(key);
    if (hit) return hit;
    try {
      const row = this.store.db?.prepare('SELECT value FROM portal_meta WHERE key = ?').get(META(key)) as { value: string } | undefined;
      if (!row) return null;
      const parsed = JSON.parse(row.value) as { v: SettingValue; at?: string; by?: string };
      const def = settingDef(key);
      if (def && typeof parsed.v !== def.type) return null;
      const out = { value: parsed.v, at: parsed.at ?? null, by: parsed.by ?? null };
      this.#cache.set(key, out);
      return out;
    } catch {
      return null;
    }
  }

  /** A setting's value: the stored one, else its default. An unknown key is a programming error. */
  get<T extends SettingValue = SettingValue>(key: string): T {
    const def = settingDef(key);
    if (!def) throw new Error(`No setting named ${key}.`);
    return (this.#stored(key)?.value ?? def.default) as T;
  }

  #view(def: SettingDef): SettingView {
    const s = this.#stored(def.key);
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      help: def.help ?? null,
      confirmText: def.confirmText ?? null,
      type: def.type,
      value: s?.value ?? def.default,
      default: def.default,
      ...(def.protective !== undefined ? { protective: def.protective } : {}),
      order: def.order ?? 100,
      updatedAt: s?.at ?? null,
      updatedBy: s?.by ?? null,
    };
  }

  view(): SettingsView {
    return { groups: settingGroups(), settings: settingDefs().map((d) => this.#view(d)) };
  }

  /**
   * Changes a setting (audited). A security switch moved away from its protective value needs `confirm`,
   * so nothing relaxes by a stray request; the page asks first, and this refuses without it.
   */
  set(key: string, value: unknown, opts: { actor: string; confirm?: boolean }): SettingView {
    const def = settingDef(key);
    if (!def) throw new AppError('NOT_FOUND', 'No such setting.');
    if (typeof value !== def.type) throw invalid('value', `Send a ${def.type}.`);
    if (def.type === 'number' && !Number.isFinite(value as number)) throw invalid('value', 'Send a finite number.');
    if (def.type === 'number' && ((def.min !== undefined && (value as number) < def.min) || (def.max !== undefined && (value as number) > def.max)))
      throw invalid('value', `Use a number from ${def.min ?? '−∞'} to ${def.max ?? '∞'}.`);
    if (def.type === 'string' && (value as string).length > (def.max ?? 500)) throw invalid('value', `Use at most ${def.max ?? 500} characters.`);
    const db = this.store.db;
    if (!db || !this.store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not writable.');
    const old = this.get(key);
    if (old === value) return this.#view(def);
    if (def.protective !== undefined && old === def.protective && opts.confirm !== true)
      throw new AppError('CONFIRMATION_REQUIRED', `${def.label}: confirm that you want to change this. It removes a protection.`, { details: { confirm: 'Confirm first.' } });
    const at = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO portal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META(key), JSON.stringify({ v: value, at, by: opts.actor }));
      db.prepare('INSERT INTO setting_changes (at, key, old_value, new_value, actor) VALUES (?, ?, ?, ?, ?)').run(at, key, JSON.stringify(old), JSON.stringify(value), opts.actor);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.#cache.set(key, { value: value as SettingValue, at, by: opts.actor });
    for (const fn of this.#listeners) {
      try {
        fn(key, value as SettingValue, old);
      } catch (e) {
        console.error(`[settings] a listener for ${key} failed: ${(e as Error).message}`);
      }
    }
    return this.#view(def);
  }

  /** The audit trail, newest first. */
  audit(limit = 100): SettingChange[] {
    try {
      const rows = this.store.db?.prepare('SELECT * FROM setting_changes ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)) as
        | { id: number; at: string; key: string; old_value: string | null; new_value: string; actor: string }[]
        | undefined;
      return (rows ?? []).map((r) => ({ id: r.id, at: r.at, key: r.key, oldValue: r.old_value === null ? null : (JSON.parse(r.old_value) as SettingValue), newValue: JSON.parse(r.new_value) as SettingValue, actor: r.actor }));
    } catch {
      return [];
    }
  }
}
