// Crew (T-294, 2026-10-14, the owner: "terlihat hierarchy-nya, dan menginduk ke claude session yang mana, agar tidak bloated"): the sessions a
// session started sit under it. Over 390 px (touch, the iPhone's safe areas) and 1280 px, light and dark, against a scratch portal seeded with
// a lead and its workers (one on another Claude, two ended, one waiting on you, one with a very long title) and a worker of an archived lead,
// it asserts:
//   - in All, the lead's row carries its crew count; its live workers sit under it on a rail, the ended ones behind one "2 done" row that is
//     shut until it is opened (by touch or the keyboard) and holds its place; the worker waiting on you is under Needs you with "from <lead>";
//     the worker of an archived lead is a row of its own with "from <lead>"; a worker names its Claude only when it differs from its lead's;
//   - the Needs you chip lists the waiting worker alone (not its lead), with "from";
//   - a worker's page links up to its lead (title and Claude); the lead's page counts its workers and lists them on a tap (sheet or popover);
//   - nothing scrolls sideways; on touch every crew control is a 44 px target.
// usage: scripts/scratch-portal.sh start 3417 && QA_PORT=3417 QA_CODE=24681372 node tools/qa/session-crew.mjs [--shots dir] [--keep]
//   It seeds /tmp/scratch-portal-$QA_PORT/data/portal.db (CREW_DB overrides) with rows whose ids start "qacrew-" and removes them at the end
//   (--keep leaves them, to look by hand).
import { mkdirSync, writeFileSync } from 'node:fs';
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
  last_activity_at, ended_reason, parent_id, claude_id, archived_at, started_by) VALUES (?, ?, '/home/node', ?, 'ui', ?, ?, 'gone', 'claude-opus-5-5', 'default', 0, '{}', ?, ?, ?, ?, ?, ?, ?)`);
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
for (const [id, title, state, parent, claude, born, archived] of rows) {
  const at = iso(now - born * 60_000);
  ins.run(id, WS, title, state, at, at, at, state === 'ended' ? 'ended by you' : null, parent, claude, archived ? at : null, parent ? `session:${parent}` : 'ui');
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
  return true;
})()`;
const fact = async (t) => b.eval(`(${HELPERS}) && __fact(${JSON.stringify(t)})`);
const sideways = () => b.eval(`document.scrollingElement.scrollWidth <= innerWidth`);
const shot = async (name) => {
  if (!shots) return;
  const r = await b.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, `t294-${name}.png`), Buffer.from(r.data, 'base64'));
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
    await b.waitFor(`!!document.querySelector('[data-chip=all]')`, 8000, 'chips').catch(() => {});
    await b.eval(`document.querySelector('[data-chip=all]')?.click()`);
    await sleep(500);

    const lead = await fact('QA crew lead');
    check(`${tag} All: the lead is a top-level row`, !!lead?.top, JSON.stringify(lead?.group));
    check(`${tag} All: its live workers sit under it, in spawn order`, JSON.stringify(lead?.kids) === JSON.stringify(['QA crew worker A', 'QA crew worker B', LONG]), JSON.stringify(lead?.kids));
    check(`${tag} All: the ended ones are behind one shut "2 done" row`, lead?.done?.text === '2 done' && lead.done.open === 'false', JSON.stringify(lead?.done));
    check(`${tag} All: the lead counts its crew (6), the words for a screen reader`, lead?.count === '6' && /^6 started · 1 needs you/.test(lead.countLabel ?? ''), JSON.stringify([lead?.count, lead?.countLabel]));
    const a = await fact('QA crew worker A');
    const wb = await fact('QA crew worker B');
    check(`${tag} All: a worker on its lead's Claude does not repeat it`, !!a && !/Default/.test(a.text), a?.text);
    check(`${tag} All: a worker on another Claude names it`, !!wb && /Work/.test(wb.text.replace('worker', '')), wb?.text);
    const e = await fact('QA crew worker E');
    check(`${tag} All: the waiting worker is under Needs you with "from" its lead`, e?.group === 'attention' && e.top && e.from?.text === 'from QA crew lead' && e.from.href === '/admin/sessions/qacrew-lead', JSON.stringify(e));
    const f = await fact('QA crew worker F');
    check(`${tag} All: the worker of an archived lead is a row of its own with "from"`, !!f?.top && f.from?.text === 'from QA crew old lead', JSON.stringify(f));
    check(`${tag}: no sideways scroll`, (await sideways()) === true);
    if (size.mobile) {
      check(`${tag}: 44 px targets (done row, from link, the lead's fold)`, lead?.done?.h >= 44 && e?.from?.h >= 44 && lead?.chevron >= 44, JSON.stringify({ done: lead?.done?.h, from: e?.from?.h, fold: lead?.chevron }));
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

    // The Needs you chip: the waiting worker alone, with "from".
    await b.eval(`document.querySelector('[data-chip=attention]')?.click()`);
    await sleep(400);
    const inChip = await b.eval(`[...document.querySelectorAll('ul[data-session-rows] > li')].map((li) => li.querySelector(':scope > div > div > a p.font-semibold')?.textContent).filter((t) => t?.startsWith('QA crew'))`);
    check(`${tag} Needs you: the waiting worker alone, not its lead`, JSON.stringify(inChip) === JSON.stringify(['QA crew worker E']), JSON.stringify(inChip));
    check(`${tag} Needs you: with "from" its lead`, (await fact('QA crew worker E'))?.from?.text === 'from QA crew lead');

    // A worker's page: up to its lead.
    await b.goto('/admin/sessions/qacrew-a', 2500);
    await b.waitFor(`!!document.querySelector('[data-crew-lead]')`, 8000, 'lead link').catch(() => {});
    const up = await b.eval(`(() => { const a = document.querySelector('[data-crew-lead]'); if (!a) return null; const r = a.getBoundingClientRect(); return { href: a.getAttribute('href'), text: a.textContent.trim(), h: r.height, right: r.right }; })()`);
    check(`${tag} worker page: a link up to its lead, with its Claude`, up?.href === '/admin/sessions/qacrew-lead' && /QA crew lead/.test(up.text) && /Default/.test(up.text), JSON.stringify(up));
    if (size.mobile) check(`${tag} worker page: the link is a 44 px target`, up?.h >= 44, String(up?.h));
    check(`${tag} worker page: no sideways scroll`, (await sideways()) === true && (up?.right ?? 0) <= size.w);
    await shot(`worker-page-${tag}`);

    // The lead's page: its workers on a tap.
    await b.goto('/admin/sessions/qacrew-lead', 2500);
    await b.waitFor(`!!document.querySelector('[data-crew-workers]')`, 8000, 'workers button').catch(() => {});
    const down = await b.eval(`(() => { const x = document.querySelector('[data-crew-workers]'); if (!x) return null; return { label: x.getAttribute('aria-label'), text: x.textContent.trim(), h: x.getBoundingClientRect().height }; })()`);
    check(`${tag} lead page: its workers counted, the words in the label`, down?.text === '6' && down.label === '6 workers, 1 needs you', JSON.stringify(down));
    if (size.mobile) check(`${tag} lead page: the button is a 44 px target`, down?.h >= 44, String(down?.h));
    await b.clickSel('[data-crew-workers]');
    await b.waitFor(`!!document.querySelector('[data-crew-list]')`, 4000, 'workers list').catch(() => {});
    await sleep(400);
    const listed = await b.eval(`(() => { const ul = document.querySelector('[data-crew-list]'); if (!ul) return null; return [...ul.querySelectorAll(':scope > li')].map((li) => li.textContent.trim()); })()`);
    check(`${tag} lead page: the list (live in spawn order, then "2 done")`, Array.isArray(listed) && listed.length === 5 && /^QA crew worker A/.test(listed[0]) && /Work/.test(listed[1]) && /Needs you|Interrupted/.test(listed[3]) && listed[4] === '2 done', JSON.stringify(listed));
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
