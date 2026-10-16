// QA T-612 S1: apply ONE exact text change to a copy of scripts/quick-check.sh. Errors unless the text is found exactly once.
import { readFileSync, writeFileSync } from 'node:fs';
const M = {
  skipinit: ['skips=""; bin=', 'skips="stale"; bin='],
  noappend: ['skips="$skips $1"; echo "::: $1 SKIPPED', 'echo "::: $1 SKIPPED'],
  skipname: ['skips="$skips $1"', 'skips="$skips x"'],
  incexit0: ['(the other steps passed)"; exit 1; fi;', '(the other steps passed)"; exit 0; fi;'],
  alsodrop: ['${skips:+ (also SKIPPED:$skips)}', ''],
  failexit0: ['(also SKIPPED:$skips)}"; exit 1; fi;', '(also SKIPPED:$skips)}"; exit 0; fi;'],
  fmtecho: ["else skip format 'no prettier'; fi", 'else echo "::: format SKIPPED"; fi'],
  lintecho: ["else skip lint 'no eslint'; fi", 'else echo "::: lint SKIPPED"; fi'],
  noskipcheck: ['if [ -n "$skips" ]; then echo "QUICK CHECK INCOMPLETE', 'if false; then echo "QUICK CHECK INCOMPLETE'],
  norecord: ['fails="$fails $name"; echo', 'echo'],
  rctrue: ['if [ $rc -eq 0 ]; then', 'if true; then'],
  nocheckflag: ['--check --ignore-unknown', '--ignore-unknown'],
  failsfirst: ['if [ -n "$fails" ]; then echo "QUICK CHECK FAILED', 'if [ -n "$fails$skips" ]; then echo "QUICK CHECK FAILED'],
};
const [file, name] = process.argv.slice(2);
if (!M[name]) {
  console.error('unknown mutant ' + name);
  process.exit(2);
}
const [a, b] = M[name];
const s = readFileSync(file, 'utf8');
const n = s.split(a).length - 1;
if (n !== 1) {
  console.error(`mutant ${name}: text found ${n} times`);
  process.exit(3);
}
writeFileSync(file, s.replace(a, () => b));
