// The slice check (T-293, design v2 layer 3 "CHECK"): which server test FILES a slice touched, so scripts/slice-check.sh runs the typecheck
// and only those files (no model, at most 20 lines out). Narrower than the integration fast lane (gateQuick.ts runs whole areas): a changed
// test file runs itself; a changed source file runs its sibling `<name>.test.ts`; a script or a dev-session script (scripts/<name>.sh,
// docs/dev-sessions/<name>.mjs) runs `src/qa/<camelName>.test.ts` or `src/ci/<camelName>.test.ts` when one exists. Anything the derivation
// misses is named on the command line (the fallback list); the quick gate and the full gate still run before integration and deploy.
//   node --import tsx apps/server/src/qa/sliceCheck.ts < paths      prints the test files, relative to apps/server, one per line

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SERVER = 'apps/server/';

/** `gate-quick` -> `gateQuick`. */
const camel = (s: string) => s.replace(/[-_.]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * The server test files (relative to apps/server, e.g. `src/qa/gateQuick.test.ts`) for a set of changed repository paths. `exists` tells
 * whether a repository path exists now (a deleted test file is not run). Sorted and without duplicates: the same input gives the same list.
 */
export function sliceTests(paths: readonly string[], exists: (repoPath: string) => boolean): string[] {
  const out = new Set<string>();
  const add = (repoPath: string) => {
    if (exists(repoPath)) out.add(repoPath.slice(SERVER.length));
  };
  for (const raw of paths) {
    const p = raw.trim();
    if (!p) continue;
    if (/^apps\/server\/src\/.+\.test\.ts$/.test(p)) add(p);
    else if (/^apps\/server\/src\/.+\.ts$/.test(p) && !p.endsWith('.d.ts')) add(p.replace(/\.ts$/, '.test.ts'));
    else {
      const script = /^(?:scripts|docs\/dev-sessions)\/([^/]+)\.(?:sh|mjs)$/.exec(p);
      if (script) for (const area of ['qa', 'ci']) add(`${SERVER}src/${area}/${camel(script[1]!)}.test.ts`);
    }
  }
  return [...out].sort();
}

// The CLI: changed paths on stdin, one per line (from the repository root); the test files on stdout.
if (import.meta.url === `file://${process.argv[1]}`) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    const files = sliceTests(input.split('\n'), (p) => existsSync(join(process.cwd(), p)));
    if (files.length) process.stdout.write(`${files.join('\n')}\n`);
  });
}
