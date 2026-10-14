// Crew limits and roles in the app (T-294, chat-sessions PRD FR51 "Limits per session", "Agent per session"): Session info's Workers stepper
// and Sub-agents switch, and the role badge. Over 390 px (touch, the iPhone's safe areas) and 1280 px, light and dark, against a scratch
// portal seeded with a lead (its process reads live) and two workers with a role (one very long), it asserts:
//   - Workers reads "Default (5)" (the global Settings › Sessions cap); two taps on "Fewer workers" save 3 (one PATCH …/limits after the
//     last tap, the server says 3); up to the cap reads Default again (null on the server); the keyboard steps it too; a pick is saved when
//     the sheet closes at once; nothing goes below None;
//   - Sub-agents off saves `subagents: false`; the running process needs a restart, so one line says so with Restart, which opens the
//     existing Restart sheet (not run here);
//   - the role shows on the worker's header (the badge from 640 px; its icon, a 44 px target, on a phone) and in its Session info, on its
//     row in the Sessions list and in the lead's worker list; a session without one shows none;
//   - nothing scrolls sideways; on touch every control here is a 44 px target.
// usage: scripts/scratch-portal.sh start 3441 && QA_PORT=3441 QA_CODE=24681372 node tools/qa/session-limits.mjs [--shots dir] [--keep]
//   It seeds /tmp/scratch-portal-$QA_PORT/data/portal.db (LIMITS_DB overrides) with rows whose ids start "qalim-" and removes them at the end.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { api, login, PORT, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const dbPath = process.env.LIMITS_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`;
let failed = 0;
let passed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (ok) passed++;
  else failed++;
};

// --- seed -------------------------------------------------------------------------------------------------------------------------------
const db = new DatabaseSync(dbPath, { timeout: 10000 });
// A target the portal does not list (not Docker's): the workspace does not read as removed, so Restart is offered as for a real one.
const WS = 'k8s/qa-limits';
const purge = () => db.exec(`DELETE FROM chat_sessions WHERE id LIKE 'qalim-%'`);
purge();
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ins = db.prepare(`INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, process, model, mode, cost_est_usd, launch, created_at,
  last_activity_at, parent_id, claude_id, started_by, agent) VALUES (?, ?, '/home/node', ?, 'ui', 'idle', ?, ?, 'claude-opus-5-5', 'default', 0, '{}', ?, ?, ?, '', ?, ?)`);
const LONG_ROLE = 'release-coordinator-with-a-long-role-name';
// [id, title, process, parent, agent, born (min ago)]
const rows = [
  ['qalim-lead', 'QA limits lead', 'live', null, null, 30],
  ['qalim-w', 'QA limits worker', 'gone', 'qalim-lead', 'qa-verifier', 20],
  ['qalim-long', 'QA limits worker with the long role', 'gone', 'qalim-lead', LONG_ROLE, 10],
];
for (const [id, title, proc, parent, agent, born] of rows) {
  const at = iso(now - born * 60_000);
  ins.run(id, WS, title, at, proc, at, at, parent, parent ? `session:${parent}` : 'ui', agent);
}

// --- the browser --------------------------------------------------------------------------------------------------------------------------
const IPHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: IPHONE },
  { name: '1280', w: 1280, h: 900, mobile: false, insets: { top: 0, bottom: 0, left: 0, right: 0 } },
];
const cookie = await login();
const call = api(cookie);
const server = async (id) => (await call('GET', `/api/chat/sessions/${id}`)).data;
const reset = () => call('PATCH', '/api/chat/sessions/qalim-lead/limits', { maxWorkers: null, subagents: true });
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);

const sideways = () => b.eval(`document.scrollingElement.scrollWidth <= innerWidth`);
const shot = async (name) => {
  if (!shots) return;
  const r = await b.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, `t294ui2-${name}.png`), Buffer.from(r.data, 'base64'));
};
// `text` is what shows (innerText: a part hidden at this width is not counted).
const box = (sel) =>
  b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right, text: e.innerText.trim(), label: e.getAttribute('aria-label') }; })()`);
// The seeded lead has no real process: the portal finds that out and marks it gone. Its process reads live again before each sub-agents change.
const liveAgain = () => db.prepare(`UPDATE chat_sessions SET process = 'live', state = 'idle' WHERE id = 'qalim-lead'`).run();
const limitsText = () => b.eval(`document.querySelector('[data-crew-workers-limit] output [aria-hidden]')?.textContent ?? null`);
const patches = () => b.requests.filter((r) => r.method === 'PATCH' && r.url.endsWith('/limits')).length;
const openInfo = async () => {
  await b.clickSel('[data-session-header] button[aria-label$="session info"]');
  await b.waitFor(`!!document.querySelector('[data-crew-limits]')`, 6000, 'Session info').catch(() => {});
  await sleep(400);
};
const closeSheets = async () => {
  await b.key('Escape');
  await sleep(400);
};

for (const size of SIZES) {
  for (const dark of [false, true]) {
    const tag = `${size.name}-${dark ? 'dark' : 'light'}`;
    console.log(tag);
    await reset();
    await b.setViewport(size.w, size.h, size.mobile);
    await b.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets }).catch(() => {});
    await b.media({ dark });

    // The lead: Workers and Sub-agents in Session info.
    await b.goto('/admin/sessions/qalim-lead', 2500);
    await b.waitFor(`!!document.querySelector('[data-session-header]')`, 8000, 'header').catch(() => {});
    check(`${tag} lead: no role, no role chip`, (await box('[data-role-chip]')) === null);
    await openInfo();
    check(`${tag} Workers reads the global setting`, (await limitsText()) === 'Default (5)', String(await limitsText()));
    const less = await box('[data-crew-workers-limit] button[aria-label="Fewer workers"]');
    const more = await box('[data-crew-workers-limit] button[aria-label="More workers"]');
    if (size.mobile) check(`${tag} the stepper's buttons are 44 px targets`, less?.h >= 44 && less?.w >= 44 && more?.h >= 44, JSON.stringify([less, more]));
    check(`${tag} up is shut at Default (the cap)`, (await b.eval(`document.querySelector('[data-crew-workers-limit] button[aria-label="More workers"]').getAttribute('aria-disabled')`)) === 'true');
    await shot(`info-${tag}`);
    const p0 = patches();
    await b.clickSel('[data-crew-workers-limit] button[aria-label="Fewer workers"]');
    await sleep(120);
    await b.clickSel('[data-crew-workers-limit] button[aria-label="Fewer workers"]');
    check(`${tag} two taps show 3 at once`, (await limitsText()) === '3', String(await limitsText()));
    await sleep(1000);
    check(`${tag} one PATCH after the last tap`, patches() - p0 === 1, String(patches() - p0));
    check(`${tag} the server has 3`, (await server('qalim-lead'))?.maxWorkers === 3);
    check(`${tag} the page still shows 3 once the session caught up`, (await limitsText()) === '3', String(await limitsText()));
    await shot(`info-workers-3-${tag}`);
    // The keyboard: Enter on "More workers" twice, back to the cap: Default.
    await b.focusSel('[data-crew-workers-limit] button[aria-label="More workers"]');
    await b.key('Enter');
    await sleep(120);
    await b.key('Enter');
    await sleep(1000);
    check(`${tag} the keyboard steps it up to Default`, (await limitsText()) === 'Default (5)' && (await server('qalim-lead'))?.maxWorkers === null, String(await limitsText()));
    // A tap and the sheet shut at once: what was picked is saved when it closes.
    await b.clickSel('[data-crew-workers-limit] button[aria-label="Fewer workers"]');
    await b.key('Escape');
    await sleep(800);
    check(`${tag} closing the sheet saves the pick`, (await b.eval(`!document.querySelector('[data-crew-limits]')`)) && (await server('qalim-lead'))?.maxWorkers === 4);
    await openInfo();
    // Down to None, and not below.
    for (let i = 0; i < 6; i++) {
      await b.clickSel('[data-crew-workers-limit] button[aria-label="Fewer workers"]');
      await sleep(60);
    }
    await sleep(1000);
    check(`${tag} None is the bottom`, (await limitsText()) === 'None' && (await server('qalim-lead'))?.maxWorkers === 0, String(await limitsText()));

    // Sub-agents off: saved; the live process needs a restart, one line says so with Restart.
    liveAgain();
    await b.clickSel('[data-crew-limits] [role="switch"]');
    await b.waitFor(`!!document.querySelector('[data-crew-limits-note]')`, 4000, 'restart note').catch(() => {});
    check(`${tag} Sub-agents off saved`, (await server('qalim-lead'))?.subagents === false);
    const note = await box('[data-crew-limits-note]');
    check(`${tag} one line says it applies at the next restart`, /^Sub-agents off from the next restart\./.test(note?.text ?? ''), JSON.stringify(note?.text));
    const restartBtn = await box('[data-crew-limits-note] button');
    if (size.mobile) check(`${tag} its Restart is a 44 px target`, restartBtn?.h >= 44, JSON.stringify(restartBtn));
    check(`${tag} Session info: no sideways scroll`, (await sideways()) === true);
    await shot(`info-subagents-off-${tag}`);
    await b.clickSel('[data-crew-limits-note] button');
    await sleep(700);
    const sheet = await b.eval(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].find((e) => /Restart now/.test(e.textContent)); if (!d) return null; const r = d.getBoundingClientRect(); return { visible: getComputedStyle(d).visibility !== 'hidden' && r.height > 0 && r.top < innerHeight && r.bottom > 0, info: !!document.querySelector('[data-crew-limits]') }; })()`);
    check(`${tag} Restart opens the existing Restart sheet (Session info closes)`, !!sheet?.visible && !sheet.info, JSON.stringify(sheet));
    await shot(`restart-sheet-${tag}`);
    await closeSheets();

    // A worker with a role: its header, its Session info.
    await b.goto('/admin/sessions/qalim-w', 2500);
    await b.waitFor(`!!document.querySelector('[data-role-chip]')`, 8000, 'role chip').catch(() => {});
    const chip = await box('[data-role-chip]');
    check(`${tag} worker header: the role chip names it`, /qa-verifier/.test(chip?.label ?? ''), JSON.stringify(chip));
    if (size.mobile) check(`${tag} worker header: on a phone its icon alone, a 44 px target`, chip?.text === '' && chip.h >= 44 && chip.w >= 44, JSON.stringify(chip));
    else check(`${tag} worker header: from 640 px the badge with its name`, chip?.text === 'qa-verifier', JSON.stringify(chip));
    check(`${tag} worker page: no sideways scroll`, (await sideways()) === true && (chip?.right ?? 0) <= size.w);
    await shot(`worker-header-${tag}`);
    await b.clickSel('[data-role-chip]');
    await b.waitFor(`!!document.querySelector('[data-session-role]')`, 6000, 'role row').catch(() => {});
    check(`${tag} the chip opens Session info, which names the role`, /qa-verifier/.test((await box('[data-session-role]'))?.text ?? ''));
    await shot(`worker-info-${tag}`);
    await closeSheets();

    // The lead's worker list: each worker's role under its title, the long one cut short inside the sheet.
    await b.goto('/admin/sessions/qalim-lead', 2500);
    await b.waitFor(`!!document.querySelector('[data-crew-workers]')`, 8000, 'workers button').catch(() => {});
    await b.clickSel('[data-crew-workers]');
    await b.waitFor(`!!document.querySelector('[data-crew-list]')`, 4000, 'workers list').catch(() => {});
    await sleep(400);
    const listed = await b.eval(`(() => { const ul = document.querySelector('[data-crew-list]'); if (!ul) return null; const w = ul.getBoundingClientRect(); return [...ul.querySelectorAll('[data-role-badge]')].map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent.replace(/^Role /, '').trim(), inside: r.right <= w.right + 1 }; }); })()`);
    check(`${tag} lead's worker list: each worker's role`, JSON.stringify(listed?.map((x) => x.text)) === JSON.stringify(['qa-verifier', LONG_ROLE]), JSON.stringify(listed));
    check(`${tag} lead's worker list: the long role stays inside`, !!listed?.length && listed.every((x) => x.inside), JSON.stringify(listed));
    check(`${tag} lead's worker list: no sideways scroll`, (await sideways()) === true);
    await shot(`worker-list-${tag}`);
    await closeSheets();

    // The Sessions list: the workers' rows carry their role; the lead's does not.
    await b.eval(`localStorage.removeItem('claudepilot.sessions-view')`).catch(() => {});
    await b.goto('/admin/sessions', 2500);
    await b.waitFor(`!!document.querySelector('[data-chip=all]')`, 8000, 'chips').catch(() => {});
    await b.eval(`document.querySelector('[data-chip=all]')?.click()`);
    await sleep(500);
    const rowRoles = await b.eval(`(() => {
      const row = (t) => [...document.querySelectorAll('ul[data-session-rows] li')].find((li) => li.querySelector(':scope > div > div > a p.font-semibold')?.textContent === t);
      const role = (t) => { const li = row(t); return li ? (li.querySelector(':scope > div > div > a [data-role-badge]')?.textContent.replace(/^Role /, '').trim() ?? '') : null; };
      return { lead: role('QA limits lead'), w: role('QA limits worker'), long: role('QA limits worker with the long role') };
    })()`);
    check(`${tag} Sessions list: the workers' rows carry their role, the lead's none`, rowRoles?.lead === '' && rowRoles.w === 'qa-verifier' && rowRoles.long === LONG_ROLE, JSON.stringify(rowRoles));
    check(`${tag} Sessions list: no sideways scroll`, (await sideways()) === true);
    await b.eval(`[...document.querySelectorAll('ul[data-session-rows] li')].find((li) => li.querySelector(':scope > div > div > a p.font-semibold')?.textContent === 'QA limits lead')?.scrollIntoView({ block: 'center' })`);
    await sleep(200);
    await shot(`list-${tag}`);
  }
}

console.log(`page errors: ${b.errors.length}`);
for (const e of b.errors.slice(0, 5)) console.log(`  ${e.split('\n')[0]}`);
await b.close();
await reset();
if (!args.includes('--keep')) purge();
console.log(`${failed ? 'FAILED' : 'passed'}: ${passed} passed, ${failed} failing`);
process.exit(failed ? 1 : 0);
