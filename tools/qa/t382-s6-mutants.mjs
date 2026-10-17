// Proof for T-382 S6 (bounded counts on page 1 of the CI runs list): the changed tests as they are, the bench in smoke mode (it must run), then
// once per mutant with one change in production code; every mutant must make its test fail ("KILLED"). The file is restored after each.
// Run from the repo root inside a cluster Job (job-run), never in the pod. Exit 0 only when the baseline is green and no mutant survives.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const web = (file) => ({ cwd: 'apps/web', args: ['--import', 'tsx', '--disable-warning=ExperimentalWarning', '--test', file] });
const server = (file) => ({ cwd: 'apps/server', args: ['--import', 'tsx', '--test', file] });

const STORE = 'apps/server/src/ci/store.ts';
const ROUTES = 'apps/server/src/ci/routes.ts';
const MODEL = 'apps/web/src/features/glance/widgets/ci/model.ts';

const T_RUNS = server('src/ci/runsPage.test.ts');
const T_MODEL = web('src/features/glance/widgets/ci/model.test.ts');
const BENCH = { cwd: 'apps/server', args: ['--import', 'tsx', 'src/perf/listPage.bench.ts'], env: { BENCH_SMOKE: '1' } };

const mutants = [
  {
    name: 'a  the scan bound on the counts removed (every run is checked, the count is never null)',
    file: STORE,
    from: 'if (every.length > maxScan) return { rows, next, total: null, active: null };',
    to: '',
    test: T_RUNS,
  },
  {
    name: 'b  the SQL count path removed (a caller without keep is scanned too)',
    file: STORE,
    from: 'if (!args.keep) {',
    to: 'if (false as boolean) {',
    test: T_RUNS,
  },
  {
    name: 'c  the route always checks run by run (the founding user loses the SQL count)',
    file: ROUTES,
    from: 'const keep = seesEverything(actor) ? undefined : check;',
    to: 'const keep = check;',
    test: T_RUNS,
  },
  {
    name: 'd  the bound is raised to limit * 1000',
    file: STORE,
    from: 'const maxScan = limit * SCAN_FACTOR;',
    to: 'const maxScan = limit * 1000;',
    test: T_RUNS,
  },
  { name: 'e  the glance card turns a null running count into zero', file: MODEL, from: 'active: list?.active ?? null,', to: 'active: list?.active ?? 0,', test: T_MODEL },
];

const run = (t) => spawnSync(process.execPath, t.args, { cwd: join(root, t.cwd), encoding: 'utf8', env: { ...process.env, ...(t.env ?? {}) } });
const tail = (r) => `${r.stdout}${r.stderr}`.split('\n').slice(-14).join('\n');
let bad = 0;

for (const t of [T_RUNS, T_MODEL, BENCH]) {
  const r = run(t);
  console.log(`BASELINE ${t.cwd}/${t.args.at(-1)} rc=${r.status}`);
  if (r.status !== 0) {
    bad++;
    console.log(tail(r));
  } else if (t === BENCH) console.log(r.stdout.split('\n').filter((l) => l.startsWith('ci runs') || l.startsWith('-- ci')).join('\n'));
}

for (const m of mutants) {
  const path = join(root, m.file);
  const original = readFileSync(path, 'utf8');
  const at = original.indexOf(m.from);
  if (at < 0) {
    console.log(`NOT APPLIED ${m.name}: the line to change was not found`);
    bad++;
    continue;
  }
  writeFileSync(path, original.slice(0, at) + m.to + original.slice(at + m.from.length));
  try {
    const r = run(m.test);
    if (r.status === 0) {
      console.log(`SURVIVED ${m.name}`);
      bad++;
    } else console.log(`KILLED   ${m.name} (rc=${r.status})`);
  } finally {
    writeFileSync(path, original);
  }
}

console.log(bad ? `FAILED: ${bad} problem(s)` : 'ALL GREEN: baseline passes, every mutant killed');
process.exit(bad ? 1 : 0);
