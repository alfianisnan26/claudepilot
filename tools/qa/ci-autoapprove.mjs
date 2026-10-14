// The auto-approve rule's dry run (T-110, local-git-ci PRD FR41a) in a real browser: the Dry control on a protected environment (CI ->
// Remotes -> a remote's environments) and the rule's one line on the run page, at 390 px and 1280 px, light and dark. Checks: no horizontal
// scroll, the Dry control is 44 px and toggles the rule through the API (off -> dry -> off), the line is on the run page, the run still asks
// a person (Approve and Reject are there), no page errors. A real remote is made on "This machine" from a small git folder; the waiting run
// and its deployment with the rule's verdict are seeded straight into the scratch portal's database (nothing deploys):
//   PORTAL_LOCAL_ENABLED=true scripts/scratch-portal.sh start 3431
//   QA_PORT=3431 QA_CODE=24681372 QA_SHOTS=~/.claudepilot/dev-sessions/shots/t110 node tools/qa/ci-autoapprove.mjs
//   scripts/scratch-portal.sh stop 3431
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Browser, SHOTS } from './browser.mjs';
import { api, login, PORT, sleep } from './lib.mjs';

const results = [];
const check = (cfg, name, ok, detail = '') => {
  results.push({ cfg, name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${cfg} / ${name}${ok ? '' : ` ${detail}`}`);
};

const cookie = await login();
const call = api(cookie);
await call('POST', '/api/workspaces/local/local/start');

// A git folder in the scratch portal's own home, which "This machine" uses.
const src = `/tmp/scratch-portal-${PORT}/home/work/qa-app`;
mkdirSync(src, { recursive: true });
writeFileSync(`${src}/README.md`, '# qa app\n');
const git = (...args) => execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.com', ...args], { cwd: src });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-q', '-m', 'first');
const sha = git('rev-parse', 'HEAD').toString().trim();
const repo = await call('POST', '/api/ci/repos', { workspaceId: 'local/local', name: 'qa-app', source: src });
if (repo.status >= 300) throw new Error(`remote: ${repo.status} ${repo.text.slice(0, 200)}`);
const repoId = repo.data.id;

// A protected environment with the rule off, and a run whose release waits, with the rule's (dry) line on its deployment.
const db = new DatabaseSync(`/tmp/scratch-portal-${PORT}/data/portal.db`, { timeout: 10_000 });
const now = new Date().toISOString();
const runId = `rqa${randomUUID().slice(0, 8)}`;
const step = (status) => ({ idx: 0, name: 'Do it', status, startedAt: now, durationMs: status === 'passed' ? 1200 : null, exitCode: status === 'passed' ? 0 : null, logBytes: 0, logTruncated: false, ignored: false, reason: null });
const job = (id, status, needs, environment = null) => ({ id, name: id[0].toUpperCase() + id.slice(1), status, needs, startedAt: now, durationMs: null, ignored: false, reason: null, steps: [step(status)], artifacts: [], artifactsSkipped: 0, environment });
const jobs = [job('gate', 'passed', []), job('build', 'passed', ['gate']), job('release', 'waiting', ['build'], 'production'), job('verify', 'pending', ['release']), job('rollback', 'pending', ['release', 'verify'])];
const state = { v: 1, runId, status: 'running', reason: null, startedAt: now, finishedAt: null, durationMs: null, jobs };
db.prepare("INSERT INTO ci_environments (id, repo_id, name, protected, created_at, updated_at, updated_by) VALUES (?, ?, 'production', 1, ?, ?, 'system')").run(`eqa${randomUUID().slice(0, 8)}`, repoId, now, now);
db.prepare(
  `INSERT INTO ci_runs (id, number, workspace_id, repo_id, repo, pipeline, trigger, ref, branch, sha, subject, status, actor, state, created_at, started_at)
   VALUES (?, 19, 'local/local', ?, 'qa-app', 'deploy', 'manual', 'refs/heads/main', 'main', ?, 'Deploy the portal', 'running', 'ui', ?, ?, ?)`,
).run(runId, repoId, sha, JSON.stringify(state), now, now);
const line = `auto-approve (dry): WOULD approve: gate green at ${sha.slice(0, 7)}, build ok, verify and rollback present, no authz/secrets/Bypass/deny-rule/released-migration change in the diff, 2 of 6 today`;
db.prepare(
  `INSERT INTO ci_deployments (id, run_id, run_number, job, repo_id, environment, pipeline, sha, ref, actor, approval, created_at, auto_verdict, auto_line, auto_at)
   VALUES (?, ?, 19, 'release', ?, 'production', 'deploy', ?, 'refs/heads/main', 'ui', 'waiting', ?, 'would', ?, ?)`,
).run(`dqa${randomUUID().slice(0, 8)}`, runId, repoId, sha, now, line, now);
db.close();

const env = async () => (await call('GET', `/api/ci/repos/${repoId}/environments`)).data?.[0];
check('api', 'the rule starts off', (await env())?.autoApprove === 'off');
const on = await call('PUT', `/api/ci/repos/${repoId}/environments/production/auto-approve`, { mode: 'on' });
check('api', 'on does not exist yet (422)', on.status === 422, String(on.status));

const MATRIX = [
  { name: 'phone-390-light', width: 390, height: 844, mobile: true },
  { name: 'phone-390-dark', width: 390, height: 844, mobile: true, dark: true },
  { name: 'desktop-1280-light', width: 1280, height: 800 },
  { name: 'desktop-1280-dark', width: 1280, height: 800, dark: true },
];
const DRY = 'button[aria-label="Auto-approve dry run for production"]';

for (const cfg of MATRIX) {
  const b = await Browser.launch({ width: cfg.width, height: cfg.height, mobile: !!cfg.mobile, dark: !!cfg.dark });
  const seen = (expr, ms = 8000) => b.waitFor(expr, ms).then(() => true, () => false);
  try {
    await b.cookie(cookie);
    await b.goto('/admin/ci?tab=remotes', 2500);
    if (!(await seen(`[...document.querySelectorAll('button[aria-expanded]')].some((x) => x.innerText.includes('qa-app'))`, 30000))) await b.clickText('Remotes');
    await seen(`[...document.querySelectorAll('button[aria-expanded]')].some((x) => x.innerText.includes('qa-app'))`, 15000);
    const expanded = await b.eval(`(() => { const x = [...document.querySelectorAll('button[aria-expanded]')].find((x) => x.innerText.includes('qa-app')); if (x && x.getAttribute('aria-expanded') !== 'true') x.click(); return !!x; })()`);
    check(cfg.name, 'the remote is listed', expanded);
    check(cfg.name, 'the Dry control is there', await seen(`!!document.querySelector('${DRY}')`, 15000));
    const box = await b.eval(`(() => { const r = document.querySelector('${DRY}').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), text: document.querySelector('${DRY}').innerText.trim(), pressed: document.querySelector('${DRY}').getAttribute('aria-pressed') }; })()`);
    check(cfg.name, 'Dry is one word, 44 px', box.text === 'Dry' && box.h >= 44 && box.w >= 44, JSON.stringify(box));
    check(cfg.name, 'remotes: no horizontal scroll', await b.eval(`document.scrollingElement.scrollWidth <= innerWidth + 1`));
    await b.shot(`${cfg.name}-1-environments-off`);
    await b.clickSel(DRY);
    check(cfg.name, 'a tap turns the dry run on', await seen(`document.querySelector('${DRY}')?.getAttribute('aria-pressed') === 'true'`));
    check(cfg.name, 'the API says dry', (await env())?.autoApprove === 'dry');
    await sleep(300);
    await b.shot(`${cfg.name}-2-environments-dry`);
    await b.clickSel(DRY);
    check(cfg.name, 'a second tap turns it off', await seen(`document.querySelector('${DRY}')?.getAttribute('aria-pressed') === 'false'`));
    check(cfg.name, 'the API says off', (await env())?.autoApprove === 'off');

    await b.goto(`/admin/ci/runs/${runId}`, 2500);
    check(cfg.name, 'the run page shows the rule’s line', await seen(`document.body.innerText.includes('auto-approve (dry): WOULD approve')`, 20000));
    check(cfg.name, 'a person still decides (Approve and Reject)', await b.eval(`['Approve', 'Reject'].every((t) => [...document.querySelectorAll('button')].some((x) => x.innerText.trim() === t))`));
    check(cfg.name, 'run: no horizontal scroll', await b.eval(`document.scrollingElement.scrollWidth <= innerWidth + 1`));
    await b.shot(`${cfg.name}-3-run`, { full: true });
    check(cfg.name, 'no page errors', (b.errors ?? []).length === 0, (b.errors ?? []).join(' | ').slice(0, 300));
  } catch (e) {
    check(cfg.name, 'scenario ran', false, String(e.message ?? e).slice(0, 300));
    await b.shot(`${cfg.name}-x-error`).catch(() => undefined);
  } finally {
    await b.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed; shots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
