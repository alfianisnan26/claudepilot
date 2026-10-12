// Regenerates tools-playwright.json and tools-devtools.json: the tool lists of the pinned servers, which the
// gate answers `tools/list` from so a session start never starts a server (browser & desktop PRD §11.3).
// Run after changing package.json and its lockfile:  node apps/server/src/browser/pinned/regen.mjs
// `pinned.test.ts` (CLAUDEPILOT_PIN_TESTS=1) checks the committed files still match what the servers report.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'cpb-pin-'));
cpSync(join(here, 'package.json'), join(dir, 'package.json'));
cpSync(join(here, 'package-lock.json'), join(dir, 'package-lock.json'));
const ci = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8' });
if (ci.status !== 0) throw new Error(`npm ci failed: ${ci.stderr}`);

/** The servers and the arguments the pool starts them with, as far as the tool list depends on them. */
export const SERVERS = {
  playwright: { entry: 'node_modules/@playwright/mcp/cli.js', args: ['--cdp-endpoint', 'http://127.0.0.1:9', '--caps', 'vision'] },
  devtools: { entry: 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js', args: ['--browser-url', 'http://127.0.0.1:9', '--no-usage-statistics', '--no-performance-crux'] },
};

async function listTools({ entry, args }) {
  const child = spawn('node', [join(dir, entry), ...args], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        waiting.get(m.id)?.(m);
      } catch {
        // not a JSON line
      }
    }
  });
  const call = (id, method, params = {}) =>
    new Promise((resolve) => {
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'regen', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = (await call(2, 'tools/list')).result.tools;
  child.kill();
  return { serverInfo: init.result.serverInfo, tools };
}

try {
  for (const [name, spec] of Object.entries(SERVERS)) {
    const { serverInfo, tools } = await listTools(spec);
    writeFileSync(join(here, `tools-${name}.json`), `${JSON.stringify({ server: serverInfo, tools }, null, 1)}\n`);
    console.log(`${name}: ${tools.length} tools (${serverInfo.name} ${serverInfo.version})`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
