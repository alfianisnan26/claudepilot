// A node:test reporter for the gate's server suite (T-2890): per test file, the top-level tests it REGISTERED (test:enqueue) against the
// top-level tests it REPORTED (test:pass or test:fail, a skip or a todo included). A file whose report stops part way exits 0 and node's own
// summary just counts fewer tests (lab/scorecard.test.ts lost up to 17 of 34 under load with --test-force-exit), so the gate looked green.
// Output, one line each: `short <file> registered=<n> reported=<m>` for every file that reported fewer than it registered, then
// `total files=<f> registered=<n> reported=<m>`. scripts/gate.sh fails the server suite on any `short` line.
//   node --test --test-reporter=tap --test-reporter-destination=stdout \
//     --test-reporter=<repo>/scripts/test-count-reporter.mjs --test-reporter-destination=<file> ...
import { isAbsolute, relative, resolve } from 'node:path';

export default async function* testCountReporter(source) {
  /** @type {Map<string, { registered: number, reported: number }>} */
  const files = new Map();
  const of = (file) => {
    let f = files.get(file);
    if (!f) files.set(file, (f = { registered: 0, reported: 0 }));
    return f;
  };
  for await (const event of source) {
    const d = event.data;
    if (!d || d.nesting !== 0 || typeof d.file !== 'string') continue;
    // The runner's own entry for a whole file (named by its path) is not a test of that file.
    if (isAbsolute(d.file) && typeof d.name === 'string' && resolve(d.name) === d.file) continue;
    if (event.type === 'test:enqueue') of(d.file).registered++;
    else if (event.type === 'test:pass' || event.type === 'test:fail') of(d.file).reported++;
  }
  let registered = 0;
  let reported = 0;
  for (const [file, f] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    registered += f.registered;
    reported += f.reported;
    if (f.reported < f.registered) yield `short ${relative(process.cwd(), file)} registered=${f.registered} reported=${f.reported}\n`;
  }
  yield `total files=${files.size} registered=${registered} reported=${reported}\n`;
}
