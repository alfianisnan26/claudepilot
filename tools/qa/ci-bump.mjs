// Bump on a CI run (local-git-ci PRD FR37a) in a real browser: the run page's Bump button and dialog ("Its session" first, Fix | Ask), the
// line the page shows after a bump, and the run row's ⋯, at 390 px and 1280 px, light and dark. Checks: no horizontal scroll, the picker's
// rows are 44 px, the dialog fits the screen, the bump reaches the session, no page errors. A failed run is seeded straight into the scratch
// portal's database (the local runtime has no runner); the session it bumps runs on "This machine" against the stand-in Messages API:
//   node tools/qa/mock-anthropic.mjs 4623 /tmp/cp-bump-mock.jsonl &
//   PORTAL_LOCAL_ENABLED=true scripts/scratch-portal.sh start 3423
//   printf '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4623","ANTHROPIC_API_KEY":"fake-mock-key"}}' > /tmp/scratch-portal-3423/home/.claude/settings.json
//   QA_PORT=3423 QA_CODE=24681372 QA_SHOTS=/tmp/qa-shots/ci-bump node tools/qa/ci-bump.mjs
//   scripts/scratch-portal.sh stop 3423
import { randomUUID } from 'node:crypto';
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
const made = async (path, body) => {
  const r = await call('POST', path, body);
  if (r.status >= 300) throw new Error(`${path}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.data;
};
const owner = await made('/api/chat/sessions', { workspaceId: 'local/local', title: 'Login fixer' });
await made('/api/chat/sessions', { workspaceId: 'local/local', title: 'Reviewer' });

// One remote and one failed run, linked to the first session.
const db = new DatabaseSync(`/tmp/scratch-portal-${PORT}/data/portal.db`, { timeout: 10_000 });
const now = new Date().toISOString();
const repoId = `pqa${randomUUID().slice(0, 8)}`;
const runId = `rqa${randomUUID().slice(0, 8)}`;
db.prepare("INSERT INTO ci_repos (id, workspace_id, name, path, default_branch, created_at) VALUES (?, 'local/local', 'app', '/home/node/.pilot/app.git', 'main', ?)").run(repoId, now);
db.prepare(
  `INSERT INTO ci_runs (id, number, workspace_id, repo_id, repo, pipeline, trigger, ref, branch, sha, subject, status, reason, actor, session_id, created_at, started_at, finished_at, duration_ms, archived)
   VALUES (?, 12, 'local/local', ?, 'app', 'ci', 'push', 'refs/heads/work/login', 'work/login', ?, 'Fix the redirect after a password reset', 'failed', 'step_failed', 'push', ?, ?, ?, ?, 4200, 1)`,
).run(runId, repoId, 'a'.repeat(40), owner.id, now, now, now);
db.close();

const bumped = await call('POST', `/api/ci/runs/${runId}/bump`, { sessionId: owner.id, mode: 'prioritise', note: 'The login test fails on main too' });
check('api', 'a bump by the API is taken', bumped.status === 200 && bumped.data?.bumps?.length === 1, `${bumped.status} ${bumped.text.slice(0, 200)}`);
const chat = await call('GET', `/api/chat/sessions/${owner.id}/events?after=0`);
check('api', 'the session got it from CI #12', JSON.stringify(chat.body ?? '').includes('#12'), String(chat.status));

const MATRIX = [
  { name: 'phone-390-light', width: 390, height: 844, mobile: true },
  { name: 'phone-390-dark', width: 390, height: 844, mobile: true, dark: true },
  { name: 'desktop-1280-light', width: 1280, height: 800 },
  { name: 'desktop-1280-dark', width: 1280, height: 800, dark: true },
];

for (const cfg of MATRIX) {
  const b = await Browser.launch({ width: cfg.width, height: cfg.height, mobile: !!cfg.mobile, dark: !!cfg.dark });
  const seen = (expr, ms = 8000) => b.waitFor(expr, ms).then(() => true, () => false);
  try {
    await b.cookie(cookie);
    await b.goto(`/admin/ci/runs/${runId}`, 2500);
    // The first load waits longer: the dev server compiles the app then.
    check(cfg.name, 'the page says the run was bumped', await seen(`document.body.innerText.includes('Bumped to a session (Fix)')`, 30000));
    check(cfg.name, 'page: no horizontal scroll', await b.eval(`document.scrollingElement.scrollWidth <= innerWidth + 1`));
    await b.shot(`${cfg.name}-1-run`, { full: true });

    await b.clickSel('button[aria-label="Bump"]');
    check(cfg.name, 'the dialog opens with the sessions', await seen(`!!document.querySelector('[role=radiogroup] label')`));
    const pick = await b.eval(`(() => {
      const rows = [...document.querySelectorAll('[role=radiogroup] label')];
      const dlg = document.querySelector('[role=dialog]')?.getBoundingClientRect();
      return { rows: rows.map((r) => ({ text: r.innerText.replace(/\\s+/g, ' ').trim(), h: Math.round(r.getBoundingClientRect().height) })), checked: document.querySelector('[role=radiogroup] input:checked')?.closest('label')?.innerText ?? '', modes: document.querySelector('[role=dialog]')?.innerText ?? '', fits: !!dlg && dlg.left >= -1 && dlg.right <= innerWidth + 1, hscroll: document.scrollingElement.scrollWidth > innerWidth + 1 };
    })()`);
    check(cfg.name, 'its session is first, marked and picked', /Login fixer/.test(pick.rows[0]?.text ?? '') && /Its session/.test(pick.rows[0]?.text ?? '') && /Login fixer/.test(pick.checked), JSON.stringify(pick.rows));
    check(cfg.name, 'the modes read Fix and Ask', /Fix/.test(pick.modes) && /Ask/.test(pick.modes));
    check(cfg.name, 'picker rows are 44 px or more', pick.rows.length >= 2 && pick.rows.every((r) => r.h >= 44), JSON.stringify(pick.rows));
    check(cfg.name, 'the dialog fits the screen', pick.fits && !pick.hscroll);
    await b.shot(`${cfg.name}-2-dialog`);
    await b.key('Escape');
    await sleep(400);

    await b.goto('/admin/ci', 2500);
    check(cfg.name, 'the row has a ⋯', await seen(`!!document.querySelector('[aria-label="More for #12"]')`));
    check(cfg.name, 'runs: no horizontal scroll', await b.eval(`document.scrollingElement.scrollWidth <= innerWidth + 1`));
    await b.clickSel('[aria-label="More for #12"]');
    await sleep(400);
    await b.shot(`${cfg.name}-3-row-menu`);
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
