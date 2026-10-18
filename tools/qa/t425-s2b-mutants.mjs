// Proof for T-425 S2b: caps.test.ts as it is, then with each mutant of controller.ts; every mutant must make the suite fail ("KILLED") and
// must really change the file (the line "applied (N -> M chars)" shows the diff is not empty). The file is restored after each.
// B: the send does not wait for the sends before it. C: the undo of the optimistic Working has no "unless something else moved it" guard.
// D: a failed write does not undo the optimistic Working at all. Run from the repo root inside a cluster Job (job-run).
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
const mutants = [
  ['B (no await inLine)', 'await inLine; // the sends before this one are written first', ''],
  ['C (no guard on the undo)', "if (woke && before && this.#chat.get(sessionId)?.state === 'working') {", 'if (woke && before) {'],
  ['D (no undo)', "if (woke && before && this.#chat.get(sessionId)?.state === 'working') {", 'if (false as boolean) {'],
];
for (const [label, from, to] of mutants) {
  const at = original.indexOf(from);
  if (at < 0) {
    console.log(`NOT APPLIED mutant ${label}: the line to change was not found`);
    bad++;
    continue;
  }
  const mutated = original.slice(0, at) + to + original.slice(at + from.length);
  if (mutated === original) {
    console.log(`EMPTY DIFF mutant ${label}`);
    bad++;
    continue;
  }
  console.log(`applied mutant ${label} (${original.length} -> ${mutated.length} chars)`);
  writeFileSync(path, mutated);
  try {
    const r = run();
    if (r.status === 0) {
      console.log(`SURVIVED mutant ${label}`);
      bad++;
    } else console.log(`KILLED   mutant ${label} rc=${r.status}\n${names(r)}`);
  } finally {
    writeFileSync(path, original);
  }
}

console.log(bad ? `FAILED: ${bad} problem(s)` : 'ALL GREEN: baseline passes, mutants B, C, D killed');
process.exit(bad ? 1 : 0);
