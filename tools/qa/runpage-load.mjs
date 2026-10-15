// T-576 follow-up: can the run page of a seeded run with a long runner name come up blank at 2.5 s? Loads it many times at 390 and 1280 px (the same
// order as runner-run.mjs: runs list, then the run pages), polls every 50 ms for the first text, and records console errors, failed requests and the
// API timing of /api/ci/runs/<id> from the page's own performance entries.
// usage: tools/qa/with-portal.sh 3490 node tools/qa/runpage-load.mjs
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { api, login, sleep } from './lib.mjs';

const N = Number(process.env.LOADS ?? 15);
const cookie = await login();
const call = api(cookie);
await call('POST', '/api/workspaces/local/local/start');
const db = new DatabaseSync(`/tmp/scratch-portal-${process.env.QA_PORT}/data/portal.db`);
const WS = 'local/local';
const now = new Date().toISOString();
db.prepare(`INSERT OR IGNORE INTO ci_repos (id, workspace_id, name, path, default_branch, created_at) VALUES ('repo-qa', ?, 'app', '/tmp/app', 'main', ?)`).run(WS, now);
const ins = db.prepare(`INSERT INTO ci_runs (id, number, workspace_id, repo_id, repo, pipeline, trigger, ref, branch, sha, subject, status, actor, created_at, started_at, finished_at, duration_ms, runs_on, runner_workspace_id)
  VALUES (?, ?, ?, 'repo-qa', 'app', ?, 'push', 'refs/heads/main', 'main', ?, ?, ?, 'owner', ?, ?, ?, 41000, ?, ?)`);
const long = 'kubernetes/' + 'build-box-with-a-very-long-runner-name-0123456789-abcdefghijklmnopqrstuvwxyz';
ins.run('run-qa-1', 1, WS, 'deploy-gate-pipeline', 'a'.repeat(40), 'A subject that is quite long to see wrapping on a phone screen, with a-very-long-unbroken-token-' + 'x'.repeat(60), 'passed', now, now, now, JSON.stringify(['gpu', 'linux', 'a-long-label-of-forty-characters-0123456']), long);
ins.run('run-qa-2', 2, WS, 'ci', 'b'.repeat(40), 'Plain run on the repo workspace', 'failed', now, now, now, null, null);
ins.run('run-qa-3', 3, WS, 'ci', 'c'.repeat(40), 'Short runner', 'passed', now, now, now, JSON.stringify(['gpu']), 'kubernetes/build-box');
db.close();

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
const rows = [];
try {
  for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
    for (let i = 0; i < N; i++) {
      const dark = i % 2 === 1;
      await b.setViewport(w, h, mobile);
      await b.media({ dark });
      await b.goto('/admin/ci?tab=runs', 1500);
      for (const id of ['run-qa-1', 'run-qa-3', 'run-qa-2']) {
        const e0 = b.errors.length, c0 = b.console.length, f0 = b.failed.length;
        const t0 = Date.now();
        await b.send('Page.navigate', { url: `${b.o.port ? '' : ''}${(await import('./lib.mjs')).BASE}/admin/ci/runs/${id}` });
        let first = null;
        let skeletonAt2500 = null;
        for (let t = 0; t < 15000; t += 50) {
          await sleep(50);
          let txt = '';
          try { txt = await b.eval(`(document.querySelector('main') ?? document.body)?.innerText ?? ''`); } catch { /* navigating */ }
          if (/Passed|Failed/.test(txt)) { first = Date.now() - t0; break; }
          if (Date.now() - t0 >= 2500 && skeletonAt2500 === null) skeletonAt2500 = { text: txt.slice(0, 80), skeleton: await b.eval(`!!document.querySelector('.skeleton')`).catch(() => null), bodyLen: await b.eval(`document.body.innerText.length`).catch(() => null) };
        }
        const perf = await b.eval(`JSON.stringify(performance.getEntriesByType('resource').filter((e) => /\\/api\\/(ci|workspaces)/.test(e.name)).map((e) => ({ u: e.name.replace(location.origin, '').slice(0, 60), start: Math.round(e.startTime), dur: Math.round(e.duration), status: e.responseStatus })))`).catch(() => '[]');
        const row = { w, i, dark, id, firstTextMs: first, at2500: skeletonAt2500, errors: b.errors.slice(e0).map((x) => String(x).slice(0, 200)), console: b.console.slice(c0).filter((c) => c.type !== 'log').map((c) => `${c.type}:${c.text}`.slice(0, 200)), failed: b.failed.slice(f0), api: JSON.parse(perf) };
        rows.push(row);
        if (first === null || first > 2000 || row.errors.length || row.failed.length || row.console.length) console.log('ODD', JSON.stringify(row));
      }
    }
  }
} finally {
  await b.close?.();
}
for (const id of ['run-qa-1', 'run-qa-2', 'run-qa-3']) for (const w of [390, 1280]) {
  const xs = rows.filter((r) => r.id === id && r.w === w).map((r) => r.firstTextMs).filter((x) => x !== null).sort((a, c) => a - c);
  const never = rows.filter((r) => r.id === id && r.w === w && r.firstTextMs === null).length;
  console.log(`SUMMARY ${id} ${w}px loads=${xs.length + never} never=${never} first-text ms min=${xs[0]} median=${xs[xs.length >> 1]} max=${xs.at(-1)}`);
}
const all = rows.map((r) => r.firstTextMs).filter((x) => x !== null);
console.log(`SUMMARY total loads=${rows.length} over2500=${all.filter((x) => x > 2500).length} never=${rows.filter((r) => r.firstTextMs === null).length} errors=${rows.filter((r) => r.errors.length).length} failedReq=${rows.filter((r) => r.failed.length).length} console=${rows.filter((r) => r.console.length).length}`);
process.exit(0);
