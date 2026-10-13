// The integration fast lane (T-36): which checks a set of changed paths needs before integration is pushed. Typecheck always (unless only
// docs changed), the web build and web tests when web code changed, and the server tests of the touched areas only; anything the whole
// server leans on (contracts, migrations, authz, the platform, settings, the app's own files, the lockfile) runs the whole suite. The full
// gate (scripts/gate.sh) still runs before every deploy and every two hours on integration's head.
//   node --import tsx apps/server/src/qa/gateQuick.ts < paths      prints the plan as JSON (scripts/gate-quick.sh reads it)

export interface QuickPlan {
  /** Nothing but documents changed: no check is needed. */
  docsOnly: boolean;
  typecheck: boolean;
  /** The whole server suite (something everything depends on changed). */
  serverAll: boolean;
  /** Test globs relative to apps/server, when not the whole suite. */
  serverTests: string[];
  web: boolean;
}

/** Server paths every area depends on: a change there runs the whole suite. */
const CORE = [
  /^packages\/contracts\//,
  /^apps\/server\/src\/store\//,
  /^apps\/server\/src\/authz\//,
  /^apps\/server\/src\/platform\//,
  /^apps\/server\/src\/settings\//,
  /^apps\/server\/src\/[^/]+\.ts$/, // app.ts, index.ts, config.ts, portal.ts, ...
  /^apps\/server\/scripts\//,
  /^apps\/server\/package\.json$/,
  /^package(-lock)?\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^apps\/server\/tsconfig[^/]*\.json$/,
];

const DOC = (p: string) => p.startsWith('docs/') || (/\.md$/.test(p) && !p.startsWith('apps/') && !p.startsWith('packages/')) || p.startsWith('.claude/');

export function quickPlan(paths: readonly string[]): QuickPlan {
  const files = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  const plan: QuickPlan = { docsOnly: false, typecheck: true, serverAll: false, serverTests: [], web: false };
  if (!files.length || files.every(DOC)) return { ...plan, docsOnly: true, typecheck: false };
  const tests = new Set<string>();
  for (const p of files) {
    if (DOC(p)) continue;
    if (CORE.some((r) => r.test(p))) plan.serverAll = true;
    if (p.startsWith('packages/contracts/')) plan.web = true;
    if (p.startsWith('apps/web/') || p === 'package-lock.json') plan.web = true;
    const area = /^apps\/server\/src\/([^/]+)\//.exec(p);
    if (area) tests.add(`src/${area[1]}/**/*.test.ts`);
    // The pipelines, their scripts and the cluster manifests are tested by the CI area (deployPipeline.test.ts runs the real scripts and
    // shellcheck); the dev scripts by the qa area.
    if (p.startsWith('.pilot/') || p.startsWith('deploy/')) tests.add('src/ci/**/*.test.ts');
    if (p.startsWith('scripts/')) {
      tests.add('src/ci/**/*.test.ts');
      tests.add('src/qa/**/*.test.ts');
    }
    // The workspace image ships the chat host and the CI runner: their tests compare the copies.
    if (p.startsWith('images/workspace/')) {
      tests.add('src/chat/**/*.test.ts');
      tests.add('src/ci/**/*.test.ts');
    }
  }
  plan.serverTests = plan.serverAll ? [] : [...tests].sort();
  return plan;
}

// The CLI: changed paths on stdin, one per line; the plan on stdout.
if (import.meta.url === `file://${process.argv[1]}`) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => process.stdout.write(`${JSON.stringify(quickPlan(input.split('\n')))}\n`));
}
