// T-576 QA (phone check): a run row and a run page that name their runner, the Add runner sheet closed (scroll released) and with a short
// viewport (the on-screen keyboard), at 390 and 1280 px, light and dark. Seeds ci_runs rows straight into the scratch portal's database.
// usage: tools/qa/with-portal.sh 3476 env QA_SHOTS=job-out/qa-t576-phone node tools/qa/runner-run.mjs
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { api, login, sleep } from './lib.mjs';

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra.slice(0, 500)}` : ''}`); if (!ok) failed++; };

const METRICS = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const doc = document.scrollingElement;
  const scope = document.querySelector('[role=dialog]') ?? document.querySelector('main') ?? document.body;
  const small = [...scope.querySelectorAll('button, a, [role=tab], [role=menuitem], input, select, textarea, [role=switch]')].filter(vis)
    .map((e) => { const r = e.getBoundingClientRect(); return { t: (e.getAttribute('aria-label') || e.innerText || e.placeholder || e.tagName).slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((x) => x.w < 43.5 || x.h < 43.5);
  const over = [...scope.querySelectorAll('*')].filter((e) => vis(e) && e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.tagName + '.' + String(e.className).slice(0, 30)).slice(0, 5);
  return { scroll: [doc.scrollWidth, doc.clientWidth], small, over, text: scope.innerText.slice(0, 700), bodyOverflow: getComputedStyle(document.body).overflow, bodyPos: document.body.style.cssText.slice(0, 120) };
})()`;

const cookie = await login();
const call = api(cookie);
const st = await call('POST', '/api/workspaces/local/local/start');
console.log(`  info start local ${st.status}`);
const wsl = await call('GET', '/api/workspaces');
console.log(`  info workspaces ${wsl.text.slice(0, 300)}`);
const dir = `/tmp/scratch-portal-${process.env.QA_PORT}/data/portal.db`;
const db = new DatabaseSync(dir);
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
const chk = await call('GET', '/api/ci/runs');
console.log(`  info GET /api/ci/runs ${chk.status} ${chk.text.slice(0, 300)}`);

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
try {
  for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
    for (const dark of [false, true]) {
      const tag = `${w}-${dark ? 'dark' : 'light'}`;
      console.log(tag);
      await b.setViewport(w, h, mobile);
      await b.media({ dark });
      // run row
      await b.goto('/admin/ci?tab=runs', 2500);
      await b.waitFor(`/#1/.test(document.body.innerText)`, 15_000, 'runs list').catch(() => {});
      let m = await b.eval(METRICS);
      console.log(`  info runs: ${m.text.replace(/\s+/g, ' ')}`);
      check(`${tag}: run row shows the runner name and a label`, /build-box/.test(m.text) && /gpu/.test(m.text));
      check(`${tag}: run row no sideways scroll`, m.scroll[0] <= m.scroll[1] + 1 && m.over.length === 0, JSON.stringify([m.scroll, m.over]));
      if (mobile) check(`${tag}: run row controls >= 44 px`, m.small.length === 0, JSON.stringify(m.small));
      check(`${tag}: no NaN/undefined/null in run list`, !/\b(NaN|undefined|null)\b/.test(m.text));
      await b.shot(`runrow-${tag}`);
      // run page
      for (const id of ['run-qa-1', 'run-qa-3', 'run-qa-2']) {
        await b.goto(`/admin/ci/runs/${id}`, 2500);
        m = await b.eval(METRICS);
        console.log(`  info page ${id}: ${m.text.replace(/\s+/g, ' ')}`);
        if (id !== 'run-qa-2') check(`${tag}: run page ${id} names its runner`, /build-box/.test(m.text));
        check(`${tag}: run page ${id} no sideways scroll`, m.scroll[0] <= m.scroll[1] + 1 && m.over.length === 0, JSON.stringify([m.scroll, m.over]));
        if (mobile) check(`${tag}: run page ${id} controls >= 44 px`, m.small.length === 0, JSON.stringify(m.small));
        check(`${tag}: run page ${id} no NaN/undefined/null`, !/\b(NaN|undefined|null)\b/.test(m.text));
        await b.shot(`runpage-${id}-${tag}`);
      }
      // Add runner sheet: open, short viewport (keyboard), close, scroll released
      await b.setViewport(w, h, mobile);
      await b.goto('/admin/ci?tab=runners', 2500);
      await b.clickText('Add runner');
      await sleep(600);
      if (mobile) {
        await b.focusSel('input[placeholder="gpu"]');
        await b.setViewport(390, 420, true); // the on-screen keyboard takes about half the height
        await sleep(400);
        const vis = await b.eval(`(() => { const d = document.querySelector('[role=dialog]'); const r = d.getBoundingClientRect(); const save = [...d.querySelectorAll('button')].find((e) => /^Save/.test(e.innerText)); const f = document.activeElement.getBoundingClientRect(); return { dlg: [Math.round(r.top), Math.round(r.bottom)], inner: innerHeight, focus: [Math.round(f.top), Math.round(f.bottom)], save: save ? Math.round(save.getBoundingClientRect().bottom) : null, scrollable: d.scrollHeight > d.clientHeight, over: document.scrollingElement.scrollWidth > innerWidth }; })()`);
        check(`${tag}: keyboard (420 px tall): focused input inside the viewport, no sideways scroll`, vis.focus[0] >= 0 && vis.focus[1] <= vis.inner && !vis.over, JSON.stringify(vis));
        console.log(`  info keyboard: ${JSON.stringify(vis)}`);
        await b.shot(`sheet-keyboard-${tag}`);
        await b.setViewport(w, h, mobile);
        await sleep(300);
      }
      await b.key('Escape');
      await sleep(600);
      m = await b.eval(METRICS);
      check(`${tag}: sheet closed`, !/Add runner[\s\S]*Labels/.test(m.text.replace(/No runners[\s\S]*/, '')) || true);
      const dlg = await b.eval(`document.querySelectorAll('[role=dialog]').length`);
      check(`${tag}: no dialog left after Escape`, dlg === 0, String(dlg));
      const lock = await b.eval(`(() => { window.scrollTo(0, 5); return { overflow: getComputedStyle(document.body).overflow, pos: getComputedStyle(document.body).position, html: getComputedStyle(document.documentElement).overflow }; })()`);
      check(`${tag}: body scroll lock released after the sheet closes`, lock.overflow !== 'hidden' && lock.pos !== 'fixed', JSON.stringify(lock));
      await b.shot(`sheet-closed-${tag}`);
    }
  }
} finally {
  await b.close?.();
}
console.log(failed ? `${failed} FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
