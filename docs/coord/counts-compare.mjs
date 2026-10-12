// Compares per-table row counts of two SQLite files (pre and post migration) and prints user_version of each; never prints row contents.
import { DatabaseSync } from 'node:sqlite';
const [pre, post] = process.argv.slice(2);
function counts(path) {
  const db = new DatabaseSync(path);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n);
  const uv = Number(db.prepare('PRAGMA user_version').get().user_version);
  db.close();
  return { out, uv };
}
const a = counts(pre), b = counts(post);
console.log(`user_version: pre=${a.uv} post=${b.uv}; tables: pre=${Object.keys(a.out).length} post=${Object.keys(b.out).length}`);
let bad = 0;
for (const [t, n] of Object.entries(a.out)) {
  if (!(t in b.out)) { console.log(`MISSING TABLE after migration: ${t} (had ${n} rows)`); bad++; }
  else if (b.out[t] < n) { console.log(`ROWS LOST in ${t}: ${n} -> ${b.out[t]}`); bad++; }
}
const added = Object.keys(b.out).filter((t) => !(t in a.out));
console.log(`new tables: ${added.length}; rows kept in all ${Object.keys(a.out).length} old tables: ${bad === 0 ? 'YES' : 'NO (' + bad + ' problems)'}`);
process.exit(bad ? 1 : 0);
