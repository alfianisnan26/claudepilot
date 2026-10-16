// QA mutation helper (T-623 S2d, c288c0d5): reverts ONE behaviour in apps/server/src/browser/gate.ts. Run from apps/server.
// Fails (rc 1) when the text to change is not found exactly once.
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/browser/gate.ts';
const M = {
  // the quote- and note-stripped form is not added
  nostrip: ["    out.push(q ? q[2] : rest.replace(/(^|\\s+)#.*$/, ''));\n", ''],
  // only the raw variable is masked (parsedForms not applied)
  rawonly: ['  .flatMap((v) => parsedForms(v))\n', ''],
  // the KEY= prefix is not removed
  nokey: ["    if (m) rest = (m[1] || '').trim();\n", ''],
  // the trailing note is not removed
  nonote: ["q ? q[2] : rest.replace(/(^|\\s+)#.*$/, '')", 'q ? q[2] : rest'],
  // the quote strip is gone (the note strip stays)
  noquote: ['q ? q[2] : rest.replace(', 'rest.replace('],
  // the per-line split is gone
  singleline: ['for (const raw of v.split(/\\r?\\n/)) {', 'for (const raw of [v]) {'],
  // `export ` before KEY= is not accepted
  noexport: ['/^(?:export\\s+)?[A-Za-z_]', '/^[A-Za-z_]'],
  // the 8-character floor is removed from the final filter
  floor: ['.filter((v, i, all) => v.length >= 8 && all.indexOf(v) === i)', '.filter((v, i, all) => all.indexOf(v) === i)'],
  // the KEY=-stripped form is not added (the stripped form alone stays)
  norest: ['    out.push(rest);\n', ''],
};
const name = process.argv[2];
if (!M[name]) { console.error('unknown mutant', name); process.exit(1); }
const [from, to] = M[name];
const src = readFileSync(file, 'utf8');
const n = src.split(from).length - 1;
if (n !== 1) { console.error(`mutant ${name}: the text to change was found ${n} times (need 1)`); process.exit(1); }
writeFileSync(file, src.replace(from, () => to));
console.log(`mutant ${name} applied`);
