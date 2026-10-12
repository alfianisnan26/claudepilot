// Builds cp-ci from src/ci/runner/main.ts into the single script that runs in workspaces. Used by `npm run gen:ci-runner`
// and by tests; the portal itself never imports this (it carries the generated text, runner.generated.ts, instead).
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../../', import.meta.url));

/** The runner as one CommonJS file with a Node shebang (a script with no extension and no package.json is CommonJS). No dependencies, not minified: root-owned and meant to be read. */
export function buildRunner(): string {
  const result = buildSync({
    entryPoints: [fileURLToPath(new URL('./main.ts', import.meta.url))],
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
