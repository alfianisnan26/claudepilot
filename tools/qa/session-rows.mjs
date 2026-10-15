// Session rows as two compact lines (T-375, the owner: the model and the Claude's quota bar on the row, compact, no repeated labels). Over
// 390 px (touch, the iPhone's safe areas) and 1280 px, light and dark, against a scratch portal seeded with a lead (on a Claude with a long
// name, a cost), a worker on its lead's Claude, a worker on another Claude, a row that waits on you and a Bypass row, it takes a screenshot of
// each and asserts:
//   - every seeded row is there; a row that does not wait on you is at most two lines (its own block <= 80 px); the waiting row has its third
//     line (what it waits on);
//   - the model is on line two with its id in a title; the Claude's quota bar has a title (the source, or "unavailable") and is in sight on
//     the lead's row (a long Claude name and the fold button take room there);
//   - a worker on its lead's Claude does not repeat the Claude; one on another Claude names it;
//   - the Bypass row carries its shield dot (and the word from 640 px);
//   - nothing on line two paints past its own item (the quota bar once painted over the cost when the line was full);
//   - nothing scrolls sideways.
// usage: tools/qa/with-portal.sh 3479 node tools/qa/session-rows.mjs [--shots dir] [--keep]
//   scripts/job-run.sh --ref <branch> --artifacts qa-shots -- 'tools/qa/with-portal.sh 3479 node tools/qa/session-rows.mjs'
//   It seeds /tmp/scratch-portal-$QA_PORT/data/portal.db (ROWS_DB overrides) with rows whose ids start "qarows-" and removes them at the end
//   (--keep leaves them). No session page is opened: a live session's page attaches a reader that would mark it gone (session-crew.mjs).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : 'qa-shots/t375-rows';
mkdirSync(shots, { recursive: true });
const dbPath = process.env.ROWS_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`;
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};

// --- seed -------------------------------------------------------------------------------------------------------------------------------
const db = new DatabaseSync(dbPath, { timeout: 10_000 });
const WS = 'docker/qa-rows';
const purge = () =>
  db.exec(`DELETE FROM chat_requests WHERE session_id LIKE 'qarows-%'; DELETE FROM chat_sessions WHERE id LIKE 'qarows-%';
    DELETE FROM workspace_claudes WHERE id LIKE 'qarows-%'`);
const iso = (ms) => new Date(ms).toISOString();
const ins = db.prepare(`INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, process, model, mode, cost_est_usd, launch, created_at,
  last_activity_at, ended_reason, parent_id, claude_id, archived_at, started_by) VALUES (?, ?, '/home/node', ?, 'ui', ?, ?, ?, 'claude-opus-5-5', ?, ?, '{}', ?, ?, NULL, ?, ?, NULL, ?)`);
const T = {
  lead: 'QA rows lead',
  same: 'QA rows worker same Claude',
  other: 'QA rows worker other Claude',
  waiting: 'QA rows waiting',
  bypass: 'QA rows bypass',
};
// [id, title, state, parent, claude, mode, cost, born (min ago)]. The working and the waiting rows are 'live' (an In progress or Needs you
// row needs a process); the scratch portal cannot reach docker/qa-rows, so its tick leaves them alone, and no page of theirs is opened.
const ROWS = [
  ['qarows-lead', T.lead, 'idle', null, 'qarows-long', 'default', 10.39, 60],
  ['qarows-same', T.same, 'working', 'qarows-lead', 'qarows-long', 'default', 0.5, 50],
  ['qarows-other', T.other, 'idle', 'qarows-lead', 'qarows-work', 'default', 0.25, 45],
  ['qarows-waiting', T.waiting, 'waiting', null, '', 'default', 1.2, 30],
  ['qarows-bypass', T.bypass, 'idle', null, '', 'bypassPermissions', 2.75, 20],
];
const seed = () => {
  purge();
  const now = Date.now();
  const claude = db.prepare(`INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES (?, ?, ?, '', ?)`);
  claude.run('qarows-long', WS, 'QA rows Claude with a long name', iso(now));
  claude.run('qarows-work', WS, 'Work', iso(now));
  for (const [id, title, state, parent, cl, mode, cost, born] of ROWS) {
    const at = iso(now - born * 60_000);
    ins.run(id, WS, title, state, at, state === 'waiting' || state === 'working' ? 'live' : 'gone', mode, cost, at, at, parent, cl, parent ? `session:${parent}` : 'ui');
  }
  db.prepare(`INSERT INTO chat_requests (session_id, request_id, kind, tool_name, title, detail, created_at) VALUES ('qarows-waiting', 'r1', 'tool', 'Bash', 'Run a command', 'npm test', ?)`).run(iso(now));
};

// --- the page -----------------------------------------------------------------------------------------------------------------------------
// Facts about the row (not a lead header) whose own title is t.
const FACT = `(t) => {
  const li = [...document.querySelectorAll('ul[data-session-rows] li')].find((x) => !x.matches('[data-lead-header]') && x.querySelector(':scope > div > div > a p.font-semibold')?.textContent === t);
  if (!li) return null;
  const own = li.querySelector(':scope > div');
  const meta = own.querySelector('[data-row-meta]');
  // Line two's items: a descendant painted past its own item (more than 1 px) is a bleed.
  const bleeds = [];
  for (const item of meta ? meta.children : []) {
    const r = item.getBoundingClientRect();
    if (!r.width) continue;
    for (const d of item.querySelectorAll('*')) {
      const q = d.getBoundingClientRect();
      if (q.width && (q.right > r.right + 1 || q.left < r.left - 1)) bleeds.push(item.textContent.trim().slice(0, 40));
    }
  }
  const claude = own.querySelector('[data-row-claude]');
  const model = own.querySelector('[data-row-model]');
  const bar = claude?.querySelector('[data-quota-bar]')?.getBoundingClientRect();
  const line = meta?.getBoundingClientRect();
  const bypassWord =[...own.querySelectorAll('span')].find((s) => s.textContent.trim() === 'Bypass' && s.getBoundingClientRect().width > 0);
  return {
    h: Math.round(own.getBoundingClientRect().height),
    third: own.querySelector('[data-row-third]')?.textContent.trim() ?? null,
    model: model ? { text: model.textContent.trim(), title: model.getAttribute('title') } : null,
    claude: claude ? { text: claude.textContent.trim(), title: claude.getAttribute('title'), bar: claude.querySelector('[data-quota-bar]')?.getAttribute('data-quota-bar') ?? null } : null,
    barInSight: !!bar && !!line && bar.width > 0 && bar.right <= line.right + 0.5,
    bypassDot: !!own.querySelector('[data-row-bypass]'),
    bypassWord: !!bypassWord,
    bleeds: [...new Set(bleeds)],
  };
}`;
const fact = (t) => b.eval(`(${FACT})(${JSON.stringify(t)})`);

const IPHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: IPHONE },
  { name: '1280', w: 1280, h: 900, mobile: false, insets: { top: 0, bottom: 0, left: 0, right: 0 } },
];
const cookie = await login();
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
const LOAD_MS = 60_000;

for (const size of SIZES) {
  for (const dark of [false, true]) {
    const tag = `${size.name}-${dark ? 'dark' : 'light'}`;
    console.log(tag);
    seed();
    await b.setViewport(size.w, size.h, size.mobile);
    await b.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets }).catch(() => {});
    await b.media({ dark });
    await b.eval(`localStorage.removeItem('claudepilot.sessions-view')`).catch(() => {});
    await b.goto('/admin/sessions', 2500);
    await b.waitFor(`!!document.querySelector('[data-chip=all]')`, LOAD_MS, 'chips').catch(() => {});
    await b.eval(`document.querySelector('[data-chip=all]')?.click()`);
    await b.waitFor(`document.querySelector('[data-chip=all]')?.getAttribute('aria-pressed') === 'true' && !!(${FACT})(${JSON.stringify(T.lead)})`, LOAD_MS, 'All with the lead').catch(() => {});
    await sleep(500);

    const f = {};
    for (const [k, t] of Object.entries(T)) f[k] = await fact(t);
    check(`${tag}: every seeded row is listed`, Object.values(f).every(Boolean), JSON.stringify(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, !!v]))));

    const tall = Object.entries(f).filter(([k, v]) => v && k !== 'waiting' && v.h > 80);
    check(`${tag}: a row that does not wait on you is at most two lines (<= 80 px)`, tall.length === 0, JSON.stringify(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v?.h]))));
    check(`${tag}: the waiting row says what it waits on (line three)`, /Run a command/.test(f.waiting?.third ?? ''), JSON.stringify(f.waiting?.third));
    check(`${tag}: the model is on line two with its id in the title`, !!f.lead?.model && /claude-opus-5-5/.test(f.lead.model.title ?? ''), JSON.stringify(f.lead?.model));
    check(`${tag}: the quota bar has a source (its title)`, !!f.lead?.claude?.title && !!f.lead.claude.bar, JSON.stringify(f.lead?.claude));
    check(`${tag}: the lead's quota bar is in sight (a long Claude name and the fold do not push it off line two)`, !!f.lead?.barInSight, JSON.stringify(f.lead?.barInSight));
    check(`${tag}: a worker on its lead's Claude does not repeat it`, !!f.same && !f.same.claude, JSON.stringify(f.same?.claude));
    check(`${tag}: a worker on another Claude names it`, /Work/.test(f.other?.claude?.text ?? ''), JSON.stringify(f.other?.claude));
    check(`${tag}: the Bypass row has its shield dot${size.mobile ? '' : ' and the word'}`, !!f.bypass?.bypassDot && (size.mobile || f.bypass.bypassWord), JSON.stringify({ dot: f.bypass?.bypassDot, word: f.bypass?.bypassWord }));
    const bled = Object.entries(f).filter(([, v]) => v?.bleeds.length);
    check(`${tag}: nothing on line two paints past its item`, bled.length === 0, JSON.stringify(Object.fromEntries(bled.map(([k, v]) => [k, v.bleeds]))));
    check(`${tag}: no sideways scroll`, (await b.eval('document.scrollingElement.scrollWidth <= innerWidth')) === true);

    await b.eval(`[...document.querySelectorAll('ul[data-session-rows] p.font-semibold')].find((p) => p.textContent === ${JSON.stringify(T.waiting)})?.scrollIntoView({ block: 'start' })`);
    await sleep(300);
    const r = await b.send('Page.captureScreenshot', { format: 'png' });
    const file = join(shots, `rows-${tag}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`     shot ${file}`);
  }
}

await b.close();
if (!args.includes('--keep')) purge();
db.close();
console.log(`${failed ? 'FAILED' : 'passed'}: ${failed} failing`);
process.exit(failed ? 1 : 0);
