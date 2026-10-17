// Nightly off-site backups of the portal database (T-565). A CronJob runs `portal backup --nightly` beside the portal: an
// online copy through SQLite's backup API (safe while the portal writes; WAL readers don't block it), checked, gzipped and
// kept as 7 daily plus 4 weekly in `<data dir>/backups/nightly`, which the same Job then mirrors off-site. The portal reads
// that folder to say when the newest one is older than 26 hours (`nightlyStatus`).
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { Migration } from './migrations.js';
import { ensurePrivateDir, finishBackup, restoreBackup } from './store.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A nightly runs every 24 h; 2 h of slack for a slow or retried Job before the portal calls it stale. */
export const STALE_AFTER_MS = 26 * HOUR_MS;
/** The newest backup of each of the last 7 days that have one, and of each of the last 4 weeks (ISO, Monday first). */
export interface Retention {
  daily: number;
  weekly: number;
}
export const RETAIN: Readonly<Retention> = { daily: 7, weekly: 4 };

const NAME = /^portal-(\d{8}T\d{6}Z)-nightly\.db\.gz$/;
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const parseStamp = (s: string) =>
  new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);

/** `<data dir>/backups/nightly`. Work files there start with a dot, so the off-site mirror skips them (`--exclude ".*"`). */
export const nightlyDir = (dataDir: string) => join(dataDir, 'backups', 'nightly');

export interface NightlyInfo {
  file: string;
  at: Date;
  bytes: number;
}

/** The nightly backups in `dir`, newest first. */
export function listNightly(dir: string): NightlyInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, m: NAME.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => !!x.m)
    .map(({ name, m }) => {
      const file = join(dir, name);
      return { file, at: parseStamp(m[1]!), bytes: statSync(file).size };
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime() || b.file.localeCompare(a.file));
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
/** The Monday (UTC) of the ISO week `d` falls in. */
const weekKey = (d: Date) => dayKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY_MS));

/** Which of `list` (any order) to keep: the newest of each of the last `daily` days and of each of the last `weekly` weeks. */
export function toKeep<T extends { at: Date }>(list: T[], retain: Retention = RETAIN): Set<T> {
  const keep = new Set<T>();
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const b of [...list].sort((a, b) => b.at.getTime() - a.at.getTime())) {
    const d = dayKey(b.at);
    const w = weekKey(b.at);
    if (!days.has(d) && days.size < retain.daily) {
      days.add(d);
      keep.add(b);
    }
    if (!weeks.has(w) && weeks.size < retain.weekly) {
      weeks.add(w);
      keep.add(b);
    }
  }
  return keep;
}

/** Removes the nightly backups in `dir` that the retention doesn't keep; returns their paths. */
export function pruneNightly(dir: string, retain: Retention = RETAIN): string[] {
  const all = listNightly(dir);
  const keep = toKeep(all, retain);
  const removed = all.filter((b) => !keep.has(b)).map((b) => b.file);
  for (const f of removed) rmSync(f, { force: true });
  return removed;
}

function quickCheck(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || Object.values(rows[0]!)[0] !== 'ok') throw new Error(`${file} failed its integrity check.`);
  } finally {
    db.close();
  }
}

/**
 * Takes the nightly backup: an online copy of `<dataDir>/portal.db` (no lock, no pause for the portal), integrity-checked,
 * gzipped to `portal-<UTC stamp>-nightly.db.gz` (mode 0600, written under a dot name and renamed, so a mirror never sees half
 * a file), then prunes to the retention.
 */
export async function nightlyBackup(opts: { dataDir: string; dir?: string; now?: () => Date; retain?: Retention }) {
  const path = join(opts.dataDir, 'portal.db');
  if (!existsSync(path)) throw new Error(`No database at ${path}.`);
  const dir = opts.dir ?? nightlyDir(opts.dataDir);
  ensurePrivateDir(dir);
  const name = `portal-${stamp((opts.now ?? (() => new Date()))())}-nightly.db.gz`;
  const copy = join(dir, `.${name}.db`);
  const part = join(dir, `.${name}.part`);
  const file = join(dir, name);
  try {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
    try {
      await backup(db, copy);
    } finally {
      db.close();
    }
    finishBackup(copy);
    quickCheck(copy);
    await pipeline(createReadStream(copy), createGzip({ level: 9 }), createWriteStream(part, { mode: 0o600 }));
    chmodSync(part, 0o600);
    renameSync(part, file);
  } finally {
    rmSync(copy, { force: true });
    rmSync(part, { force: true });
  }
  const removed = pruneNightly(dir, opts.retain);
  return { file, bytes: statSync(file).size, removed };
}

/** Unzips a `.db.gz` backup to `to` (mode 0600). */
export async function gunzipBackup(file: string, to: string): Promise<string> {
  await pipeline(createReadStream(file), createGunzip(), createWriteStream(to, { mode: 0o600 }));
  chmodSync(to, 0o600);
  return to;
}

/**
 * `portal restore` for either kind of backup: a `.db.gz` is unzipped next to the other backups first, then restored as usual
 * (integrity, schema, key check; the replaced database kept; the portal starts Frozen). The portal must be stopped.
 */
export async function restoreAny(opts: { dataDir: string; file: string; secretKey: Buffer | null; migrations?: Migration[]; now?: () => Date }) {
  if (!opts.file.endsWith('.gz')) return restoreBackup(opts);
  const dir = join(opts.dataDir, 'backups');
  ensurePrivateDir(dir);
  const plain = join(dir, `.restore-${process.pid}-${Date.now()}.db`);
  try {
    await gunzipBackup(opts.file, plain);
    return await restoreBackup({ ...opts, file: plain });
  } finally {
    rmSync(plain, { force: true });
  }
}

/** Row counts of every table; `portal_meta` without its `frozen` row, which a restore adds on purpose. */
export function rowCounts(file: string): Record<string, number> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const q = `SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"${name === 'portal_meta' ? " WHERE key <> 'frozen'" : ''}`;
      counts[name] = Number((db.prepare(q).get() as { n: number }).n);
    }
    return counts;
  } finally {
    db.close();
  }
}

/** The tables whose row count differs, or that only one side has. */
export function compareCounts(backup: Record<string, number>, restored: Record<string, number>): DrillResult['mismatches'] {
  return [...new Set([...Object.keys(backup), ...Object.keys(restored)])]
    .filter((t) => backup[t] !== restored[t])
    .map((table) => ({ table, backup: backup[table] ?? null, restored: restored[table] ?? null }));
}

export interface DrillResult {
  /** Wall time of unzip plus restore, in milliseconds. */
  ms: number;
  tables: number;
  rows: number;
  /** Tables whose row count differs between the backup and the restored copy; empty is a pass. */
  mismatches: { table: string; backup: number | null; restored: number | null }[];
}

/**
 * The restore drill: restores `file` into a scratch data dir (never the live one), timed, and compares the row count of every
 * table in the backup with the restored database. Read-only for the live portal; safe while it runs.
 */
export async function restoreDrill(opts: { file: string; secretKey: Buffer | null; scratchDir?: string; migrations?: Migration[] }): Promise<DrillResult> {
  const scratch = opts.scratchDir ?? mkdtempSync(join(tmpdir(), 'cp-drill-'));
  try {
    const started = performance.now();
    const source = opts.file.endsWith('.gz') ? await gunzipBackup(opts.file, join(scratch, '.source.db')) : opts.file;
    await restoreBackup({ dataDir: scratch, file: source, secretKey: opts.secretKey, migrations: opts.migrations });
    const ms = performance.now() - started;
    const want = rowCounts(source);
    const mismatches = compareCounts(want, rowCounts(join(scratch, 'portal.db')));
    return { ms, tables: Object.keys(want).length, rows: Object.values(want).reduce((a, b) => a + b, 0), mismatches };
  } finally {
    if (!opts.scratchDir) rmSync(scratch, { recursive: true, force: true });
  }
}

export interface NightlyStatus {
  /** ISO time of the newest nightly backup, or null when there is none. */
  lastAt: string | null;
  /** True when there is none, or the newest is older than 26 hours: the nightly Job is not running or failing. */
  stale: boolean;
  count: number;
}

export function nightlyStatus(opts: { dataDir: string; now?: Date; staleAfterMs?: number }): NightlyStatus {
  const list = listNightly(nightlyDir(opts.dataDir));
  const last = list[0]?.at ?? null;
  const now = (opts.now ?? new Date()).getTime();
  return { lastAt: last?.toISOString() ?? null, stale: !last || now - last.getTime() > (opts.staleAfterMs ?? STALE_AFTER_MS), count: list.length };
}
