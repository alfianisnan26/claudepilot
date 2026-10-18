// T-634 mutant proof. Run from the repo root inside a Job: each mutant breaks one rule of claiming a ticket by id, runs the two test files and
// must FAIL (KILLED); the file is restored after each. Exit 1 when one survives or a replacement did not apply.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SVC = 'apps/server/src/tickets/service.ts';
const mutants = [
  // The named claim no longer takes a ticket in review: the lead cannot get it, so it cannot close it.
  ['C1 in_review not claimable by id', SVC, `"t.status IN ('open', 'in_progress', 'in_review', 'blocked')"`, `"t.status IN ('open', 'in_progress', 'blocked')"`],
  // The claim also takes a ticket a session holds: a worker could take over a live session's ticket.
  ['C2 held ticket claimable', SVC, `'t.assignee_kind IS NULL',`, `'1 = 1',`],
  // The claim assigns the ticket to nobody the caller knows: the lead is still FORBIDDEN on close.
  ['C3 claim assigns another session', SVC, `.run('session', session.id, status,`, `.run('session', 'nobody', status,`],
];
const run = () => {
  try {
    execFileSync('node', ['--import', 'tsx', '--test', 'src/tickets/tickets.test.ts', 'src/tickets/portalTools.test.ts'], { cwd: 'apps/server', stdio: 'pipe', timeout: 240_000 });
    return { passed: true, failing: [] };
  } catch (e) {
    const out = `${e.stdout ?? ''}`;
    return { passed: false, failing: out.split('\n').filter((l) => /^not ok /.test(l)).map((l) => l.replace(/^not ok \d+ - /, '').slice(0, 110)) };
  }
};
let bad = 0;
for (const [name, file, from, to] of mutants) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes(from)) {
    console.log(`T634-MUTANT ${name}: NOT APPLIED`);
    bad++;
    continue;
  }
  const mutated = src.replace(from, to);
  if (mutated === src) {
    console.log(`T634-MUTANT ${name}: EMPTY DIFF`);
    bad++;
    continue;
  }
  writeFileSync(file, mutated);
  const { passed, failing } = run();
  writeFileSync(file, src);
  console.log(`T634-MUTANT ${name}: applied (${src.length} -> ${mutated.length} chars) ${passed ? 'SURVIVED' : 'KILLED'}`);
  for (const f of failing.slice(0, 3)) console.log(`T634-MUTANT ${name}:   failing: ${f}`);
  if (passed) bad++;
}
console.log(`T634-MUTANTS ${mutants.length - bad}/${mutants.length} killed`);
process.exit(bad ? 1 : 0);
