// Test helpers for identity (and for every package that needs a signed-in user in a test): an in-memory database with the real
// migrations, an identity module on it, accounts with known passwords, and sign-ins that give a cookie value.

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../store/migrations.js';
import type { Store } from '../store/store.js';

/** An in-memory database with every migration applied, in order. */
export function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) m.up(db);
  return db;
}

/** The slice of `Store` identity uses, over an in-memory database. `writable` can be switched to play a Frozen store. */
export function memoryStore(db = memoryDb()): Pick<Store, 'db' | 'writable'> & { frozen: boolean } {
  const store = {
    frozen: false,
    get db() {
      return db;
    },
    get writable() {
      return !store.frozen;
    },
  };
  return store;
}
