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
  ['M11 no re-read after the stagger', CTL, 'const again = this.#restartSkipWhy(row.id);', 'const again = undefined;'],
  ['M12 loop guard window too long', REC, 'r.detail.result === \'resumed\' && now - Date.parse(r.at) < DAY_MS)', 'r.detail.result === \'resumed\' && now - Date.parse(r.at) < DAY_MS * 2)'],
  ['M13 old cut-off kept', REC, 'now - at >= RESTART_PENDING_MS', 'now - at >= RESTART_PENDING_MS * 99'],
  ['M14 no platform audit row', 'apps/server/src/chat/restartAudit.ts', '    record({', '    void ({'],
];
const run = () => {
  try {
    execFileSync('node', ['--import', 'tsx', '--test', 'src/chat/restartRecovery.test.ts', 'src/chat/restartAudit.test.ts'], { cwd: 'apps/server', stdio: 'pipe', timeout: 240_000 });
    return true;
  } catch {
    return false;
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
  writeFileSync(file, src.replace(from, to));
  const passed = run();
  writeFileSync(file, src);
  console.log(`T971-MUTANT ${name}: ${passed ? 'SURVIVED' : 'KILLED'}`);
  if (passed) bad++;
}
console.log(`T971-MUTANTS ${mutants.length - bad}/${mutants.length} killed`);
process.exit(bad ? 1 : 0);
