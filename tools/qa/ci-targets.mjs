// T-681: CI touch targets. The Runs tab filter buttons (All runs / Running / Failed / Passed) and the run page's "CI" back link must be
// >= 44 px at 390 px and keep their 40 px box at 1280 px (no layout shift on desktop). A failed run is seeded into the scratch portal's db.
// usage: scripts/job-run.sh --ref <commit> --out job-out/t681 -- 'tools/qa/with-portal.sh 3481 node tools/qa/ci-targets.mjs; exit $?'
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT } from './lib.mjs';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!ok) failed++;
};

const cookie = await login();
const db = new DatabaseSync(`/tmp/scratch-portal-${PORT}/data/portal.db`, { timeout: 10_000 });
const now = new Date().toISOString();
const repoId = `pqa${randomUUID().slice(0, 8)}`;
const runId = `rqa${randomUUID().slice(0, 8)}`;
db.prepare("INSERT INTO ci_repos (id, workspace_id, name, path, default_branch, created_at) VALUES (?, 'local/local', 'app', '/home/node/.pilot/app.git', 'main', ?)").run(repoId, now);
db.prepare(
  `INSERT INTO ci_runs (id, number, workspace_id, repo_id, repo, pipeline, trigger, ref, branch, sha, subject, status, reason, actor, created_at, started_at, finished_at, duration_ms, archived)
   VALUES (?, 12, 'local/local', ?, 'app', 'ci', 'push', 'refs/heads/work/x', 'work/x', ?, 'Seeded run', 'failed', 'step_failed', 'push', ?, ?, ?, 4200, 0)`,
).run(runId, repoId, 'a'.repeat(40), now, now, now);
// A second remote, so the Runs tab shows its Remote select (T-732).
db.prepare("INSERT INTO ci_repos (id, workspace_id, name, path, default_branch, created_at) VALUES (?, 'local/local', 'lib', '/home/node/.pilot/lib.git', 'main', ?)").run(`pqb${randomUUID().slice(0, 8)}`, now);
db.close();

const sizes = `(() => {
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
  const filters = [...document.querySelectorAll('[role=group][aria-label=Show] button')];
  const back = [...document.querySelectorAll('a[aria-label=CI]')].find((e) => e.getBoundingClientRect().width > 0 && !e.closest('nav, aside, header'));
  return { select: box(document.querySelector('main select')), filters: filters.map((e) => ({ t: e.getAttribute('aria-label'), ...box(e) })), back: box(back), pathname: location.pathname };
})()`;

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
try {
  await b.cookie(cookie);
  for (const [w, h, mobile, min, selMin] of [[390, 844, true, 44, 44], [1280, 900, false, 40, 36]]) {
    // At 1280 px a box must also not grow: <= min + 0.5 (no layout shift on desktop).
    const fits = (e, m) => !!e && e.w >= m - 0.5 && e.h >= m - 0.5 && (mobile || (e.w <= m + 0.5 && e.h <= m + 0.5));
    await b.setViewport(w, h, mobile);
    await b.goto('/admin/ci', 2500);
    await b.waitFor(`document.querySelectorAll('[role=group][aria-label=Show] button').length === 4 && !!document.querySelector('main select')`, 15000, 'filter buttons and Remote select');
    const runs = await b.eval(sizes);
    console.log(`  ${w}px runs tab: ${JSON.stringify(runs.filters)}`);
    check(`${w}: four filter buttons, each >= ${min} px`, runs.filters.length === 4 && runs.filters.every((f) => fits(f, min)));
    check(`${w}: Remote select height is ${selMin} px`, !!runs.select && runs.select.h >= selMin - 0.5 && (mobile || runs.select.h <= selMin + 0.5), JSON.stringify(runs.select));
    await b.goto(`/admin/ci/runs/${runId}`, 2500);
    await b.waitFor(`!!document.querySelector('a[aria-label=CI]') && document.querySelector('h1')?.innerText.includes('#12')`, 15000, 'run page');
    const page = await b.eval(sizes);
    console.log(`  ${w}px run page back link: ${JSON.stringify(page.back)}`);
    check(`${w}: CI back link >= ${min} px`, fits(page.back, min));
  }
} finally {
  await b.close();
}
process.exit(failed ? 1 : 0);
