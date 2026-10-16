// scratch: replace one exact string (once) in a file, for each (file, from, to) triple; exit 1 when a string is not found.
import { readFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
for (let i = 0; i + 2 < a.length + 0; i += 3) {
  const [f, from, to] = [a[i], a[i + 1], a[i + 2]];
  const s = readFileSync(f, 'utf8');
  if (!s.includes(from)) { console.error(`not found in ${f}: ${from}`); process.exit(1); }
  writeFileSync(f, s.replace(from, () => to));
}
