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
db.close();

const sizes = `(() => {
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
  const filters = [...document.querySelectorAll('main button, main a')].filter((e) => /^(all runs|running|failed|passed)$/i.test((e.getAttribute('aria-label') || e.innerText || '').trim()));
  return { filters: filters.map((e) => ({ t: e.getAttribute('aria-label') || e.innerText, ...box(e) })), back: box(document.querySelector('a[aria-label=CI]')) };
})()`;

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
try {
  await b.cookie(cookie);
  for (const [w, h, mobile, min] of [[390, 844, true, 44], [1280, 900, false, 40]]) {
    await b.setViewport(w, h, mobile);
    await b.goto('/admin/ci', 2500);
    const runs = await b.eval(sizes);
    console.log(`  ${w}px runs tab: ${JSON.stringify(runs.filters)}`);
    check(`${w}: four filter buttons, each >= ${min} px`, runs.filters.length === 4 && runs.filters.every((f) => f.w >= min - 0.5 && f.h >= min - 0.5));
    await b.goto(`/admin/ci/runs/${runId}`, 2500);
    const page = await b.eval(sizes);
    console.log(`  ${w}px run page back link: ${JSON.stringify(page.back)}`);
    check(`${w}: CI back link >= ${min} px`, !!page.back && page.back.w >= min - 0.5 && page.back.h >= min - 0.5);
  }
} finally {
  await b.close();
}
process.exit(failed ? 1 : 0);
