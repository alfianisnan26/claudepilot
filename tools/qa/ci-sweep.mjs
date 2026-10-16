// T-710: a sweep of EVERY control on the CI Runs tab and on the run page (QA-STANDARDS A1-A9), the richest state of the run page included:
// a run with three jobs (needs, an environment, an ignored one), steps in every status, artifacts, a diagnostics list and real logs (a long
// unbroken token among them). At 390 and 1280 px, light and dark: touch targets (>= 44 px at 390), no sideways scroll, text that breaks.
// Then a keyboard pass: Tab through each page, every control gets a visible focus ring, the order follows the layout, nothing traps focus.
// Seeds straight into the scratch portal's database (as runner-run.mjs and ci-targets.mjs do).
// usage: scripts/job-run.sh --ref <commit> --out job-out/t710 -- 'tools/qa/with-portal.sh 3481 env QA_SHOTS=job-out/t710/shots node tools/qa/ci-sweep.mjs; exit $?'
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${String(extra).slice(0, 700)}` : ''}`);
  if (!ok) failed++;
};
const info = (s) => console.log(`  info ${s}`);

const cookie = await login();
const db = new DatabaseSync(`/tmp/scratch-portal-${PORT}/data/portal.db`, { timeout: 10_000 });
const now = new Date().toISOString();
const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
const repoId = `pqa${randomUUID().slice(0, 8)}`;
db.prepare("INSERT INTO ci_repos (id, workspace_id, name, path, default_branch, created_at) VALUES (?, 'local/local', 'app', '/home/node/.pilot/app.git', 'main', ?)").run(repoId, now);
const insRun = db.prepare(
  `INSERT INTO ci_runs (id, number, workspace_id, repo_id, repo, pipeline, trigger, ref, branch, sha, subject, status, reason, actor, created_at, started_at, finished_at, duration_ms, archived, state, diagnostics)
   VALUES (?, ?, 'local/local', ?, 'app', ?, 'push', ?, ?, ?, ?, ?, ?, 'push', ?, ?, ?, ?, 1, ?, ?)`,
);
const step = (idx, name, status, extra = {}) => ({ idx, name, status, startedAt: status === 'pending' || status === 'skipped' ? null : ago(5), durationMs: status === 'pending' || status === 'skipped' ? null : 1200 + idx * 300, exitCode: status === 'failed' ? 1 : status === 'passed' ? 0 : null, logBytes: 100, logTruncated: false, ignored: false, reason: status === 'failed' ? 'step_failed' : null, ...extra });
const job = (id, name, status, needs, steps, extra = {}) => ({ id, name, status, needs, startedAt: ago(5), durationMs: 9000, ignored: false, reason: status === 'failed' ? 'step_failed' : null, steps, artifacts: [], artifactsSkipped: 0, ...extra });
const jobs = [
  job('build', 'Build the web app and the server with a name long enough to be cut on a phone', 'passed', [], [step(0, 'Install dependencies', 'passed'), step(1, 'Typecheck', 'passed'), step(2, 'Build a step with a very long name that goes on and on past the edge', 'passed')], { artifacts: [{ path: 'dist/index.html', bytes: 2000 }, { path: 'dist/app.js', bytes: 90000 }] }),
  job('test', 'Test', 'failed', ['build'], [step(0, 'Unit tests', 'failed'), step(1, 'Lint', 'passed', { ignored: false }), step(2, 'Coverage', 'skipped'), step(3, 'Report', 'pending')]),
  job('lint', 'Lint (ignored)', 'failed', ['build'], [step(0, 'eslint', 'failed', { ignored: true })], { ignored: true }),
  job('deploy', 'Deploy', 'skipped', ['test'], [step(0, 'Ship it', 'skipped')], { environment: 'production-with-a-long-environment-name' }),
];
const state = { v: 1, runId: 'run-rich', status: 'failed', reason: 'step_failed', startedAt: ago(5), finishedAt: now, durationMs: 41000, jobs };
const diagnostics = [{ severity: 'warning', file: '.pilot/ci.yml', line: 12, column: 3, message: 'Unknown key "cahce" in job test.', hint: 'Did you mean "cache"?' }];
insRun.run('run-rich', 100, repoId, 'ci', 'refs/heads/work/x', 'work/x', 'a'.repeat(40), 'A rich run: jobs, steps, logs, diagnostics ' + 'x'.repeat(60), 'failed', 'step_failed', ago(6), ago(5), now, 41000, JSON.stringify(state), JSON.stringify(diagnostics));
const p = (n, pipeline, status, reason) => insRun.run(`run-l${n}`, n, repoId, pipeline, 'refs/heads/main', 'main', String(n % 10).repeat(40), `Seeded run ${n}`, status, reason, ago(n), ago(n), status === 'queued' || status === 'running' ? null : ago(n - 0.5), status === 'queued' || status === 'running' ? null : 30000, null, null);
p(1, 'deploy-gate-pipeline-with-a-long-name', 'passed', null);
p(2, 'ci', 'failed', 'step_failed');
p(3, 'ci', 'cancelled', 'cancelled');
p(4, 'ci', 'passed', null);
// A second remote, so the Runs tab shows its remote picker.
const repo2 = `pqb${randomUUID().slice(0, 8)}`;
db.prepare("INSERT INTO ci_repos (id, workspace_id, name, path, default_branch, created_at) VALUES (?, 'local/local', 'lib', '/home/node/.pilot/lib.git', 'main', ?)").run(repo2, now);
insRun.run('run-lib', 1, repo2, 'ci', 'refs/heads/main', 'main', 'e'.repeat(40), 'Run on the second remote', 'passed', null, ago(7), ago(7), ago(6.5), 30000, null, null);
const logs = db.prepare('INSERT INTO ci_logs (run_id, job, step, bytes, omitted, text) VALUES (?, ?, ?, ?, 0, ?)');
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}: ok`).join('\n');
logs.run('run-rich', 'test', 0, 400, 'RUN unit tests\n' + lines(60) + '\nFAIL src/a.test.ts: a-very-long-unbroken-token-' + 'y'.repeat(200) + '\nexit 1\n');
logs.run('run-rich', 'build', 0, 20, 'npm ci\nadded 10 packages\n');
logs.run('run-rich', 'build', 1, 20, 'tsc: ok\n');
logs.run('run-rich', 'build', 2, 20, 'vite build\n' + lines(5) + '\n');
logs.run('run-rich', 'test', 1, 20, 'lint ok\n');
logs.run('run-rich', 'lint', 0, 20, 'eslint: 3 problems (ignored)\n');
db.close();

// ---- measures -----------------------------------------------------------------------------------------------------------------------
const MEASURE = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const doc = document.scrollingElement;
  const scope = document.querySelector('[role=dialog]') ?? document.querySelector('main') ?? document.body;
  const all = [...scope.querySelectorAll('button, a[href], [role=tab], [role=menuitem], input, select, textarea, [role=switch], summary, [tabindex]:not([tabindex="-1"])')].filter(vis);
  const name = (e) => (e.getAttribute('aria-label') || e.innerText || e.placeholder || e.tagName).replace(/\\s+/g, ' ').trim().slice(0, 28);
  const controls = all.map((e) => { const r = e.getBoundingClientRect(); return { t: name(e), w: Math.round(r.width), h: Math.round(r.height), dis: !!e.disabled }; });
  const over = [...scope.querySelectorAll('*')].filter((e) => vis(e) && e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('pre, [role=log]')).map((e) => e.tagName + '.' + String(e.className).slice(0, 30)).slice(0, 6);
  return { n: controls.length, scroll: [doc.scrollWidth, doc.clientWidth], controls, over, text: scope.innerText.slice(0, 3000) };
})()`;

// Kit gap (T-639, out of scope): inside the Bump dialog the shared kit's Close button is 40 px and its note field (TextField) is 42 px.
// An exact list, scoped to that dialog (a "Close" of our own anywhere else fails); at 390 px its count must be exactly 2.
const BUMP_KIT_GAP = ['Close', 'Anything it should know'];
async function measure(b, tag, label, { mobile, kitGapNames = [] }) {
  const kitGap = (c) => kitGapNames.includes(c.t);
  const m = await b.eval(MEASURE);
  const small = m.controls.filter((c) => (c.w < 43.5 || c.h < 43.5) && !c.dis);
  const known = small.filter(kitGap);
  const real = small.filter((c) => !kitGap(c));
  info(`${label}: ${m.n} controls`);
  if (known.length) info(`${label}: kit gap (T-639, not fixed here): ${JSON.stringify(known)}`);
  if (mobile) {
    check(`${tag} ${label}: every control >= 44 px`, real.length === 0, JSON.stringify(real));
    if (kitGapNames.length) check(`${tag} ${label}: kit gap is exactly ${kitGapNames.length} controls`, known.length === kitGapNames.length && kitGapNames.every((n) => known.some((c) => c.t === n)), JSON.stringify(known));
  } else {
    const tiny = m.controls.filter((c) => (c.w < 23.5 || c.h < 23.5) && !c.dis);
    check(`${tag} ${label}: every control >= 24 px at desktop (WCAG 2.2 minimum)`, tiny.length === 0, JSON.stringify(tiny));
  }
  check(`${tag} ${label}: no sideways scroll`, m.scroll[0] <= m.scroll[1] + 1 && m.over.length === 0, JSON.stringify([m.scroll, m.over]));
  check(`${tag} ${label}: no NaN/undefined/null`, !/\b(NaN|undefined|null)\b/.test(m.text));
  return m;
}

// ---- the keyboard pass --------------------------------------------------------------------------------------------------------------
const RING = `(() => {
  const e = document.activeElement; if (!e || e === document.body) return null;
  const s = getComputedStyle(e); const r = e.getBoundingClientRect();
  const shadows = s.boxShadow === 'none' ? [] : s.boxShadow.split(/,(?![^(]*\\))/).map((x) => x.trim());
  const seen = shadows.filter((x) => !/rgba\\(0, 0, 0, 0\\)|\\/ 0\\)|#0000|transparent/.test(x) && /[1-9]\\d*(\\.\\d+)?px/.test(x));
  const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
  const name = (e.getAttribute('aria-label') || e.innerText || e.placeholder || e.tagName).replace(/\\s+/g, ' ').trim().slice(0, 28);
  const inMain = !!e.closest('main, [role=dialog]');
  return { tag: e.tagName.toLowerCase(), name, ring: outline || seen.length > 0, outline, shadow: s.boxShadow.slice(0, 80), top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), inMain, onScreen: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth };
})()`;

async function tabPass(b, tag, label, { max = 60, scopeSel = 'main', modal = false } = {}) {
  await b.eval(`(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); const m = document.querySelector(${JSON.stringify(scopeSel)}); if (m) { const a = document.createElement('span'); a.tabIndex = -1; a.id = '__start'; m.prepend(a); a.focus(); } })()`);
  const seq = [];
  let outside = 0;
  let stuck = false;
  for (let i = 0; i < max; i++) {
    await b.key('Tab');
    await sleep(40);
    const f = await b.eval(RING);
    if (!f) { outside++; if (outside > 2) break; continue; }
    if (!f.inMain) { if (seq.length) break; continue; }
    if (seq.length && seq.at(-1).top === f.top && seq.at(-1).left === f.left && seq.at(-1).name === f.name) { stuck = true; break; }
    seq.push(f);
  }
  await b.eval(`document.getElementById('__start')?.remove()`);
  info(`${label}: tab order: ${seq.map((f) => `${f.name}@${f.left},${f.top}`).join(' | ')}`);
  check(`${tag} ${label}: Tab reaches controls inside the page`, seq.length > 0);
  if (modal) {
    // A modal keeps focus inside by design (the way out is Escape, checked by the caller): it must visit more than one control and never leave.
    const distinct = new Set(seq.map((f) => `${f.name}@${f.left},${f.top}`));
    check(`${tag} ${label}: Tab visits several controls and stays in the dialog`, distinct.size >= 3 && outside === 0, `${distinct.size} distinct`);
    const noRingModal = seq.filter((f) => !f.ring && !['input', 'select', 'textarea'].includes(f.tag));
    const fields = seq.filter((f) => !f.ring && ['input', 'select', 'textarea'].includes(f.tag));
    if (fields.length) info(`${label}: kit text field shows a border-colour focus, no ring (T-639 family, not fixed here): ${[...new Set(fields.map((f) => f.name))].join(', ')}`);
    check(`${tag} ${label}: every focused button shows a ring`, noRingModal.length === 0, JSON.stringify(noRingModal.map((f) => ({ n: f.name, t: f.tag, s: f.shadow }))));
    return seq;
  }
  check(`${tag} ${label}: no focus trap (Tab moves on)`, !stuck && seq.length < max);
  const noRing = seq.filter((f) => !f.ring);
  check(`${tag} ${label}: every focused control shows a ring`, noRing.length === 0, JSON.stringify(noRing.map((f) => ({ n: f.name, t: f.tag, s: f.shadow }))));
  const bad = [];
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1], c = seq[i];
    const sameRow = Math.abs(c.top - a.top) <= 12;
    if (c.top < a.top - 12 || (sameRow && c.left < a.left - 2)) bad.push(`${a.name}@${a.left},${a.top} -> ${c.name}@${c.left},${c.top}`);
  }
  check(`${tag} ${label}: tab order follows the layout`, bad.length === 0, bad.join(' ; '));
  return seq;
}

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
const open = async (path, ready) => { await b.goto(path, 1800); await b.waitFor(ready, 15_000, path).catch((e) => console.log(`  warn ${e.message}`)); };
try {
  await b.cookie(cookie);
  for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
    for (const dark of [false, true]) {
      const tag = `${w}-${dark ? 'dark' : 'light'}`;
      console.log(tag);
      await b.setViewport(w, h, mobile);
      await b.media({ dark });

      // Runs tab, all four filters
      await open('/admin/ci?tab=runs', `document.querySelectorAll('[role=group][aria-label=Show] button').length === 4 && /#100/.test(document.body.innerText)`);
      await measure(b, tag, 'runs tab', { mobile });
      await b.shot(`runs-${tag}`);
      for (const f of ['Running', 'Failed', 'Passed']) {
        await b.clickSel(`[role=group][aria-label=Show] button[aria-label=${f}]`).catch(() => b.clickText(f));
        await sleep(500);
        await measure(b, tag, `runs tab filter ${f}`, { mobile });
      }
      await b.clickSel('[role=group][aria-label=Show] button').catch(() => {});
      await sleep(300);
      await open('/admin/ci?tab=runs&branch=main', `!!document.querySelector('button[aria-label^="Clear branch"]')`);
      await measure(b, tag, 'runs tab with a branch filter', { mobile });
      await b.shot(`runs-branch-${tag}`);
      const chipSeq = await tabPass(b, tag, 'branch chip keyboard', { max: 40 });
      const chip = chipSeq.find((f) => /^Clear branch/.test(f.name));
      // The explicit accent ring (a box-shadow) with the browser's default outline suppressed: the UA outline alone (what the chip had before) is not the design.
      check(`${tag} branch chip: Tab reaches it and it shows the accent ring, not the browser outline`, !!chip && chip.ring && !chip.outline, JSON.stringify(chip));
      await open('/admin/ci?tab=runs', `document.querySelector('select')`);
      await tabPass(b, tag, 'runs tab keyboard', { max: 40 });

      // Run page: richest state
      await open('/admin/ci/runs/run-rich', `document.querySelector('h1')?.innerText.includes('#100')`);
      await sleep(800);
      let m = await measure(b, tag, 'run page (first failed step open)', { mobile });
      check(`${tag} run page: the failed step's log is open and shows its text`, /FAIL src\/a\.test\.ts/.test(m.text));
      await b.shot(`run-rich-open-${tag}`);
      // open every job and step
      for (let i = 0; i < 12; i++) {
        const clicked = await b.eval(`(() => { const e = [...document.querySelectorAll('main button[aria-expanded=false]')].find((x) => !x.disabled); if (!e) return false; e.click(); return true; })()`);
        if (!clicked) break;
        await sleep(250);
      }
      await sleep(800);
      m = await measure(b, tag, 'run page (all jobs, steps and logs open)', { mobile });
      check(`${tag} run page: logs, artifacts and the diagnostics line are shown`, /Install dependencies|npm ci/.test(m.text) && /artifacts/.test(m.text) && /cahce/.test(m.text));
      await b.shot(`run-rich-all-${tag}`, { full: true });
      await tabPass(b, tag, 'run page keyboard (all open)', { max: 80 });

      // keyboard activation: Enter and Space toggle a job
      await open('/admin/ci/runs/run-rich', `document.querySelector('h1')?.innerText.includes('#100')`);
      await b.eval(`[...document.querySelectorAll('main button[aria-expanded]')].find((e) => /Lint \\(ignored\\)/.test(e.innerText))?.focus()`);
      const exp = () => b.eval(`document.activeElement.getAttribute('aria-expanded')`);
      const before = await exp();
      await b.key('Enter');
      await sleep(300);
      const afterEnter = await exp();
      await b.key(' ');
      await sleep(300);
      const afterSpace = await exp();
      check(`${tag} run page: Enter and Space toggle a job`, afterEnter !== before && afterSpace === before, JSON.stringify([before, afterEnter, afterSpace]));

      // Bump dialog (a rich control on the run page): size, ring, Escape closes, focus returns
      await open('/admin/ci/runs/run-rich', `document.querySelector('h1')?.innerText.includes('#100')`);
      await b.clickSel('button[aria-label=Bump]');
      await sleep(700);
      const dlg = await b.eval(`document.querySelectorAll('[role=dialog]').length`);
      check(`${tag} bump dialog opens`, dlg === 1, String(dlg));
      if (dlg) {
        await measure(b, tag, 'bump dialog', { mobile, kitGapNames: BUMP_KIT_GAP });
        await b.shot(`bump-${tag}`);
        await tabPass(b, tag, 'bump dialog keyboard', { max: 14, scopeSel: '[role=dialog]', modal: true }).catch((e) => console.log(`  warn ${e.message}`));
        await b.key('Escape');
        await sleep(500);
        const left = await b.eval(`document.querySelectorAll('[role=dialog]').length`);
        check(`${tag} bump dialog: Escape closes it`, left === 0, String(left));
        const lock = await b.eval(`({ o: getComputedStyle(document.body).overflow, p: getComputedStyle(document.body).position })`);
        check(`${tag} bump dialog: scroll lock released`, lock.o !== 'hidden' && lock.p !== 'fixed', JSON.stringify(lock));
      }
    }
  }
} finally {
  await b.close();
}
console.log(failed ? `${failed} FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
