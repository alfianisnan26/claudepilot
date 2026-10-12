import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '/workspaces/claudepilot/apps/server/src/store/migrations.ts';
const db = new DatabaseSync(':memory:');
const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);
for (const m of sorted) {
  db.exec('BEGIN');
  try { m.up(db); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); console.error('migration failed', m.version, m.name, (e as Error).message); }
}
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
console.log('versions', sorted.map((m) => m.version).join(','));
for (const { name } of tables) {
  const cols = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string; type: string; pk: number }[];
  const n = (db.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n;
  console.log(`${name}: ${cols.map((c) => c.name + (c.pk ? '*' : '')).join(', ')}`);
}
