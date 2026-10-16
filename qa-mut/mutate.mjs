// QA mutation helper (T-611 merge f722dca1): reverts ONE behaviour in scripts/job-run.sh. Run from apps/server.
// Fails (rc 1) when the text to change is not found exactly once.
import { readFileSync, writeFileSync } from 'node:fs';

const file = '../../scripts/job-run.sh';
const M = {
  // --reuse together with --pool-env is no longer refused
  reusepool: [`  [ -z "$pool_names" ] || die "--reuse cannot be used with --pool-env (a reused pass would not have run with the credential, and nothing made with one is saved)"\n`, ''],
  // the refusal runs BEFORE the --pool-env name checks (a bad name no longer dies at its own check)
  reuseorder: ['pool_names=\nfor n in ${pool[@]+"${pool[@]}"}; do\n', '[ -z "$reuse" ] || [ ${#pool[@]} -eq 0 ] || die "--reuse cannot be used with --pool-env (early)"\npool_names=\nfor n in ${pool[@]+"${pool[@]}"}; do\n'],
  // the store is also used by a run that has --pool-env but no --reuse
  storenoreuse: ['if [ -n "$reuse" ]; then\n  # T-611 (QA UI 8207', 'if [ -n "$reuse" ] || [ -n "$pool_names" ]; then\n  # T-611 (QA UI 8207'],
  // a hit makes a kubectl call
  hitkubectl: ['  cat "$cache/$key.log"\n', '  kubectl get nodes >/dev/null 2>&1 || true\n  cat "$cache/$key.log"\n'],
  // the key no longer hashes job-run.yaml
  keyyaml: ['cat "$0" "$here/deploy/k3s-build/job-run.yaml" | sha256sum', 'cat "$0" | sha256sum'],
  // the key no longer hashes job-run.sh
  keyscript: ['cat "$0" "$here/deploy/k3s-build/job-run.yaml" | sha256sum', 'cat "$here/deploy/k3s-build/job-run.yaml" | sha256sum'],
  // the __MASTER_REQUIRED__ fill is gone (a placeholder is left)
  noplaceholderfill: ['-e "s#__MASTER_REQUIRED__#$master_rule#" ', ''],
  // the pool marker is not replaced
  nopoolfill: ['-e "s|^ *# __POOL_ENV__.*\\$|$pool_refs|" ', ''],
  // the run container's pool ref is not scoped (name without JR_POOL_)
  poolname: ['- {name: JR_POOL_$n, valueFrom', '- {name: $n, valueFrom'],
  // D-65: the node-name pattern accepts any non-empty text (tab/DEL still stopped by the ASCII check)
  nameregex: ['[[ $n =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || die "JOB_RUN_AVOID_NODES is a comma list of node names (letters, digits, . and -)"', '[[ -n $n ]] || die "JOB_RUN_AVOID_NODES is a comma list of node names (letters, digits, . and -)"'],
  // D-65: the refused name is echoed
  echoname: ['die "JOB_RUN_AVOID_NODES is a comma list of node names (letters, digits, . and -)"\n    avoid_json', 'die "JOB_RUN_AVOID_NODES is a comma list of node names (letters, digits, . and -): $n"\n    avoid_json'],
  // D-65: the ASCII check is gone (tab and DEL pass the printable test; the name regex still refuses them, so this is expected to survive)
  ascii: [`  ! printf '%s' "$JOB_RUN_AVOID_NODES" | LC_ALL=C grep -q '[^ -~]' || die "JOB_RUN_AVOID_NODES is a comma list of node names (ASCII letters, digits, . and -)"\n`, ''],
  // drop-failed no longer restores master_known (no later reader: expected equivalent)
  dropknown: ['master_pct=$was_pct; master_known=$was_known\n    echo "job-run: the placement rule was not dropped', 'master_pct=$was_pct\n    echo "job-run: the placement rule was not dropped'],
  // S2b fixes, kept from the earlier run
  newline: [`  [[ $JOB_RUN_AVOID_NODES != *$'\\n'* && $JOB_RUN_AVOID_NODES != *$'\\r'* ]] || die "JOB_RUN_AVOID_NODES must be one line (no newline)"\n`, ''],
  finalline: ['queued=$((t1 - t0))s${avoid_txt:+ avoid=$avoid_txt}"', 'queued=$((t1 - t0))s"'],
  droplog: [`    plog "=== JOB-RUN PLACEMENT node=control-plane at=release outcome=drop-failed (the rule was not dropped: the Job runs on its create-time rule)" >/dev/null\n`, ''],
  droppct: ['master_aff=$was_aff; master_pct=$was_pct; master_known=$was_known\n    echo "job-run: the placement rule was not dropped', 'master_aff=$was_aff; master_known=$was_known\n    echo "job-run: the placement rule was not dropped'],
  addclosed: [`    die "the control-plane node went over its line while $job waited, and its rule could not be added: run it again"`, `    echo "mutant: add failure ignored" >&2`],
};
const name = process.argv[2];
if (!M[name]) { console.error('unknown mutant', name); process.exit(1); }
const [from, to] = M[name];
const src = readFileSync(file, 'utf8');
const n = src.split(from).length - 1;
if (n !== 1) { console.error(`mutant ${name}: the text to change was found ${n} times (need 1)`); process.exit(1); }
writeFileSync(file, src.replace(from, () => to));
console.log(`mutant ${name} applied`);
