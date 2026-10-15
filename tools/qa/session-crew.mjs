// Crew (T-294, 2026-10-14, the owner: "terlihat hierarchy-nya, dan menginduk ke claude session yang mana, agar tidak bloated"): the sessions a
// session started sit under it. Over 390 px (touch, the iPhone's safe areas) and 1280 px, light and dark, against a scratch portal seeded with
// a lead and its workers (one on another Claude, two ended, one waiting on you, one with a very long title) and a worker of an archived lead,
// it asserts:
//   - in All, the lead's row carries its crew count; its live workers sit under it on a rail, the ended ones behind one "2 done" row that is
//     shut until it is opened (by touch or the keyboard) and holds its place; the worker waiting on you is under Needs you, under a lead
//     header for its lead (T-369), not "from"; the worker of an archived lead is a row of its own with "from <lead>"; a worker names its
//     Claude only when it differs from its lead's;
//   - the Needs you chip lists the waiting worker under a lead header (not the lead as a row), with no "from";
//   - T-369: the In progress chip with the lead idle lists the working worker under a lead header (title, Idle, crew count 6, a link to the
//     lead, a 44 px target, no ⋯ of its own), not as a flat row with "from";
//   - a worker's page links up to its lead (title and Claude); the lead's page counts its workers and lists them on a tap (sheet or popover);
//   - nothing scrolls sideways; on touch every crew control is a 44 px target.
// usage: scripts/scratch-portal.sh start 3417 && QA_PORT=3417 QA_CODE=24681372 node tools/qa/session-crew.mjs [--shots dir] [--keep]
//   It seeds /tmp/scratch-portal-$QA_PORT/data/portal.db (CREW_DB overrides) with rows whose ids start "qacrew-" and removes them at the end
//   (--keep leaves them, to look by hand).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const dbPath = process.env.CREW_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`;
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};

// --- seed -------------------------------------------------------------------------------------------------------------------------------
const db = new DatabaseSync(dbPath, { timeout: 10000 });
const WS = 'docker/qa-crew';
const purge = () =>
  db.exec(`DELETE FROM chat_requests WHERE session_id LIKE 'qacrew-%'; DELETE FROM chat_sessions WHERE id LIKE 'qacrew-%';
    DELETE FROM workspace_claudes WHERE id LIKE 'qacrew-%'`);
purge();
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
db.prepare(`INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES ('qacrew-work', ?, 'Work', '', ?)`).run(WS, iso(now));
const ins = db.prepare(`INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, process, model, mode, cost_est_usd, launch, created_at,
  last_activity_at, ended_reason, parent_id, claude_id, archived_at, started_by) VALUES (?, ?, '/home/node', ?, 'ui', ?, ?, ?, 'claude-opus-5-5', 'default', 0, '{}', ?, ?, ?, ?, ?, ?, ?)`);
const LONG = 'QA crew worker with a very long title that has to truncate on a narrow phone screen without pushing anything sideways at all';
// [id, title, state, parent, claude, born (min ago), archived]
const rows = [
  ['qacrew-lead', 'QA crew lead', 'idle', null, '', 60, false],
  ['qacrew-a', 'QA crew worker A', 'working', 'qacrew-lead', '', 50, false],
  ['qacrew-b', 'QA crew worker B', 'idle', 'qacrew-lead', 'qacrew-work', 45, false],
  ['qacrew-long', LONG, 'idle', 'qacrew-lead', '', 44, false],
  ['qacrew-c', 'QA crew worker C', 'ended', 'qacrew-lead', '', 40, false],
  ['qacrew-d', 'QA crew worker D', 'ended', 'qacrew-lead', '', 35, false],
  ['qacrew-e', 'QA crew worker E', 'waiting', 'qacrew-lead', '', 30, false],
  ['qacrew-old', 'QA crew old lead', 'ended', null, '', 120, true],
  ['qacrew-f', 'QA crew worker F', 'idle', 'qacrew-old', '', 110, false],
];
// T-321: the waiting worker's process is 'live'. A request with no live process behind it is one nobody can answer: the portal's liveness
// tick (every 60 s) resolves it `stale` and the session reads Interrupted (T-284), so with 'gone' the check failed whenever a tick fell
// inside the run. The scratch portal cannot reach docker/qa-crew, so its status check answers "unknown" and leaves the live row alone.
// T-369: the working worker is 'live' too, so the In progress chip keeps it for the whole run.
for (const [id, title, state, parent, claude, born, archived] of rows) {
  const at = iso(now - born * 60_000);
  ins.run(id, WS, title, state, at, state === 'waiting' || state === 'working' ? 'live' : 'gone', at, at, state === 'ended' ? 'ended by you' : null, parent, claude, archived ? at : null, parent ? `session:${parent}` : 'ui');
}
db.prepare(`INSERT INTO chat_requests (session_id, request_id, kind, tool_name, title, detail, created_at) VALUES ('qacrew-e', 'r1', 'tool', 'Bash', 'Run a command', 'npm test', ?)`).run(iso(now));

// --- the browser --------------------------------------------------------------------------------------------------------------------------
const IPHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: IPHONE },
  { name: '1280', w: 1280, h: 900, mobile: false, insets: { top: 0, bottom: 0, left: 0, right: 0 } },
];
const cookie = await login();
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);

// In the page: the row (li) whose own title is `t`, and facts about it.
const HELPERS = `(() => {
  window.__row = (t) => [...document.querySelectorAll('ul[data-session-rows] li')].find((li) => li.querySelector(':scope > div > div > a p.font-semibold')?.textContent === t);
  window.__fact = (t) => {
    const li = __row(t);
    if (!li) return null;
    const own = li.querySelector(':scope > div');
    const crew = li.querySelector(':scope > ul[data-crew]');
    const kids = crew ? [...crew.querySelectorAll(':scope > li')].map((c) => c.querySelector(':scope > div > div > a p.font-semibold')?.textContent ?? null).filter(Boolean) : [];
    const done = crew?.querySelector(':scope > li > button[data-crew-done]');
    const from = own.querySelector('a[data-crew-from]');
    return {
      group: li.closest('[data-status-group]')?.dataset.statusGroup ?? null,
      top: li.parentElement.matches('ul[data-session-rows]'),
      kids, done: done ? { text: done.textContent.trim(), open: done.getAttribute('aria-expanded'), h: done.getBoundingClientRect().height } : null,
      count: own.querySelector('[data-crew-count] .tabular-nums')?.textContent.trim() ?? null,
      countLabel: own.querySelector('[data-crew-count] .sr-only')?.textContent.trim() ?? null,
      from: from ? { text: from.textContent.trim(), href: from.getAttribute('href'), h: from.getBoundingClientRect().height } : null,
      text: own.textContent,
      chevron: own.querySelector('button[aria-expanded][aria-label*="started"]')?.getBoundingClientRect().height ?? null,
    };
  };
  // T-369: the lead header for title t inside the status heading g (any when null): where it is, what it says, what sits under it.
  window.__header = (t, g = null) => {
    const a = [...document.querySelectorAll('a[data-crew-header]')].find((x) => x.querySelector('[data-header-title]')?.textContent === t && (!g || x.closest('[data-status-group]')?.dataset.statusGroup === g));
    if (!a) return null;
    const li = a.closest('li[data-lead-header]');
    const crew = li.querySelector(':scope > ul[data-crew]');
    return {
      group: li.closest('[data-status-group]')?.dataset.statusGroup ?? null,
      top: li.parentElement.matches('ul[data-session-rows]'),
      href: a.getAttribute('href'),
      text: a.textContent,
      h: a.getBoundingClientRect().height,
      count: a.querySelector('[data-crew-count] .tabular-nums')?.textContent.trim() ?? null,
      menu: !!li.querySelector(':scope > div button[aria-label^="Actions for"]'),
      checkbox: !!li.querySelector(':scope > div [role=checkbox]'),
      kids: crew ? [...crew.querySelectorAll(':scope > li')].map((c) => c.querySelector(':scope > div > div > a p.font-semibold')?.textContent ?? null).filter(Boolean) : [],
    };
  };
  return true;
})()`;
const fact = async (t) => b.eval(`(${HELPERS}) && __fact(${JSON.stringify(t)})`);
const header = async (t, g = null) => b.eval(`(${HELPERS}) && __header(${JSON.stringify(t)}, ${JSON.stringify(g)})`);
const sideways = () => b.eval(`document.scrollingElement.scrollWidth <= innerWidth`);
const shot = async (name) => {
  if (!shots) return;
  const r = await b.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, `t294-${name}.png`), Buffer.from(r.data, 'base64'));
};

// T-321: how long a page may take to load. Under load (scripts/test-repeat.sh --hogs cpus in a Job, 8 busy loops) a cold /admin/sessions
// took 20 to 26 s, so the old 2.5 + 8 s wait clicked an All chip that was not there yet and read the list on its default chip (Needs you,
// worker E alone): the lead's row "missing". A wait ends as soon as its condition holds, so the long deadline costs nothing when it passes.
const LOAD_MS = 60_000;
// T-321: --diag <dir> writes what the page held when the lead's row was missing (rows, chips, the API calls and their timings, the
// portal's log), a screenshot, and when (if ever) the row showed up after that.
const diag = args.includes('--diag') ? args[args.indexOf('--diag') + 1] : null;
if (diag) mkdirSync(diag, { recursive: true });
const PAGE_STATE = `(() => ({
  now: Math.round(performance.now()),
  rows: [...document.querySelectorAll('ul[data-session-rows] li')].map((li) => li.querySelector(':scope > div > div > a p.font-semibold')?.textContent ?? '?').slice(0, 30),
  lists: document.querySelectorAll('ul[data-session-rows]').length,
  chips: [...document.querySelectorAll('[data-chip]')].map((c) => [c.dataset.chip, c.getAttribute('aria-pressed') ?? c.getAttribute('aria-checked') ?? c.getAttribute('data-active'), c.textContent.trim()].join('|')),
  api: performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest').map((e) => [e.name.replace(location.origin, ''), Math.round(e.startTime), Math.round(e.duration)]),
  nav: Math.round(performance.getEntriesByType('navigation')[0]?.duration ?? -1),
  text: document.body.innerText.slice(0, 800),
}))()`;
const diagnose = async (tag) => {
  const stamp = `${Date.now()}-${tag}`;
  const first = await b.eval(PAGE_STATE).catch((e) => ({ error: String(e) }));
  const r = await b.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (r) writeFileSync(join(diag, `${stamp}.png`), Buffer.from(r.data, 'base64'));
  let shownAfter = null;
  for (let waited = 0; waited <= 20_000; waited += 250) {
    if (await b.eval(`(${HELPERS}) && !!__row('QA crew lead')`).catch(() => false)) { shownAfter = waited; break; }
    await sleep(250);
  }
  const later = await b.eval(PAGE_STATE).catch((e) => ({ error: String(e) }));
  let log = '';
  try { log = readFileSync(`/tmp/scratch-portal-${PORT}/log`, 'utf8').split('\n').slice(-80).join('\n'); } catch (e) { log = String(e); }
  writeFileSync(join(diag, `${stamp}.json`), JSON.stringify({ tag, first, shownAfter, later, log }, null, 1));
  console.log(`  diag ${tag}: lead row shown after ${shownAfter ?? 'never (20 s)'} ms; rows then ${JSON.stringify(first.rows?.length)}; api ${JSON.stringify(first.api)}`);
};

for (const size of SIZES) {
  for (const dark of [false, true]) {
    const tag = `${size.name}-${dark ? 'dark' : 'light'}`;
    console.log(tag);
    await b.setViewport(size.w, size.h, size.mobile);
    await b.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets }).catch(() => {});
    await b.media({ dark });
    await b.eval(`localStorage.removeItem('claudepilot.sessions-view')`).catch(() => {});
    await b.goto('/admin/sessions', 2500);
    await b.waitFor(`!!document.querySelector('[data-chip=all]')`, LOAD_MS, 'chips').catch(() => {});
    await b.eval(`document.querySelector('[data-chip=all]')?.click()`);
    // One tap, never repeated: it has to stick (T-321, listOrder.ts withDefaultChip), and All has to list the lead.
    await b.waitFor(`document.querySelector('[data-chip=all]')?.getAttribute('aria-pressed') === 'true' && (${HELPERS}) && !!__row('QA crew lead')`, LOAD_MS, 'All with the lead').catch(() => {});
    await sleep(500);

    const lead = await fact('QA crew lead');
    if (!lead && diag) await diagnose(tag);
    check(`${tag} All: the lead is a top-level row`, !!lead?.top, JSON.stringify(lead?.group));
    check(`${tag} All: its live workers sit under it, in spawn order`, JSON.stringify(lead?.kids) === JSON.stringify(['QA crew worker A', 'QA crew worker B', LONG]), JSON.stringify(lead?.kids));
    check(`${tag} All: the ended ones are behind one shut "2 done" row`, lead?.done?.text === '2 done' && lead.done.open === 'false', JSON.stringify(lead?.done));
    check(`${tag} All: the lead counts its crew (6), the words for a screen reader`, lead?.count === '6' && /^6 started · 1 needs you/.test(lead.countLabel ?? ''), JSON.stringify([lead?.count, lead?.countLabel]));
    const a = await fact('QA crew worker A');
    const wb = await fact('QA crew worker B');
    check(`${tag} All: a worker on its lead's Claude does not repeat it`, !!a && !/Default/.test(a.text), a?.text);
    check(`${tag} All: a worker on another Claude names it`, !!wb && /Work/.test(wb.text.replace('worker', '')), wb?.text);
    const e = await fact('QA crew worker E');
    const eHead = await header('QA crew lead', 'attention');
    check(`${tag} All: the waiting worker is under Needs you, under a header for its lead, no "from"`, e?.group === 'attention' && !e.top && !e.from && eHead?.top && JSON.stringify(eHead.kids) === JSON.stringify(['QA crew worker E']) && eHead.href === '/admin/sessions/qacrew-lead', JSON.stringify({ e, eHead }));
    const f = await fact('QA crew worker F');
    check(`${tag} All: the worker of an archived lead is a row of its own with "from"`, !!f?.top && f.from?.text === 'from QA crew old lead', JSON.stringify(f));
    check(`${tag}: no sideways scroll`, (await sideways()) === true);
    if (size.mobile) {
      check(`${tag}: 44 px targets (done row, from link, lead header, the lead's fold)`, lead?.done?.h >= 44 && f?.from?.h >= 44 && eHead?.h >= 44 && lead?.chevron >= 44, JSON.stringify({ done: lead?.done?.h, from: f?.from?.h, header: eHead?.h, fold: lead?.chevron }));
    }
    // Scroll the lead into view for the picture, then open "2 done" by touch (a click) and shut it with the keyboard.
    await b.eval(`(${HELPERS}) && __row('QA crew lead')?.scrollIntoView({ block: 'center' })`);
    await sleep(200);
    await shot(`list-${tag}`);
    const doneBox = await b.eval(`(() => { const r = (${HELPERS}) && __row('QA crew lead').querySelector(':scope > ul > li > button[data-crew-done]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const before = await b.eval(`(${HELPERS}) && __row('QA crew lead').querySelector(':scope > ul > li > button[data-crew-done]').getBoundingClientRect().top`);
    await b.clickAt(doneBox.x, doneBox.y);
    await sleep(300);
    const opened = await fact('QA crew lead');
    check(`${tag} All: "2 done" opens below itself and holds its place`, opened?.done?.open === 'true' && opened.kids.slice(-2).join() === 'QA crew worker C,QA crew worker D', JSON.stringify(opened?.kids));
    const after = await b.eval(`(${HELPERS}) && __row('QA crew lead').querySelector(':scope > ul > li > button[data-crew-done]').getBoundingClientRect().top`);
    check(`${tag} All: the toggle did not move`, Math.abs(after - before) < 1, `${before} -> ${after}`);
    await shot(`list-done-open-${tag}`);
    await b.eval(`(${HELPERS}) && __row('QA crew lead').querySelector(':scope > ul > li > button[data-crew-done]').focus()`);
    await b.key('Enter');
    await sleep(300);
    check(`${tag} All: the keyboard shuts it again`, (await fact('QA crew lead'))?.done?.open === 'false');

    // The Needs you chip: the waiting worker under a header for its lead (T-369), the lead not a row of its own.
    const topRows = `[...document.querySelectorAll('ul[data-session-rows] > li')].map((li) => li.querySelector(':scope > div > div > a p.font-semibold')?.textContent).filter((t) => t?.startsWith('QA crew'))`;
    await b.eval(`document.querySelector('[data-chip=attention]')?.click()`);
    await b.waitFor(`(${HELPERS}) && !!__header('QA crew lead')`, LOAD_MS, 'Needs you header').catch(() => {});
    const inChip = await b.eval(topRows);
    const needsHead = await header('QA crew lead');
    check(`${tag} Needs you: the waiting worker under a header for its lead, the lead not a row`, inChip.length === 0 && needsHead?.top && JSON.stringify(needsHead.kids) === JSON.stringify(['QA crew worker E']), JSON.stringify({ inChip, needsHead }));
    check(`${tag} Needs you: no "from" under a header`, !(await fact('QA crew worker E'))?.from);

    // T-369, the owner's case: In progress while the lead is idle. The working worker sits under a header for its lead, not flat with "from".
    await b.eval(`document.querySelector('[data-chip=working]')?.click()`);
    await b.waitFor(`document.querySelector('[data-chip=working]')?.getAttribute('aria-pressed') === 'true' && (${HELPERS}) && !!__header('QA crew lead')`, LOAD_MS, 'In progress header').catch(() => {});
    const busyHead = await header('QA crew lead');
    const busyTop = await b.eval(topRows);
    const wa = await fact('QA crew worker A');
    check(`${tag} In progress (lead idle): a lead header on top with worker A under it`, busyHead?.top && JSON.stringify(busyHead.kids) === JSON.stringify(['QA crew worker A']) && busyTop.length === 0, JSON.stringify({ busyHead, busyTop }));
    check(`${tag} In progress: the header says the lead's state (Idle), its crew (6) and links to it`, /Idle/.test(busyHead?.text ?? '') && busyHead?.count === '6' && busyHead.href === '/admin/sessions/qacrew-lead', JSON.stringify(busyHead));
    check(`${tag} In progress: the header has no ⋯ or checkbox; the worker has no "from"`, busyHead && !busyHead.menu && !busyHead.checkbox && !!wa && !wa.from, JSON.stringify({ busyHead, from: wa?.from }));
    if (size.mobile) check(`${tag} In progress: the header is a 44 px target`, busyHead?.h >= 44, String(busyHead?.h));
    check(`${tag} In progress: no sideways scroll`, (await sideways()) === true);
    await b.eval(`document.querySelector('a[data-crew-header]')?.scrollIntoView({ block: 'center' })`);
    await sleep(200);
    await shot(`t369-in-progress-${tag}`);

    // A worker's page: up to its lead.
    await b.goto('/admin/sessions/qacrew-a', 2500);
    await b.waitFor(`!!document.querySelector('[data-crew-lead]')`, LOAD_MS, 'lead link').catch(() => {});
    const up = await b.eval(`(() => { const a = document.querySelector('[data-crew-lead]'); if (!a) return null; const r = a.getBoundingClientRect(); return { href: a.getAttribute('href'), text: a.textContent.trim(), h: r.height, right: r.right }; })()`);
    check(`${tag} worker page: a link up to its lead, with its Claude`, up?.href === '/admin/sessions/qacrew-lead' && /QA crew lead/.test(up.text) && /Default/.test(up.text), JSON.stringify(up));
    if (size.mobile) check(`${tag} worker page: the link is a 44 px target`, up?.h >= 44, String(up?.h));
    check(`${tag} worker page: no sideways scroll`, (await sideways()) === true && (up?.right ?? 0) <= size.w);
    await shot(`worker-page-${tag}`);

    // The lead's page: its workers on a tap.
    await b.goto('/admin/sessions/qacrew-lead', 2500);
    await b.waitFor(`!!document.querySelector('[data-crew-workers]')`, LOAD_MS, 'workers button').catch(() => {});
    const down = await b.eval(`(() => { const x = document.querySelector('[data-crew-workers]'); if (!x) return null; return { label: x.getAttribute('aria-label'), text: x.textContent.trim(), h: x.getBoundingClientRect().height }; })()`);
    check(`${tag} lead page: its workers counted, the words in the label`, down?.text === '6' && down.label === '6 workers, 1 needs you', JSON.stringify(down));
    if (size.mobile) check(`${tag} lead page: the button is a 44 px target`, down?.h >= 44, String(down?.h));
    await b.clickSel('[data-crew-workers]');
    await b.waitFor(`!!document.querySelector('[data-crew-list]')`, LOAD_MS, 'workers list').catch(() => {});
    await sleep(400);
    const listed = await b.eval(`(() => { const ul = document.querySelector('[data-crew-list]'); if (!ul) return null; return [...ul.querySelectorAll(':scope > li')].map((li) => li.textContent.trim()); })()`);
    check(`${tag} lead page: the list (live in spawn order, then "2 done")`, Array.isArray(listed) && listed.length === 5 && /^QA crew worker A/.test(listed[0]) && /Work/.test(listed[1]) && /Needs you/.test(listed[3]) && listed[4] === '2 done', JSON.stringify(listed));
    check(`${tag} lead page: no sideways scroll with the list open`, (await sideways()) === true);
    await shot(`lead-page-${tag}`);
    await b.key('Escape');
    await sleep(300);
  }
}

await b.close();
if (!args.includes('--keep')) purge();
console.log(`${failed ? 'FAILED' : 'passed'}: ${failed} failing`);
process.exit(failed ? 1 : 0);
