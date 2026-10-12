// Builds the stand-in provider into the single script a workspace container can run (providers PRD §6), the way ci/runner/build.ts builds
// cp-ci: one CommonJS file, Node's own modules only, not minified. Used by tests and by hand:
//   npx tsx src/mcp/builtin/testkit/build.ts /tmp/standin.cjs      (from apps/server)
//   node /tmp/standin.cjs --preset gitea --port 4601 --auth-port 4602 --control
import { buildSync } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER = fileURLToPath(new URL('../../../../', import.meta.url));

/** The standalone stand-in provider as the text of one script with a Node shebang. */
export function buildStandalone(): string {
  const result = buildSync({
    entryPoints: [fileURLToPath(new URL('./cli.ts', import.meta.url))],
    absWorkingDir: SERVER,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    write: false,
    legalComments: 'none',
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'silent',
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error('esbuild produced nothing');
  return out.text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: tsx build.ts <output file>\n');
    process.exit(2);
  }
  writeFileSync(file, buildStandalone(), { mode: 0o755 });
  process.stdout.write(`Wrote ${file}\n`);
}
