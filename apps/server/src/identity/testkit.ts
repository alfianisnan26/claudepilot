// Test helpers for identity: an in-memory database with every migration applied, in order.
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../store/migrations.js';

export function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) m.up(db);
  return db;
}
