// QA mutation helper (T-611 S2b): reverts ONE fix in scripts/job-run.sh. Run from apps/server. Fails (rc 1) when the text to revert is not found exactly once.
import { readFileSync, writeFileSync } from 'node:fs';

const file = '../../scripts/job-run.sh';
const M = {
  // F1: the newline / CR refusal
  newline: [`  [[ $JOB_RUN_AVOID_NODES != *$'\\n'* && $JOB_RUN_AVOID_NODES != *$'\\r'* ]] || die "JOB_RUN_AVOID_NODES must be one line (no newline)"\n`, ''],
  // F2: the non-ASCII refusal
  ascii: [`  ! printf '%s' "$JOB_RUN_AVOID_NODES" | LC_ALL=C grep -q '[^ -~]' || die "JOB_RUN_AVOID_NODES is a comma list of node names (ASCII letters, digits, . and -)"\n`, ''],
  // F3: the avoid list on the final PLACEMENT line
  finalline: ['queued=$((t1 - t0))s${avoid_txt:+ avoid=$avoid_txt}"', 'queued=$((t1 - t0))s"'],
  // F3b: the Pending message and log line use the raw value instead of the validated list
  rawecho: ['($avoid_txt), and no other node fits', '($JOB_RUN_AVOID_NODES), and no other node fits'],
  // F4: the drop-failed log line
  droplog: [`    plog "=== JOB-RUN PLACEMENT node=control-plane at=release outcome=drop-failed (the rule was not dropped: the Job runs on its create-time rule)" >/dev/null\n`, ''],
  // F4b: the kept create-time percentage after a failed drop
  droppct: ['master_aff=$was_aff; master_pct=$was_pct\n    echo "job-run: the placement rule was not dropped', 'master_aff=$was_aff\n    echo "job-run: the placement rule was not dropped'],
  // F4c: the failed add stays fail-closed (rc 2)
  addclosed: [`    die "the control-plane node went over its line while $job waited, and its rule could not be added: run it again"`, `    echo "mutant: add failure ignored" >&2`],
};
const name = process.argv[2];
if (!M[name]) { console.error('unknown mutant', name); process.exit(1); }
const [from, to] = M[name];
const src = readFileSync(file, 'utf8');
const n = src.split(from).length - 1;
if (n !== 1) { console.error(`mutant ${name}: the text to revert was found ${n} times (need 1)`); process.exit(1); }
writeFileSync(file, src.replace(from, () => to));
console.log(`mutant ${name} applied`);
