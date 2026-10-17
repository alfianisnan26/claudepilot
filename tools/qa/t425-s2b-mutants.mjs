// Proof for T-425 S2b (the ordering test): caps.test.ts as it is, then with QA's mutant B (the send does not wait for the sends before it);
// the mutant must make the suite fail ("KILLED"). The file is restored after. Run from the repo root inside a cluster Job (job-run).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const CONTROLLER = 'apps/server/src/chat/controller.ts';
const test = { cwd: 'apps/server', args: ['--import', 'tsx', '--test', 'src/chat/caps.test.ts'] };
const run = () => spawnSync(process.execPath, test.args, { cwd: join(root, test.cwd), encoding: 'utf8' });
const names = (r) => `${r.stdout}`.split('\n').filter((l) => /^not ok /.test(l)).join('\n');
let bad = 0;

const base = run();
console.log(`BASELINE caps.test.ts rc=${base.status}`);
if (base.status !== 0) {
  bad++;
  console.log(`${base.stdout}${base.stderr}`.split('\n').slice(-30).join('\n'));
}

const path = join(root, CONTROLLER);
const original = readFileSync(path, 'utf8');
const from = 'await inLine; // the sends before this one are written first';
const at = original.indexOf(from);
if (at < 0) {
  console.log('NOT APPLIED mutant B: the line to change was not found');
  bad++;
} else {
  writeFileSync(path, original.slice(0, at) + original.slice(at + from.length));
  try {
    const r = run();
    if (r.status === 0) {
      console.log('SURVIVED mutant B (no await inLine)');
      bad++;
    } else console.log(`KILLED   mutant B (no await inLine) rc=${r.status}\n${names(r)}`);
  } finally {
    writeFileSync(path, original);
  }
}

console.log(bad ? `FAILED: ${bad} problem(s)` : 'ALL GREEN: baseline passes, mutant B killed');
process.exit(bad ? 1 : 0);
