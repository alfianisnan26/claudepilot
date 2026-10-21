// The web smoke: VS Code for the Web (@vscode/test-web, the stable build) in headless Chromium, the extension under development, and a
// FAKE portal (test/fake-portal.mjs) on 127.0.0.1. No real portal and no real credential anywhere. One heavy process: run it alone.
//   node scripts/test-web.mjs            uses /usr/bin/chromium (CHROMIUM=<path> for another), ports 3358 (VS Code) and 3359 (fake)
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { startFakePortal } from '../test/fake-portal.mjs';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const chromium = process.env.CHROMIUM ?? '/usr/bin/chromium';

const fake = await startFakePortal({ port: Number(process.env.FAKE_PORT ?? 3359), interval: 1, autoApproveAfter: 2 });
console.log(`fake portal on ${fake.url}`);
try {
  await build({ entryPoints: [join(root, 'src/extension.ts')], bundle: true, outfile: join(root, 'dist/extension.js'), format: 'cjs', platform: 'neutral', mainFields: ['module', 'main'], target: 'es2022', external: ['vscode'] });
  await build({
    entryPoints: [join(root, 'test/web/smoke.ts')],
    bundle: true,
    outfile: join(root, 'dist/test/smoke.js'),
    format: 'cjs',
    platform: 'neutral',
    target: 'es2022',
    external: ['vscode'],
    define: { FAKE_PORTAL_URL: JSON.stringify(fake.url) },
  });
  // @vscode/test-web launches Playwright's own Chromium; this machine has one already, so the launch is pointed at it.
  const pw = require(require.resolve('playwright', { paths: [require.resolve('@vscode/test-web')] }));
  const launch = pw.chromium.launch.bind(pw.chromium);
  pw.chromium.launch = (o = {}) => launch({ ...o, executablePath: chromium, args: [...(o.args ?? []), '--no-sandbox', '--disable-dev-shm-usage'] });
  const { runTests } = require('@vscode/test-web');
  const started = Date.now();
  await runTests({
    browserType: 'chromium',
    headless: true,
    quality: 'stable',
    port: Number(process.env.WEB_PORT ?? 3358),
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'dist/test/smoke.js'),
    testRunnerDataDir: join(root, '.vscode-test-web'),
  });
  console.log(`web smoke PASSED in ${Math.round((Date.now() - started) / 1000)} s; fake portal saw ${fake.state.calls.length} calls, ${fake.state.calls.filter((c) => c.cookie).length} with a cookie`);
} catch (e) {
  console.error(`web smoke FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await fake.close();
}
