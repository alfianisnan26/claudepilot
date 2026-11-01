// The web app's first load (owner request 2026-11-01, performance): what the browser must fetch before Home can draw, and how long Home
// takes in a real browser.
//   node tools/qa/perf-web.mjs [--dist apps/web/dist] [--json]                    the built app's initial scripts and styles (raw and gzip), chunks
//   QA_PORT=3406 QA_CODE=24681372 node tools/qa/perf-web.mjs --browser [--runs 5] [--cpu 4] [--net 4g] [--width 1280]
//       also opens Home in a fresh Chromium per run (cold cache) against a portal serving the BUILT app (scripts/scratch-portal.sh with
//       SCRATCH_PRODUCTION=1), with the CPU slowed --cpu times (default 4, a phone), and reports the medians of first contentful paint, the
//       first Home card drawn, and the script bytes fetched by then.
// --budget-kb N: exit 1 when the initial scripts are over N KB gzip.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : dflt);
const flag = (name) => args.includes(`--${name}`);
const dist = resolve(root, opt('dist', 'apps/web/dist'));
const kb = (n) => Math.round(n / 102.4) / 10;

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const sizes = (files) =>
  files.reduce(
    (a, f) => {
      const body = readFileSync(join(dist, f));
      return { raw: a.raw + body.length, gzip: a.gzip + gzipSync(body).length };
    },
    { raw: 0, gzip: 0 },
  );
const js = sizes(initial.filter((f) => f.endsWith('.js')));
const css = sizes(initial.filter((f) => f.endsWith('.css')));
const all = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js'));
const main = initial.find((f) => /assets\/main-[^/]+\.js$/.test(f));
const report = {
  initialScripts: initial.filter((f) => f.endsWith('.js')).length,
  initialJsKb: kb(js.raw),
  initialJsGzipKb: kb(js.gzip),
  initialCssGzipKb: kb(css.gzip),
  mainKb: main ? kb(statSync(join(dist, main)).size) : null,
  mainGzipKb: main ? kb(gzipSync(readFileSync(join(dist, main))).length) : null,
  chunks: all.length,
  allJsKb: kb(all.reduce((n, f) => n + statSync(join(dist, 'assets', f)).size, 0)),
};

if (flag('browser')) {
  const { Browser } = await import('./browser.mjs');
  const { login, sleep } = await import('./lib.mjs');
  const cookie = await login();
  const runs = Number(opt('runs', '5'));
  const cpu = Number(opt('cpu', '4'));
  const width = Number(opt('width', '1280'));
  const net = opt('net', 'none');
  const fcp = [];
  const home = [];
  const jsKb = [];
  for (let i = 0; i < runs; i++) {
    const b = await Browser.launch({ width, height: 800 });
    try {
      await b.cookie(cookie);
      await b.send('Network.setCacheDisabled', { cacheDisabled: true });
      if (cpu > 1) await b.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      // --net 4g: a phone on a mobile network (100 ms round trip, 9 Mbit/s down, 2 up).
      if (net === '4g')
        await b.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 100,
          downloadThroughput: 1_125_000,
          uploadThroughput: 250_000,
        });
      await b.goto('/admin/home', 0);
      await b.waitFor(`document.querySelectorAll('[data-home-card]').length > 0`, 60_000, 'a Home card');
      const t = await b.eval(`(() => {
        const paint = performance.getEntriesByName('first-contentful-paint')[0];
        const js = performance.getEntriesByType('resource').filter((r) => r.name.endsWith('.js')).reduce((n, r) => n + (r.encodedBodySize || 0), 0);
        return { fcp: paint ? Math.round(paint.startTime) : null, home: Math.round(performance.now()), js };
      })()`);
      fcp.push(t.fcp);
      home.push(t.home);
      jsKb.push(kb(t.js));
      console.error(`run ${i + 1}: FCP ${t.fcp} ms, first Home card ${t.home} ms, scripts ${kb(t.js)} KB (encoded) by then`);
      await sleep(200);
    } finally {
      await b.close();
    }
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  Object.assign(report, {
    browser: { width, cpu, net, runs, fcpMs: med(fcp), homeCardMs: med(home), scriptsKbByHome: med(jsKb), fcpRuns: fcp, homeRuns: home },
  });
}

if (flag('json')) console.log(JSON.stringify(report));
else console.log(JSON.stringify(report, null, 2));
const budget = Number(opt('budget-kb', '0'));
process.exit(budget && report.initialJsGzipKb > budget ? 1 : 0);
