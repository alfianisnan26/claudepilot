// QA mutation helper (T-524 S3c + T-733 S5, ee56bab9): reverts or breaks ONE behaviour in scripts/job-run.sh. Run from apps/server.
// Fails (rc 1) when the text to change is not found exactly once.
import { readFileSync, writeFileSync } from 'node:fs';

const file = '../../scripts/job-run.sh';
const WAY = 'if [ -n "$master_rule_why" ]; then rule_way=added; else rule_way=dropped; fi';
const M = {
  // added and dropped swapped
  swapway: [WAY, 'if [ -n "$master_rule_why" ]; then rule_way=dropped; else rule_way=added; fi'],
  // the direction is read from the state BEFORE the change (wrong way round)
  usewas: [WAY, 'if [ -n "$was_why" ]; then rule_way=added; else rule_way=dropped; fi'],
  // the direction is "added" whenever any rule exists (the avoid list alone keeps a rule, so a drop with an avoid list says added)
  wayrule: [WAY, 'if [ -n "$master_rule" ]; then rule_way=added; else rule_way=dropped; fi'],
  // the line is printed before the patch is tried (so also after a refused patch)
  early: ['  aff=${master_aff:-null}\n', '  aff=${master_aff:-null}\n  echo "job-run: placement changed while queued: the rule away from the control-plane node was added: early" >&2\n'],
  // the placement text after the direction is gone
  notail: ['was $rule_way: ${place_msg:-$place_say}"', 'was $rule_way"'],
  // the patch is built from the printed rule text, not from the JSON of the rule
  patchrule: [`'"$aff"'`, `'"$master_rule"'`],
  // a dropped rule is patched to an empty object instead of null
  nullaff: ['aff=${master_aff:-null}', 'aff=${master_aff:-"{}"}'],
  // a patch is made whenever the REASON changed, not when the rule changed (headroom <-> over with the same rule)
  gatewas: ['elif [ "$was_rule" != "$master_rule" ]; then', 'elif [ "$was_why" != "$master_rule_why" ]; then'],
  // a failed drop is not restored (the last placement line would say dropped)
  norestore: [
    '    master_rule_why=$was_why; master_rule=$was_rule; master_aff=$was_aff; master_pct=$was_pct; master_known=$was_known\n    echo "job-run: the placement rule was not dropped',
    '    echo "job-run: the placement rule was not dropped',
  ],
  // the line goes to stdout instead of stderr
  stdout: ['was $rule_way: ${place_msg:-$place_say}" >&2', 'was $rule_way: ${place_msg:-$place_say}"'],
};
const name = process.argv[2];
if (!M[name]) { console.error('unknown mutant', name); process.exit(1); }
const [from, to] = M[name];
const src = readFileSync(file, 'utf8');
const n = src.split(from).length - 1;
if (n !== 1) { console.error(`mutant ${name}: the text to change was found ${n} times (need 1)`); process.exit(1); }
writeFileSync(file, src.replace(from, () => to));
console.log(`mutant ${name} applied`);
