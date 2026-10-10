import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { ENCRYPTED_COLUMNS, MIGRATIONS, type EncryptedColumn, type Migration } from './migrations.js';
import { isPortalRunning } from './lock.js';
import { SecretBox, type SecretSlot } from './secretBox.js';

export type TrustState = 'ok' | 'locked' | 'frozen';
export type TrustCode =
  | 'key-missing'
  | 'key-wrong'
  | 'db-unreadable'
  | 'db-corrupt'
  | 'db-newer'
  | 'migration-failed'
  | 'restored'
  | 'frozen-by-admin';

export interface Trust {
  /** `ok` delivers. `locked`: the secret key is missing or wrong. `frozen`: the database can't be trusted. */
  state: TrustState;
  reasons: { code: TrustCode; message: string }[];
}

export type BackupKind = 'pre-migrate' | 'daily' | 'manual' | 'replaced';
export interface BackupInfo {
  file: string;
  kind: BackupKind;
  at: Date;
  bytes: number;
}

/** How many backups of each kind to keep; the others are kept until removed by hand. */
const KEEP: Partial<Record<BackupKind, number>> = { 'pre-migrate': 3, daily: 7 };
const DAY_MS = 24 * 60 * 60 * 1000;

const KEY_CHECK_TEXT = 'claudepilot key check';
const KEY_CHECK_SLOT: SecretSlot = { table: 'portal_meta', row: 'key_check', column: 'value' };

/** Reasons an admin can clear with "Resume delivery"; the rest clear only when the cause is fixed. */
const RESUMABLE: TrustCode[] = ['restored', 'frozen-by-admin'];

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const BACKUP_NAME = /^portal-(\d{8}T\d{6}Z)-(pre-migrate|daily|manual|replaced)\.db$/;
const parseStamp = (s: string) =>
  new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);

/** Backups are single self-contained files: no WAL, mode 0600. */
function finishBackup(file: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
  } finally {
    db.close();
  }
  chmodSync(file, 0o600);
}

function ensurePrivateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not ours to change (e.g. a mount); the files inside are still 0600
  }
}

export interface StoreOptions {
  dataDir: string;
  /** The portal's secret key, or null when none is configured. */
  secretKey: Buffer | null;
  /** Why the configured key couldn't be used (for example, not 32 bytes); reported instead of "not set". */
  keyError?: string;
  migrations?: Migration[];
  encryptedColumns?: EncryptedColumn[];
  now?: () => Date;
}

/**
 * The portal's database: SQLite (node:sqlite) at `<dataDir>/portal.db`, WAL mode, foreign keys on,
 * migrated on open. Opening never throws for database problems: the store reports them as Locked or
 * Frozen (foundation PRD §6.5) so the portal can still start and explain itself. It never falls back
 * to an empty database.
 */
export class Store {
  readonly path: string;
  readonly backupsDir: string;
  #db: DatabaseSync | null = null;
  #readOnly = false;
  #reasons: Trust['reasons'] = [];
  #secrets: SecretBox | null = null;
  #portalId: string | null = null;
  #schemaVersion: number | null = null;

  private constructor(
    readonly dataDir: string,
    private readonly opts: Required<Omit<StoreOptions, 'dataDir' | 'secretKey' | 'keyError'>>,
  ) {
    this.path = join(dataDir, 'portal.db');
    this.backupsDir = join(dataDir, 'backups');
  }

  static async open(options: StoreOptions): Promise<Store> {
    const store = new Store(options.dataDir, {
      migrations: options.migrations ?? MIGRATIONS,
      encryptedColumns: options.encryptedColumns ?? ENCRYPTED_COLUMNS,
      now: options.now ?? (() => new Date()),
    });
    await store.#open(options.secretKey, options.keyError);
    return store;
  }

  get trust(): Trust {
    const reasons = [...this.#reasons];
    const frozen = reasons.some((r) => !r.code.startsWith('key-'));
    return { state: reasons.length === 0 ? 'ok' : frozen ? 'frozen' : 'locked', reasons };
  }

  /** Whether "Resume delivery" can clear what's stopping deliveries (other reasons may remain). */
  get resumable() {
    return this.#reasons.some((r) => RESUMABLE.includes(r.code));
  }

  /** Deliveries (and anything else that changes workspaces) run only when the portal trusts its state. */
  get deliveryAllowed() {
    return this.#reasons.length === 0;
  }

  /** The open database, or null when it can't be read. Read-only when it's from a newer portal. */
  get db(): DatabaseSync | null {
    return this.#db;
  }

  get writable() {
    return !!this.#db && !this.#readOnly;
  }

  /** Seals and opens secrets; null while the portal is Locked or the database is unavailable. */
  get secrets(): SecretBox | null {
    return this.#secrets;
  }

  get portalId() {
    return this.#portalId;
  }

  get schemaVersion() {
    return this.#schemaVersion;
  }

  get latestSchemaVersion() {
    return Math.max(0, ...this.opts.migrations.map((m) => m.version));
  }

  async #open(secretKey: Buffer | null, keyError?: string) {
    ensurePrivateDir(this.dataDir);
    ensurePrivateDir(this.backupsDir);
    const existed = existsSync(this.path) && statSync(this.path).size > 0;

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.path, { enableForeignKeyConstraints: true, timeout: 5000 });
      if (!existed) chmodSync(this.path, 0o600);
      const check = db.prepare('PRAGMA quick_check').all();
      const result = check.length === 1 ? Object.values(check[0]!)[0] : undefined;
      if (result !== 'ok') {
        db.close();
        return this.#freeze('db-corrupt', `The database failed its integrity check (${String(result ?? 'no result')}).`);
      }
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL');
    } catch (e) {
      try {
        db?.close();
      } catch {
        // already closed
      }
      return this.#freeze('db-unreadable', `The database can't be opened: ${(e as Error).message}`);
    }

    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    const latest = this.latestSchemaVersion;
    if (version > latest) {
      // Written by a newer portal: read it, never write it.
      db.close();
      this.#db = new DatabaseSync(this.path, { readOnly: true, timeout: 5000 });
      this.#readOnly = true;
      this.#schemaVersion = version;
      this.#portalId = this.#metaGet('portal_id');
      return this.#freeze('db-newer', `The database is from a newer portal (schema ${version}; this portal knows ${latest}).`);
    }

    this.#db = db;
    if (version < latest) {
      try {
        if (existed && version > 0) await this.backup('pre-migrate');
        for (const m of [...this.opts.migrations].sort((a, b) => a.version - b.version)) {
          if (m.version <= version) continue;
          db.exec('BEGIN IMMEDIATE');
          try {
            m.up(db);
            db.exec(`PRAGMA user_version = ${m.version}`);
            db.exec('COMMIT');
          } catch (e) {
            db.exec('ROLLBACK');
            throw new Error(`migration ${m.version} (${m.name}): ${(e as Error).message}`);
          }
        }
      } catch (e) {
        this.#schemaVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
        return this.#freeze('migration-failed', `A schema migration failed: ${(e as Error).message}`);
      }
    }
    this.#schemaVersion = latest;

    if (!this.#metaGet('portal_id')) {
      this.#metaSet('portal_id', randomUUID());
      this.#metaSet('created_at', this.opts.now().toISOString());
    }
    this.#portalId = this.#metaGet('portal_id');

    const frozen = this.#metaGet('frozen');
    if (frozen) {
      const { code, message } = JSON.parse(frozen) as { code: TrustCode; message: string };
      this.#reasons.push({ code, message });
    }

    this.#checkKey(secretKey, keyError);
  }

  #checkKey(secretKey: Buffer | null, keyError?: string) {
    const check = this.#metaGet('key_check');
    if (!secretKey && keyError) {
      this.#reasons.push({ code: 'key-wrong', message: keyError });
      return;
    }
    if (!secretKey) {
      this.#reasons.push({
        code: 'key-missing',
        message: check
          ? 'PORTAL_SECRET_KEY is not set. Secrets stay sealed until the portal starts with the key this database was set up with.'
          : 'PORTAL_SECRET_KEY is not set. Set it (or PORTAL_SECRET_KEY_FILE) to store secrets.',
      });
      return;
    }
    const box = new SecretBox(secretKey);
    if (!check) {
      // First start with a key: this key becomes the database's key.
      this.#metaSet('key_check', box.seal(KEY_CHECK_TEXT, KEY_CHECK_SLOT));
      this.#secrets = box;
      return;
    }
    try {
      if (box.open(check, KEY_CHECK_SLOT) !== KEY_CHECK_TEXT) throw new Error('mismatch');
      this.#secrets = box;
    } catch {
      this.#reasons.push({
        code: 'key-wrong',
        message: `PORTAL_SECRET_KEY doesn't match this database (it was set up with key ${SecretBox.keyIdOf(check) ?? 'unknown'}, this is ${box.keyId}).`,
      });
    }
  }

  #freeze(code: TrustCode, message: string) {
    this.#reasons.push({ code, message });
  }

  #metaGet(key: string): string | null {
    const row = this.#db?.prepare('SELECT value FROM portal_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  #metaSet(key: string, value: string) {
    this.#db!.prepare('INSERT INTO portal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Stops deliveries until an admin resumes them (for example after a restore). */
  freeze(code: Extract<TrustCode, 'restored' | 'frozen-by-admin'>, message: string) {
    if (!this.writable) throw new Error('The database is not writable.');
    this.#metaSet('frozen', JSON.stringify({ code, message, at: this.opts.now().toISOString() }));
    this.#reasons = this.#reasons.filter((r) => !RESUMABLE.includes(r.code));
    this.#reasons.push({ code, message });
  }

  /** "Resume delivery": clears a freeze an admin may clear. Returns false if other reasons remain. */
  resume(): boolean {
    if (this.writable) this.#db!.prepare("DELETE FROM portal_meta WHERE key = 'frozen'").run();
    this.#reasons = this.#reasons.filter((r) => !RESUMABLE.includes(r.code));
    return this.deliveryAllowed;
  }

  /** A consistent copy through SQLite's backup API, named `portal-<UTC stamp>-<kind>.db`, mode 0600. */
  async backup(kind: BackupKind): Promise<string> {
    if (!this.#db) throw new Error('The database is not open.');
    const file = join(this.backupsDir, `portal-${stamp(this.opts.now())}-${kind}.db`);
    await backup(this.#db, file);
    finishBackup(file);
    this.#prune(kind);
    return file;
  }

  /** Takes the daily backup if the last one is a day old. */
  async backupIfDue(): Promise<string | null> {
    if (!this.#db) return null;
    const last = this.listBackups().find((b) => b.kind === 'daily');
    if (last && this.opts.now().getTime() - last.at.getTime() < DAY_MS) return null;
    return this.backup('daily');
  }

  listBackups(): BackupInfo[] {
    if (!existsSync(this.backupsDir)) return [];
    return readdirSync(this.backupsDir)
      .map((name) => ({ name, m: BACKUP_NAME.exec(name) }))
      .filter((x): x is { name: string; m: RegExpExecArray } => !!x.m)
      .map(({ name, m }) => {
        const file = join(this.backupsDir, name);
        return { file, kind: m[2] as BackupKind, at: parseStamp(m[1]!), bytes: statSync(file).size };
      })
      .sort((a, b) => b.at.getTime() - a.at.getTime() || b.file.localeCompare(a.file));
  }

  #prune(kind: BackupKind) {
    const keep = KEEP[kind];
    if (!keep) return;
    for (const old of this.listBackups().filter((b) => b.kind === kind).slice(keep)) rmSync(old.file, { force: true });
  }

  close() {
    this.#db?.close();
    this.#db = null;
  }
}

/* ---------- Read-only helpers (safe while the portal runs). ---------- */

export interface StoreInspection {
  exists: boolean;
  schemaVersion: number | null;
  latestSchemaVersion: number;
  portalId: string | null;
  createdAt: string | null;
  frozen: string | null;
  /** `opens`, `wrong`, `no-key` (none configured), `none` (the database has no key check yet). */
  key: 'opens' | 'wrong' | 'no-key' | 'none';
  keyId: string | null;
  backups: BackupInfo[];
  error: string | null;
}

/** Reads the database's state without migrating or writing anything. */
export function inspectStore(opts: { dataDir: string; secretKey: Buffer | null; migrations?: Migration[] }): StoreInspection {
  const path = join(opts.dataDir, 'portal.db');
  const latest = Math.max(0, ...(opts.migrations ?? MIGRATIONS).map((m) => m.version));
  const backups = existsSync(join(opts.dataDir, 'backups'))
    ? readdirSync(join(opts.dataDir, 'backups'))
        .map((name) => ({ name, m: BACKUP_NAME.exec(name) }))
        .filter((x): x is { name: string; m: RegExpExecArray } => !!x.m)
        .map(({ name, m }) => {
          const file = join(opts.dataDir, 'backups', name);
          return { file, kind: m[2] as BackupKind, at: parseStamp(m[1]!), bytes: statSync(file).size };
        })
        .sort((a, b) => b.at.getTime() - a.at.getTime())
    : [];
  const base: StoreInspection = {
    exists: existsSync(path),
    schemaVersion: null,
    latestSchemaVersion: latest,
    portalId: null,
    createdAt: null,
    frozen: null,
    key: opts.secretKey ? 'none' : 'no-key',
    keyId: opts.secretKey ? new SecretBox(opts.secretKey).keyId : null,
    backups,
    error: null,
  };
  if (!base.exists) return base;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
    base.schemaVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (base.schemaVersion === 0) return base;
    const meta = (key: string) => (db!.prepare('SELECT value FROM portal_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
    base.portalId = meta('portal_id');
    base.createdAt = meta('created_at');
    base.frozen = meta('frozen');
    const check = meta('key_check');
    if (check && opts.secretKey) base.key = opensKeyCheck(check, opts.secretKey) ? 'opens' : 'wrong';
    else if (check) base.keyId = SecretBox.keyIdOf(check);
    return base;
  } catch (e) {
    return { ...base, error: (e as Error).message };
  } finally {
    db?.close();
  }
}

/** A `manual` backup through the backup API. Safe while the portal runs (WAL readers don't block it). */
export async function backupDatabase(opts: { dataDir: string; now?: () => Date }): Promise<string> {
  const path = join(opts.dataDir, 'portal.db');
  if (!existsSync(path)) throw new Error(`No database at ${path}.`);
  const dir = join(opts.dataDir, 'backups');
  ensurePrivateDir(dir);
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const file = join(dir, `portal-${stamp((opts.now ?? (() => new Date()))())}-manual.db`);
    await backup(db, file);
    finishBackup(file);
    return file;
  } finally {
    db.close();
  }
}

/* ---------- Offline operations (the `portal` CLI). The portal must be stopped. ---------- */

function assertStopped(dataDir: string) {
  const pid = isPortalRunning(dataDir);
  if (pid) throw new Error(`The portal is running (pid ${pid}). Stop it first.`);
}

function readKeyCheck(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM portal_meta WHERE key = 'key_check'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

function opensKeyCheck(check: string, key: Buffer): boolean {
  try {
    return new SecretBox(key).open(check, KEY_CHECK_SLOT) === KEY_CHECK_TEXT;
  } catch {
    return false;
  }
}

/**
 * Replaces the database with a backup. The backup must pass its integrity check, be no newer than
 * this portal, and open with the current key (when it holds secrets). The replaced database is kept
 * as a `replaced` backup, and the portal starts Frozen until an admin resumes delivery.
 */
export async function restoreBackup(opts: {
  dataDir: string;
  file: string;
  secretKey: Buffer | null;
  migrations?: Migration[];
  now?: () => Date;
}): Promise<{ replaced: string | null }> {
  assertStopped(opts.dataDir);
  const now = opts.now ?? (() => new Date());
  const latest = Math.max(0, ...(opts.migrations ?? MIGRATIONS).map((m) => m.version));

  const src = new DatabaseSync(opts.file, { readOnly: true });
  try {
    const check = src.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0]!)[0] !== 'ok') throw new Error('The backup failed its integrity check.');
    const version = Number((src.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > latest) throw new Error(`The backup is from a newer portal (schema ${version}; this portal knows ${latest}).`);
    const keyCheck = version > 0 ? readKeyCheck(src) : null;
    if (keyCheck && !(opts.secretKey && opensKeyCheck(keyCheck, opts.secretKey)))
      throw new Error("The backup's secrets don't open with PORTAL_SECRET_KEY. Restore needs the key the backup was made with.");
  } finally {
    src.close();
  }

  const path = join(opts.dataDir, 'portal.db');
  const backupsDir = join(opts.dataDir, 'backups');
  ensurePrivateDir(backupsDir);
  let replaced: string | null = null;
  if (existsSync(path) && statSync(path).size > 0) {
    const current = new DatabaseSync(path);
    replaced = join(backupsDir, `portal-${stamp(now())}-replaced.db`);
    await backup(current, replaced);
    current.close();
    finishBackup(replaced);
  }
  for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
  copyFileSync(opts.file, path);
  chmodSync(path, 0o600);

  const restored = new DatabaseSync(path);
  try {
    if (Number((restored.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) > 0) {
      const frozen = { code: 'restored', message: `Restored from ${basename(opts.file)}. Check workspaces, then resume delivery.`, at: now().toISOString() };
      restored
        .prepare("INSERT INTO portal_meta (key, value) VALUES ('frozen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(frozen));
    }
  } finally {
    restored.close();
  }
  return { replaced };
}

/** Re-seals every secret with a new key in one transaction (after a backup). */
export async function rotateKey(opts: {
  dataDir: string;
  oldKey: Buffer;
  newKey: Buffer;
  migrations?: Migration[];
  encryptedColumns?: EncryptedColumn[];
}): Promise<{ resealed: number; backup: string }> {
  assertStopped(opts.dataDir);
  const store = await Store.open({
    dataDir: opts.dataDir,
    secretKey: opts.oldKey,
    migrations: opts.migrations,
    encryptedColumns: opts.encryptedColumns,
  });
  try {
    if (!store.writable || !store.secrets) throw new Error(store.trust.reasons.map((r) => r.message).join(' ') || 'The database is not usable.');
    const db = store.db!;
    const oldBox = store.secrets;
    const newBox = new SecretBox(opts.newKey);
    const file = await store.backup('manual');
    let resealed = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const col of opts.encryptedColumns ?? ENCRYPTED_COLUMNS) {
        const rows = db.prepare(`SELECT ${col.idColumn} AS id, ${col.column} AS value FROM ${col.table} WHERE ${col.column} IS NOT NULL`).all() as { id: string | number; value: string }[];
        const update = db.prepare(`UPDATE ${col.table} SET ${col.column} = ? WHERE ${col.idColumn} = ?`);
        for (const r of rows) {
          const slot = { table: col.table, row: String(r.id), column: col.column };
          update.run(newBox.seal(oldBox.open(r.value, slot), slot), r.id);
          resealed++;
        }
      }
      db.prepare("UPDATE portal_meta SET value = ? WHERE key = 'key_check'").run(newBox.seal(KEY_CHECK_TEXT, KEY_CHECK_SLOT));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { resealed, backup: file };
  } finally {
    store.close();
  }
}

/**
 * The key is lost: deletes every sealed value and makes `newKey` the database's key. Pools,
 * assignments and history stay; each secret has to be entered again.
 */
export async function forgetSecrets(opts: {
  dataDir: string;
  newKey: Buffer;
  migrations?: Migration[];
  encryptedColumns?: EncryptedColumn[];
}): Promise<{ cleared: number; backup: string }> {
  assertStopped(opts.dataDir);
  const store = await Store.open({
    dataDir: opts.dataDir,
    secretKey: null,
    migrations: opts.migrations,
    encryptedColumns: opts.encryptedColumns,
  });
  try {
    if (!store.writable) throw new Error(store.trust.reasons.map((r) => r.message).join(' ') || 'The database is not writable.');
    const db = store.db!;
    const check = readKeyCheck(db);
    if (check && opensKeyCheck(check, opts.newKey)) throw new Error('This key already opens the database; nothing to forget.');
    const file = await store.backup('manual');
    let cleared = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const col of opts.encryptedColumns ?? ENCRYPTED_COLUMNS)
        cleared += Number(db.prepare(`UPDATE ${col.table} SET ${col.column} = NULL WHERE ${col.column} IS NOT NULL`).run().changes);
      db.prepare("INSERT INTO portal_meta (key, value) VALUES ('key_check', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(new SecretBox(opts.newKey).seal(KEY_CHECK_TEXT, KEY_CHECK_SLOT));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { cleared, backup: file };
  } finally {
    store.close();
  }
}
