// T-971 H2 mutant proof. Run from the repo root inside a Job: each mutant breaks one rule of restart recovery, runs restartRecovery.test.ts and
// must FAIL (KILLED); the file is restored after each. Exit 1 when one survives or a replacement did not apply.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CTL = 'apps/server/src/chat/controller.ts';
const REC = 'apps/server/src/chat/recover.ts';
const mutants = [
  // (Not the #live call alone: the continuation #send relaunches a gone process by the same path, so that is an equivalent mutant.)
  ['M1 no resume', CTL, 'else if (this.#restartResumed >= config.max)', 'else if (true)'],
  ['M2 Bypass kept', CTL, 'keepBypass && // T-971 H2', 'true && // T-971 H2'],
  ['M3 no limit', CTL, 'this.#restartResumed >= config.max)', 'this.#restartResumed >= config.max + 99)'],
  ['M4 not idempotent', REC, 'newest.delete(r.sessionId!);', 'void cut;'],
  ['M5 ended resumed', CTL, "if (!row || row.state === 'ended') return 'it has ended';", "if (!row) return 'it has ended';"],
  ['M6 archived resumed', CTL, "if (row.archived_at) return 'it is archived';", ''],
  ['M7 no window', CTL, 'this.#clock() - this.#startedAt > RESTART_WINDOW_MS ||', 'false ||'],
  ['M8 idle counts', CTL, "|| row.state !== 'working') return;", ') return;'],
  ['M9 no stagger', CTL, 'if (attempted > 0) await (this.restartPause ?? ((ms: number) => this.#wait(ms)))(config.staggerMs);', ''],
  ['M10 no loop guard', CTL, 'restartResumesToday(recoveries, next.sessionId, now) >= RESTART_RESUMES_PER_DAY)', 'false)'],
  ['M11 no re-read after the stagger', CTL, 'const again = this.#restartSkipWhy(row.id, next.started);', 'const again = undefined;'],
  ['M12 loop guard window too long', REC, 'TRIED.has(String(r.detail.result)) && now - Date.parse(r.at) < DAY_MS)', 'TRIED.has(String(r.detail.result)) && now - Date.parse(r.at) < DAY_MS * 2)'],
  ['M13 old cut-off kept', REC, 'now - at >= RESTART_PENDING_MS', 'now - at >= RESTART_PENDING_MS * 99'],
  // QA #11062: the exact edges. H5: an hour-old cut-off is kept (>= to >). H9: a resume exactly 24 hours old still counts (< to <=).
  ['H5 pending edge >= to >', REC, 'now - at >= RESTART_PENDING_MS) continue', 'now - at > RESTART_PENDING_MS) continue'],
  ['H9 day edge < to <=', REC, 'now - Date.parse(r.at) < DAY_MS).length', 'now - Date.parse(r.at) <= DAY_MS).length'],
  // Blind review of H2 S1 (#10978). B7: no age limit on a cut-off. B10: the failure text is not scrubbed. B13: failed tries do not count against
  // the daily limit. A1 and A2: a session a person put to sleep, or resumed and stopped, is resumed anyway.
  ['B7 no cut-off age limit', REC, 'now - at >= RESTART_PENDING_MS) continue', 'false) continue'],
  ['B10 failure text not scrubbed', CTL, 'why = this.scrub(row.workspace_id, isAppError(e) ? e.message : this.#message(e));', 'why = isAppError(e) ? e.message : this.#message(e);'],
  ['B13 failed tries not counted', REC, "new Set(['resumed', 'failed'])", "new Set(['resumed'])"],
  ['A1 asleep is resumed', CTL, "if (row.process === 'asleep') return 'it was put to sleep since';", ''],
  ['A2 other generation is resumed', CTL, "if (started !== undefined && (row.process_started_at ?? null) !== started) return 'it was resumed and stopped since';", ''],
  ['M14 no platform audit row', 'apps/server/src/chat/restartAudit.ts', '    record({', '    void ({'],
];
// Returns { passed, failing }: `failing` is the names of the tests that failed (what killed the mutant).
const run = () => {
  try {
    execFileSync('node', ['--import', 'tsx', '--test', 'src/chat/restartRecovery.test.ts', 'src/chat/restartAudit.test.ts'], { cwd: 'apps/server', stdio: 'pipe', timeout: 240_000 });
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
    console.log(`T971-MUTANT ${name}: NOT APPLIED`);
    bad++;
    continue;
  }
  const mutated = src.replace(from, to);
  if (mutated === src) {
    console.log(`T971-MUTANT ${name}: EMPTY DIFF`);
    bad++;
    continue;
  }
  writeFileSync(file, mutated);
  const { passed, failing } = run();
  writeFileSync(file, src);
  console.log(`T971-MUTANT ${name}: applied (${src.length} -> ${mutated.length} chars) ${passed ? 'SURVIVED' : 'KILLED'}`);
  for (const f of failing.slice(0, 3)) console.log(`T971-MUTANT ${name}:   failing: ${f}`);
  if (passed) bad++;
}
console.log(`T971-MUTANTS ${mutants.length - bad}/${mutants.length} killed`);
process.exit(bad ? 1 : 0);
