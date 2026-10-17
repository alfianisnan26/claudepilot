// Proof for T-382 S5 (QA 9691): run the new tests as they are, then once per mutant with one line of production code changed; every mutant must
// make its test fail ("KILLED"). The file is restored after each one. Run from the repo root inside a cluster Job (job-run), never in the pod.
// Exit 0 only when the baseline is green and no mutant survives.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const web = (file) => ({ cwd: 'apps/web', args: ['--import', 'tsx', '--disable-warning=ExperimentalWarning', '--test', file] });
const server = (file) => ({ cwd: 'apps/server', args: ['--import', 'tsx', '--test', file] });

const CHAT = 'apps/web/src/features/chat/useChatSocket.ts';
const RUNS = 'apps/web/src/features/ci/RunsTab.tsx';
const CI_STORE = 'apps/server/src/ci/store.ts';
const CHAT_STORE = 'apps/server/src/chat/store.ts';
const LAB_ROUTES = 'apps/server/src/lab/routes.ts';

const T_LIST = web('src/features/chat/useChatList.test.ts');
const T_RUNS = web('src/features/ci/runsTabWiring.test.ts');
const T_CI = server('src/ci/runsPage.test.ts');
const T_AUDIT = server('src/chat/auditPage.test.ts');
const T_SLICES = server('src/lab/slicesPage.test.ts');

/** `last`: change the last occurrence (the audit scan is the second one in chat/store.ts). */
const mutants = [
  {
    name: 'a  failMore restart -> reload removed',
    file: CHAT,
    from: "=== 'restart') await reload();",
    to: "=== 'restart') void 0;",
    test: T_LIST,
  },
  {
    name: 'b  poll applyHead(page) -> head = page',
    file: CHAT,
    from: '            pager.current.applyHead(page);',
    to: '            pager.current.head = page;',
    test: T_LIST,
  },
  {
    name: 'c  reload: pager.restart() removed',
    file: CHAT,
    from: '      pager.current.restart();\n      pager.current.applyHead(page);',
    to: '      pager.current.applyHead(page);',
    test: T_LIST,
  },
  {
    name: 'd  RunsTab applyHead(list) -> head = list',
    file: RUNS,
    from: 'pager.current.applyHead(list);',
    to: 'pager.current.head = list;',
    test: T_RUNS,
  },
  {
    name: 'e  ci runs: maxScan = limit * 1000',
    file: CI_STORE,
    from: 'const maxScan = limit * SCAN_FACTOR;',
    to: 'const maxScan = limit * 1000;',
    test: T_CI,
  },
  { name: 'f  ci runs: resume = null', file: CI_STORE, from: 'resume = got.next;', to: 'resume = null;', test: T_CI },
  {
    name: 'g  chat audit: maxScan = limit * 1000',
    file: CHAT_STORE,
    from: 'const maxScan = limit * SCAN_FACTOR;',
    to: 'const maxScan = limit * 1000;',
    last: true,
    test: T_AUDIT,
  },
  { name: 'h  chat audit: resume = null', file: CHAT_STORE, from: 'resume = got.next;', to: 'resume = null;', last: true, test: T_AUDIT },
  {
    name: 'i  lab slices: caller dropped from the cursor scope',
    file: LAB_ROUTES,
    from: '[actorString(actorOf(c)), session',
    to: '["", session',
    test: T_SLICES,
  },
];

const run = (t) => spawnSync(process.execPath, t.args, { cwd: join(root, t.cwd), encoding: 'utf8' });
const tail = (r) => `${r.stdout}${r.stderr}`.split('\n').slice(-14).join('\n');
let bad = 0;

for (const t of [T_LIST, T_RUNS, T_CI, T_AUDIT, T_SLICES]) {
  const r = run(t);
  console.log(`BASELINE ${t.cwd}/${t.args.at(-1)} rc=${r.status}`);
  if (r.status !== 0) {
    bad++;
    console.log(tail(r));
  }
}

for (const m of mutants) {
  const path = join(root, m.file);
  const original = readFileSync(path, 'utf8');
  const at = m.last ? original.lastIndexOf(m.from) : original.indexOf(m.from);
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
