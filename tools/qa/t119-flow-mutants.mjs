// T-119 S1a mutant proof. Run from the repo root inside a Job: each mutant breaks one rule of ticketFlow, runs ticketFlow.test.ts and must FAIL
// (KILLED); the file is restored after each. Exit 1 when one survives or a replacement did not apply.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'apps/server/src/tickets/ticketFlow.ts';
const mutants = [
  ['F1 events not put in time order', 'evs.sort((a, b) => a.at - b.at);', ''],
  ['F2 closed state is not a point', 'r.end = isTicketClosed(r.state as TicketStatus) ? r.start : Math.max(until, r.start);', 'r.end = Math.max(until, r.start);'],
  ['F3 a reopen is not a move', "new Set(['status', 'closed', 'reopened'])", "new Set(['status', 'closed'])"],
  ['F4 no event: the ticket status is ignored', "(input.status ?? 'open')", "'open'"],
  ['F5 the waiting tag never opens a window', 'if (waiting && !on)', 'if (false && !on)'],
  ['F6 the waiting window never closes on the tag going', 'else if (!waiting && on)', 'else if (false && on)'],
  ['F7 an open span runs to the real clock', '(Number.isFinite(r.end) ? r.end : now) - r.start', '(Number.isFinite(r.end) ? r.end : Date.now()) - r.start'],
  ['F8 an agent comment is a marker', '!isAgent(e) && e.actor', 'e.actor'],
  ['F9 an unknown status is a move', 'isStatus(x.e.data?.to));', "typeof x.e.data?.to === 'string');"],
  ['F10 waiting at creation is ignored', 'hasWaitingTag(createdEv?.e.data?.tags) ||', 'false ||'],
  // F11 was `isTicketClosed(..) || r.end <= r.start` -> `r.end <= r.start`: an EQUIVALENT mutant (a closed span is a point, so end <= start
  // already holds) and the reason the S1b Job failed. The clause is gone from the code; this mutant breaks the rule the clause was meant to keep.
  ['F11 a waiting span is not cut by the close', 'const w1 = Math.min(w.end, r.end);', 'const w1 = w.end;'],
  ['F12 clipFlow keeps spans that end before the window', 'return a <= to && b >= from;', 'return a <= to;'],
  ['F13 clipFlow keeps markers after the window', 'return at >= from && at <= to;', 'return at >= from;'],
];
const run = () => {
  try {
    execFileSync('node', ['--import', 'tsx', '--test', 'src/tickets/ticketFlow.test.ts'], { cwd: 'apps/server', stdio: 'pipe', timeout: 240_000 });
    return { passed: true, failing: [] };
  } catch (e) {
    const out = `${e.stdout ?? ''}`;
    return { passed: false, failing: out.split('\n').filter((l) => /^not ok /.test(l)).map((l) => l.replace(/^not ok \d+ - /, '').slice(0, 110)) };
  }
};
let bad = 0;
for (const [name, from, to] of mutants) {
  const src = readFileSync(SRC, 'utf8');
  if (!src.includes(from)) {
    console.log(`T119-MUTANT ${name}: NOT APPLIED`);
    bad++;
    continue;
  }
  const mutated = src.replace(from, to);
  if (mutated === src) {
    console.log(`T119-MUTANT ${name}: EMPTY DIFF`);
    bad++;
    continue;
  }
  writeFileSync(SRC, mutated);
  const { passed, failing } = run();
  writeFileSync(SRC, src);
  console.log(`T119-MUTANT ${name}: applied (${src.length} -> ${mutated.length} chars) ${passed ? 'SURVIVED' : 'KILLED'}`);
  for (const f of failing.slice(0, 3)) console.log(`T119-MUTANT ${name}:   failing: ${f}`);
  if (passed) bad++;
}
console.log(`T119-MUTANTS ${mutants.length - bad}/${mutants.length} killed`);
process.exit(bad ? 1 : 0);
