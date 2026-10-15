// Session rows as two compact lines (T-375, the owner: the model and the Claude's quota bar on the row, compact, no repeated labels). Over
// 390 px (touch, the iPhone's safe areas), 640, 1024 and 1280 px, light and dark, against a scratch portal seeded with a lead (on a Claude
// with a long name, a cost), a worker on its lead's Claude, a worker on another Claude, a row that waits on you, a Bypass row, a row with a
// branch and a ticket, an asleep row and a row in a second workspace, it takes a screenshot of each and asserts:
//   - every seeded row is there; a row that does not wait on you is at most two lines (its own block <= 80 px); the waiting row has its third
//     line (what it waits on);
//   - the model is on line two with its id in a title; the Claude's quota bar has a title (the source, or "unavailable") and is in sight on
//     the lead's row (a long Claude name and the fold button take room there); the lead's cost is in sight at every width;
//   - a worker on its lead's Claude does not repeat the Claude; one on another Claude names it;
//   - the Bypass row carries its shield dot (and the word from 640 px); the asleep row its moon;
//   - no text value is clipped (the ux check of c84657f: a cost cut to "$", a Claude's name cut to "De" with no ellipsis): on line one, line
//     two and a lead header, a text shown in part (past the line's edge, or wider than its own box without an ellipsis) fails; an item line
//     two dropped whole (wholly past the edge) is fine;
//   - nothing on line two paints past its own item (the quota bar once painted over the cost when the line was full);
//   - the Idle card spans two workspaces, so from 1024 px each of its rows shows its own workspace whole;
//   - the row with a branch and a ticket ends line two with both, whole, from 1024 px;
//   - T-369: in the In progress chip (the lead idle) the lead header is at least 44 px tall at every width, and Select all leaves it out
//     ("1 selected", the worker only, no checkbox on the header);
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
const WS2 = 'docker/qa-rows-two';
const purge = () =>
  db.exec(`DELETE FROM chat_requests WHERE session_id LIKE 'qarows-%'; DELETE FROM chat_sessions WHERE id LIKE 'qarows-%';
    DELETE FROM workspace_claudes WHERE id LIKE 'qarows-%'`);
const iso = (ms) => new Date(ms).toISOString();
const ins = db.prepare(`INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, process, model, mode, cost_est_usd, launch, created_at,
  last_activity_at, ended_reason, parent_id, claude_id, archived_at, started_by, ticket_id, worktree_path, worktree_branch, worktree_repo)
  VALUES (?, ?, '/home/node', ?, 'ui', ?, ?, ?, 'claude-opus-5-5', ?, ?, '{}', ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`);
const T = {
  lead: 'QA rows lead',
  same: 'QA rows worker same Claude',
  other: 'QA rows worker other Claude',
  waiting: 'QA rows waiting',
  bypass: 'QA rows bypass',
  branch: 'QA rows branch',
  asleep: 'QA rows asleep',
  two: 'QA rows second workspace',
};
const BRANCH = { path: '/home/node/work/qa.worktrees/t-9001', branch: 'ticket/T-9001-qa', ticket: 'T-9001' };
// [id, title, state, process, parent, claude, mode, cost, born (min ago), workspace, worktree?]. The working and the waiting rows are 'live'
// (an In progress or Needs you row needs a process); the scratch portal cannot reach docker/qa-rows, so its tick leaves them alone, and no page
// of theirs is opened.
const ROWS = [
  ['qarows-lead', T.lead, 'idle', 'gone', null, 'qarows-long', 'default', 10.39, 60, WS],
  ['qarows-same', T.same, 'working', 'live', 'qarows-lead', 'qarows-long', 'default', 0.5, 50, WS],
  ['qarows-other', T.other, 'idle', 'gone', 'qarows-lead', 'qarows-work', 'default', 0.25, 45, WS],
  ['qarows-waiting', T.waiting, 'waiting', 'live', null, '', 'default', 1.2, 30, WS],
  ['qarows-bypass', T.bypass, 'idle', 'gone', null, '', 'bypassPermissions', 2.75, 20, WS],
  ['qarows-branch', T.branch, 'idle', 'gone', null, '', 'default', 0.75, 18, WS, BRANCH],
  ['qarows-asleep', T.asleep, 'idle', 'asleep', null, '', 'default', 0, 16, WS],
  ['qarows-two', T.two, 'idle', 'gone', null, '', 'default', 0.1, 14, WS2],
];
const seed = () => {
  purge();
  const now = Date.now();
  const claude = db.prepare(`INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES (?, ?, ?, '', ?)`);
  claude.run('qarows-long', WS, 'QA rows Claude with a long name', iso(now));
  claude.run('qarows-work', WS, 'Work', iso(now));
  for (const [id, title, state, proc, parent, cl, mode, cost, born, ws, wt] of ROWS) {
    const at = iso(now - born * 60_000);
    ins.run(id, ws, title, state, at, proc, mode, cost, at, at, parent, cl, parent ? `session:${parent}` : 'ui', wt?.ticket ?? null, wt?.path ?? null, wt?.branch ?? null, wt ? '/home/node/work/qa' : null);
  }
  db.prepare(`INSERT INTO chat_requests (session_id, request_id, kind, tool_name, title, detail, created_at) VALUES ('qarows-waiting', 'r1', 'tool', 'Bash', 'Run a command', 'npm test', ?)`).run(iso(now));
};

// --- the page -----------------------------------------------------------------------------------------------------------------------------
// Texts shown in part inside box `root`, clipped by `clip` (the element whose overflow cuts them): a text node's element that is past the
// clip's edge in part, or wider than its own box without an ellipsis. One wholly past the edge is dropped, not clipped.
const CLIPPED = `(root, clip) => {
  const out = [];
  if (!root) return out;
  const c = (clip ?? root).getBoundingClientRect();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!own || el.closest('.sr-only')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    const outside = r.left >= c.right - 0.5 || r.right <= c.left + 0.5 || r.top >= c.bottom - 0.5 || r.bottom <= c.top + 0.5;
    if (outside) continue;
    const cut = r.right > c.right + 0.5 || r.left < c.left - 0.5 || r.bottom > c.bottom + 0.5;
    const cs = getComputedStyle(el);
    const narrow = el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 0.5 && cs.textOverflow !== 'ellipsis';
    if (cut || narrow) out.push(own.slice(0, 40));
  }
  return out;
}`;
// The visible leaf texts of line two, left to right (what a person reads there).
const SHOWN = `(meta) => {
  if (!meta) return [];
  const c = meta.getBoundingClientRect();
  const out = [];
  for (const el of meta.querySelectorAll('*')) {
    if (el.closest('.sr-only')) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!own || own === '·') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || r.left >= c.right - 0.5 || r.top >= c.bottom - 0.5) continue;
    out.push({ text: own, whole: r.right <= c.right + 0.5 && r.bottom <= c.bottom + 0.5, title: el.getAttribute('title') ?? el.parentElement?.getAttribute('title') ?? null, left: r.left });
  }
  return out.sort((a, b) => a.left - b.left);
}`;
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
  const claudeName = own.querySelector('[data-row-claude-name]');
  const model = own.querySelector('[data-row-model]');
  const bar = claude?.querySelector('[data-quota-bar]')?.getBoundingClientRect();
  const line = meta?.getBoundingClientRect();
  const bypassWord =[...own.querySelectorAll('span')].find((s) => s.textContent.trim() === 'Bypass' && s.getBoundingClientRect().width > 0);
  const lineOne = own.querySelector('a p.font-semibold')?.parentElement;
  const shown = (${SHOWN})(meta);
  return {
    h: Math.round(own.getBoundingClientRect().height),
    third: own.querySelector('[data-row-third]')?.textContent.trim() ?? null,
    model: model ? { text: model.textContent.trim(), title: model.getAttribute('title') } : null,
    claude: claude ? { text: (claude.textContent + ' ' + (claudeName?.textContent ?? '')).trim(), title: claude.getAttribute('title'), bar: claude.querySelector('[data-quota-bar]')?.getAttribute('data-quota-bar') ?? null } : null,
    barInSight: !!bar && !!line && bar.width > 0 && bar.right <= line.right + 0.5,
    bypassDot: !!own.querySelector('[data-row-bypass]'),
    bypassWord: !!bypassWord,
    moon: !!own.querySelector('[data-row-icon] svg.lucide-moon'),
    bleeds: [...new Set(bleeds)],
    clipped: [...(${CLIPPED})(meta, meta), ...(${CLIPPED})(lineOne, lineOne)],
    shown: shown.filter((x) => !/^[\\d]+%$/.test(x.text)).map((x) => ({ text: x.text, whole: x.whole, title: x.title })),
  };
}`;
const fact = (t) => b.eval(`(${FACT})(${JSON.stringify(t)})`);
// The lead header for the lead, its height and clipped texts.
const HEADER = `(() => {
  const a = [...document.querySelectorAll('a[data-crew-header]')].find((x) => x.querySelector('[data-header-title]')?.textContent === ${JSON.stringify(T.lead)});
  if (!a) return null;
  const li = a.closest('li[data-lead-header]');
  return { h: a.getBoundingClientRect().height, checkbox: !!li.querySelector(':scope > div [role=checkbox]'), clipped: (${CLIPPED})(a, a) };
})()`;

const IPHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const FLAT = { top: 0, bottom: 0, left: 0, right: 0 };
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: IPHONE },
  { name: '640', w: 640, h: 900, mobile: false, insets: FLAT },
  { name: '1024', w: 1024, h: 900, mobile: false, insets: FLAT },
  { name: '1280', w: 1280, h: 900, mobile: false, insets: FLAT },
];
const cookie = await login();
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
const LOAD_MS = 60_000;
const COST = /^≈? ?\$[\d.,]+$/;

for (const size of SIZES) {
  for (const dark of [false, true]) {
    const tag = `${size.name}-${dark ? 'dark' : 'light'}`;
    const wide = size.w >= 1024;
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
    check(`${tag}: the lead's cost is in sight, whole`, !!f.lead?.shown.some((x) => COST.test(x.text) && x.whole), JSON.stringify(f.lead?.shown.map((x) => x.text)));
    check(`${tag}: a worker on its lead's Claude does not repeat it`, !!f.same && !f.same.claude, JSON.stringify(f.same?.claude));
    check(`${tag}: a worker on another Claude names it`, /Work/.test(f.other?.claude?.text ?? ''), JSON.stringify(f.other?.claude));
    check(`${tag}: the Bypass row has its shield dot${size.mobile ? '' : ' and the word'}`, !!f.bypass?.bypassDot && (size.mobile || f.bypass.bypassWord), JSON.stringify({ dot: f.bypass?.bypassDot, word: f.bypass?.bypassWord }));
    check(`${tag}: the asleep row has its moon`, !!f.asleep?.moon, JSON.stringify(f.asleep && { moon: f.asleep.moon, h: f.asleep.h }));
    const clipped = Object.entries(f).filter(([, v]) => v?.clipped.length);
    check(`${tag}: no text value is clipped on a row (line one, line two)`, clipped.length === 0, JSON.stringify(Object.fromEntries(clipped.map(([k, v]) => [k, v.clipped]))));
    const bled = Object.entries(f).filter(([, v]) => v?.bleeds.length);
    check(`${tag}: nothing on line two paints past its item`, bled.length === 0, JSON.stringify(Object.fromEntries(bled.map(([k, v]) => [k, v.bleeds]))));
    if (wide) {
      // The Idle card holds rows of docker/qa-rows and docker/qa-rows-two: each shows its own workspace (the label's title is the id).
      const idle = ['lead', 'bypass', 'branch', 'asleep', 'two'];
      const wsOf = (k) => f[k]?.shown.find((x) => x.title === (k === 'two' ? WS2 : WS));
      const missing = idle.filter((k) => !wsOf(k)?.whole);
      check(`${tag}: a card of two workspaces shows each row's own workspace, whole`, missing.length === 0, JSON.stringify(Object.fromEntries(idle.map((k) => [k, f[k]?.shown.map((x) => x.text)]))));
      const s = f.branch?.shown ?? [];
      const last2 = s.slice(-2);
      check(`${tag}: a row with a branch and a ticket ends line two with both, whole`, last2.length === 2 && last2[0].text === BRANCH.branch && last2[0].whole && last2[1].text === BRANCH.ticket && last2[1].whole, JSON.stringify(s.map((x) => [x.text, x.whole])));
    }
    check(`${tag}: no sideways scroll`, (await b.eval('document.scrollingElement.scrollWidth <= innerWidth')) === true);

    await b.eval(`[...document.querySelectorAll('ul[data-session-rows] p.font-semibold')].find((p) => p.textContent === ${JSON.stringify(T.waiting)})?.scrollIntoView({ block: 'start' })`);
    await sleep(300);
    const r = await b.send('Page.captureScreenshot', { format: 'png' });
    const file = join(shots, `rows-${tag}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`     shot ${file}`);

    // T-369: In progress with the lead idle: the working worker under a lead header. The header is a 44 px target at every width, its texts
    // are not clipped, and Select all takes the worker, never the header.
    await b.eval(`document.querySelector('[data-chip=working]')?.click()`);
    await b.waitFor(`document.querySelector('[data-chip=working]')?.getAttribute('aria-pressed') === 'true' && !!${HEADER}`, LOAD_MS, 'In progress header').catch(() => {});
    await sleep(300);
    const head = await b.eval(HEADER);
    check(`${tag} In progress: the lead header is at least 44 px tall`, (head?.h ?? 0) >= 44, String(head?.h));
    check(`${tag} In progress: no text clipped on the lead header`, !!head && head.clipped.length === 0, JSON.stringify(head?.clipped));
    await b.eval(`document.querySelector('button[aria-label=Select]')?.click()`);
    await b.waitFor(`[...document.querySelectorAll('[role=toolbar] button')].some((x) => x.textContent.trim() === 'Select all')`, 10_000, 'Select all').catch(() => {});
    await b.eval(`[...document.querySelectorAll('[role=toolbar] button')].find((x) => x.textContent.trim() === 'Select all')?.click()`);
    await sleep(300);
    const sel = await b.eval(`(() => ({
      said: document.querySelector('[role=toolbar] p')?.textContent.match(/^\\s*\\d+ selected/)?.[0].trim() ?? null,
      picked: [...document.querySelectorAll('ul[data-session-rows] [role=checkbox][aria-checked=true]')].map((x) => x.getAttribute('aria-label')),
      header: ${HEADER},
    }))()`);
    check(`${tag} In progress: Select all leaves the lead header out (1 selected, the worker)`, sel.said === '1 selected' && JSON.stringify(sel.picked) === JSON.stringify([`Select ${T.same}`]) && sel.header && !sel.header.checkbox, JSON.stringify({ said: sel.said, picked: sel.picked, headerBox: sel.header?.checkbox }));
    check(`${tag} In progress: no sideways scroll`, (await b.eval('document.scrollingElement.scrollWidth <= innerWidth')) === true);
    const r2 = await b.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, `header-${tag}.png`), Buffer.from(r2.data, 'base64'));
  }
}

await b.close();
if (!args.includes('--keep')) purge();
db.close();
console.log(`${failed ? 'FAILED' : 'passed'}: ${failed} failing`);
process.exit(failed ? 1 : 0);
