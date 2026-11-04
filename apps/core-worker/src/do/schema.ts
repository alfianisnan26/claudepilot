import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';

export type DoKind = 'platform' | 'org' | 'workspace' | 'chat-session' | 'bridge';

export interface DoPing {
  ok: true;
  kind: DoKind;
  /** The schema version this object's SQLite store is at. */
  schemaVersion: number;
}

/**
 * A Durable Object on the SQLite store with its own schema version. Migrations are append only (index i is version
 * i + 1, never edit a released one) and run once, in one transaction each, before the object takes any call.
 */
export abstract class SchemaDO extends DurableObject<Env> {
  readonly #kind: DoKind;
  #version = 0;

  protected constructor(ctx: DurableObjectState, env: Env, kind: DoKind, migrations: readonly string[]) {
    super(ctx, env);
    this.#kind = kind;
    void ctx.blockConcurrencyWhile(async () => {
      this.#version = migrate(ctx.storage, migrations);
    });
  }

  ping(): DoPing {
    return { ok: true, kind: this.#kind, schemaVersion: this.#version };
  }
}

function migrate(storage: DurableObjectStorage, migrations: readonly string[]): number {
  const sql = storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
  let version = sql.exec<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_version').one().v ?? 0;
  for (; version < migrations.length; version++) {
    const next = version + 1;
    storage.transactionSync(() => {
      sql.exec(migrations[version]!);
      sql.exec('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', next, Date.now());
    });
  }
  return version;
}
