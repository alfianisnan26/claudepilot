// T-772: with `forced-colors: active` the browser drops box-shadows, so a control whose only focus indicator is a ring
// (`focus-visible:ring-*`) must keep a real outline (Tailwind v4 `outline-hidden`, not `outline-none`). This check emulates
// forced-colors, Tabs through the CI pages (Runs tab, Remotes tab, Runners tab, a run page) and asserts that every focused element
// has an outline (outline-style not none and outline-width > 0). At 390 and 1280 px, light and dark.
// Seeds straight into the scratch portal's database, as ci-sweep.mjs does.
// usage: scripts/job-run.sh --ref <commit> --out job-out/t772 -- 'tools/qa/with-portal.sh 3482 node tools/qa/ci-forced-colors.mjs; exit $?'
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${String(extra).slice(0, 700)}` : ''}`);
  if (!ok) failed++;
};

const cookie = await login();
const db = new DatabaseSync(`/tmp/scratch-portal-${PORT}/data/portal.db`, { timeout: 10_000 });
const now = new Date().toISOString();
const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
const insRepo = db.prepare("INSERT INTO ci_repos (id, workspace_id, name, path, default_branch, created_at) VALUES (?, 'local/local', ?, ?, 'main', ?)");
const repoId = `pfa${randomUUID().slice(0, 8)}`;
insRepo.run(repoId, 'app', '/home/node/.pilot/app.git', now);
insRepo.run(`pfb${randomUUID().slice(0, 8)}`, 'lib', '/home/node/.pilot/lib.git', now); // a second remote: the Runs tab then shows its Remote select
const insRun = db.prepare(
  `INSERT INTO ci_runs (id, number, workspace_id, repo_id, repo, pipeline, trigger, ref, branch, sha, subject, status, reason, actor, created_at, started_at, finished_at, duration_ms, archived, state, diagnostics)
   VALUES (?, ?, 'local/local', ?, 'app', ?, 'push', ?, ?, ?, ?, ?, ?, 'push', ?, ?, ?, ?, 1, ?, ?)`,
);
const step = (idx, name, status) => ({ idx, name, status, startedAt: ago(5), durationMs: 1500, exitCode: status === 'failed' ? 1 : 0, logBytes: 100, logTruncated: false, ignored: false, reason: status === 'failed' ? 'step_failed' : null });
const job = (id, name, status, needs, steps) => ({ id, name, status, needs, startedAt: ago(5), durationMs: 9000, ignored: false, reason: status === 'failed' ? 'step_failed' : null, steps, artifacts: [], artifactsSkipped: 0 });
const jobs = [job('build', 'Build', 'passed', [], [step(0, 'Install', 'passed'), step(1, 'Typecheck', 'passed')]), job('test', 'Test', 'failed', ['build'], [step(0, 'Unit tests', 'failed')])];
const state = { v: 1, runId: 'run-fc', status: 'failed', reason: 'step_failed', startedAt: ago(5), finishedAt: now, durationMs: 41000, jobs };
insRun.run('run-fc', 200, repoId, 'ci', 'refs/heads/work/x', 'work/x', 'a'.repeat(40), 'A run for the focus check', 'failed', 'step_failed', ago(6), ago(5), now, 41000, JSON.stringify(state), null);
insRun.run('run-fc2', 201, repoId, 'ci', 'refs/heads/main', 'main', 'b'.repeat(40), 'A passed run', 'passed', null, ago(4), ago(4), ago(3), 30000, null, null);

const STOP = `(() => {
  const a = document.activeElement; if (!a || a === document.body) return null;
  const s = getComputedStyle(a); const r = a.getBoundingClientRect();
  const name = (a.getAttribute('aria-label') || a.innerText || a.getAttribute('placeholder') || a.value || a.tagName).toString().replace(/\\s+/g, ' ').trim().slice(0, 28);
  return { tag: a.tagName.toLowerCase(), name, style: s.outlineStyle, width: parseFloat(s.outlineWidth) || 0, visible: r.width > 0 && r.height > 0 };
})()`;

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
try {
  await b.cookie(cookie);
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  const pages = ['/admin/ci?tab=runs', '/admin/ci?tab=remotes', '/admin/ci?tab=runners', '/admin/ci/runs/run-fc'];
  for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
    for (const dark of [false, true]) {
      const tag = `${w}-${dark ? 'dark' : 'light'}`;
      await b.setViewport(w, h, mobile);
      await b.media({ dark });
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'forced-colors', value: 'active' }] });
      for (const path of pages) {
        await b.goto(path, 2200);
        await b.waitFor(`document.querySelectorAll('main button, main a, main select').length > 3`, 15_000, path).catch((e) => console.log(`  warn ${e.message}`));
        await sleep(500);
        check(`${tag} ${path}: forced-colors is active`, await b.eval(`matchMedia('(forced-colors: active)').matches`));
        await b.eval('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
        const stops = [];
        for (let i = 0; i < 40; i++) {
          await b.key('Tab');
          const s = await b.eval(STOP);
          if (!s) break;
          if (stops.some((x) => x.tag === s.tag && x.name === s.name) && i > 3) break; // wrapped around
          stops.push(s);
        }
        check(`${tag} ${path}: Tab reaches controls`, stops.length > 0, `${stops.length} stops`);
        const bad = stops.filter((s) => s.visible && (s.style === 'none' || s.width <= 0));
        check(`${tag} ${path}: every focused control has an outline`, bad.length === 0, JSON.stringify(bad.map((s) => `${s.tag}:${s.name}`).slice(0, 8)));
      }
    }
  }
} finally {
  await b.close();
  db.close();
}
await sleep(100);
console.log(failed ? `FAILED ${failed}` : 'ALL OK');
process.exit(failed ? 1 : 0);
