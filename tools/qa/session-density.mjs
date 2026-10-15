// Session rows at the owner's scale (T-378): on his iPhone a session row was 4-5 lines, with labels repeated (the role equal to the title, the
// same workspace on every row, the same persona avatar on every row). Against a scratch portal seeded by seed-scale.mjs (500 sessions, three
// crews, four Claudes, one stale reading), at 390 px with touch and the iPhone's safe areas, light and dark, in All and In progress, it asserts:
//   - a row is at most two lines (its own block <= 80 px) unless it waits on you;
//   - no label repeats inside a row: no role badge equal to the title; not the same workspace on every row; not the same persona avatar on
//     every row (both: a card of 5 rows or more where every row shows the same one);
//   - a model or a quota a row shows has a source (a title or data-source on it or around it); a quota of the stale Claude says so
//     ("stale" or "unavailable"), never a bare number;
//   - nothing scrolls sideways.
// One line per check; exit 1 on any FAIL. Screenshots (light and dark, each view) go to --shots (default qa-shots/t378-density).
// usage: tools/qa/with-portal.sh 3478 node tools/qa/session-density.mjs [--shots dir] [--keep]
//   scripts/job-run.sh --ref <branch> --artifacts qa-shots -- 'tools/qa/with-portal.sh 3478 node tools/qa/session-density.mjs'
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';
import { ON_STALE, purgeScale, seedScale } from './seed-scale.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : 'qa-shots/t378-density';
mkdirSync(shots, { recursive: true });
const dbPath = process.env.SCALE_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`;
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};

const db = new DatabaseSync(dbPath, { timeout: 10_000 });
const seeded = seedScale(db);
console.log(`seeded ${seeded.sessions} sessions, transcripts ${JSON.stringify(seeded.events)}, ${seeded.usage} usage rows`);

// In the page: facts about every seeded session row in sight (not a lead header: that is one line of context by design).
const ROWS = `(() => {
  const ownId = (li) => {
    const a = [...li.querySelectorAll('a[href^="/admin/sessions/"]')].find((x) => !x.matches('[data-crew-from]') && x.closest('li') === li);
    return a ? a.getAttribute('href').split('/').pop() : null;
  };
  const out = [];
  for (const li of document.querySelectorAll('ul[data-session-rows] li')) {
    if (li.matches('[data-lead-header]')) continue;
    const id = ownId(li);
    if (!id || !id.startsWith('qascale-')) continue;
    const own = li.querySelector(':scope > div');
    if (!own) continue;
    const r = own.getBoundingClientRect();
    if (r.height === 0) continue;
    const title = own.querySelector('p.font-semibold')?.textContent?.trim() ?? '';
    const role = own.querySelector('[data-role-badge]')?.textContent?.replace(/^\\s*Role\\s*/, '').trim() ?? null;
    const ws = [...own.querySelectorAll('span[title]')].find((s) => /^[a-z0-9-]+\\/[^\\s]+$/i.test(s.getAttribute('title')) && s.textContent.trim())?.textContent.trim() ?? null;
    const avatar = own.querySelector('[role=img][aria-label]')?.getAttribute('aria-label') ?? null;
    const text = own.textContent;
    const waits = /Needs you|\\d+ waiting/.test(text) || li.closest('[data-status-group]')?.dataset.statusGroup === 'attention';
    // The line boxes: distinct tops of the text-bearing leaves.
    const tops = new Set();
    for (const el of own.querySelectorAll('*')) {
      if (el.children.length || !el.textContent.trim()) continue;
      const b = el.getBoundingClientRect();
      if (b.height) tops.add(Math.round(b.top / 6));
    }
    // A model or a quota shown, and whether it has a source.
    const shown = [];
    for (const el of own.querySelectorAll('*')) {
      if (el.children.length) continue;
      const t = el.textContent.trim();
      if (!/\\b(opus|sonnet|haiku)\\b/i.test(t) && !/\\d+\\s?%/.test(t)) continue;
      const src = el.closest('[title],[data-source]');
      shown.push({ t, source: src && own.contains(src) ? (src.getAttribute('data-source') ?? src.getAttribute('title')) : null });
    }
    out.push({ id, title, h: Math.round(r.height), lines: tops.size, role, ws, avatar, waits, shown, card: [...document.querySelectorAll('ul[data-session-rows]')].indexOf(li.closest('ul[data-session-rows]')) });
  }
  return out;
})()`;

const IPHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const cookie = await login();
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
await b.setViewport(390, 844, true);
await b.send('Emulation.setSafeAreaInsetsOverride', { insets: IPHONE }).catch(() => {});
const shot = async (name) => {
  const r = await b.send('Page.captureScreenshot', { format: 'png' });
  const file = join(shots, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
};
const short = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

for (const dark of [false, true]) {
  await b.media({ dark });
  for (const chip of ['all', 'working']) {
    const tag = `390-${dark ? 'dark' : 'light'} ${chip === 'all' ? 'All' : 'In progress'}:`;
    await b.goto('/admin/sessions', 2500);
    await b.waitFor(`!!document.querySelector('[data-chip=${chip}]')`, 15_000, 'chips').catch(() => {});
    await b.eval(`document.querySelector('[data-chip=${chip}]')?.click()`);
    await b.waitFor(`document.querySelectorAll('ul[data-session-rows] li').length > 5`, 15_000, 'rows').catch(() => {});
    await sleep(800);
    const rows = await b.eval(ROWS);
    check(`${tag} seeded rows in sight`, rows.length >= 5, `${rows.length} rows`);

    const tall = rows.filter((r) => !r.waits && r.h > 80);
    const worst = [...tall].sort((x, y) => y.h - x.h)[0];
    check(`${tag} a row is at most two lines (<= 80 px) unless it waits on you`, tall.length === 0,
      `${tall.length}/${rows.length} over${worst ? `; worst "${short(worst.title)}" ${worst.h} px, ${worst.lines} lines` : ''}`);

    const sameRole = rows.filter((r) => r.role && r.role.toLowerCase() === r.title.toLowerCase());
    check(`${tag} no role badge equal to the title`, sameRole.length === 0, `${sameRole.length} rows${sameRole[0] ? `, e.g. "${sameRole[0].title}" · ${sameRole[0].role}` : ''}`);

    // Per card (a group of rows): the same workspace, the same persona avatar on every row.
    const cards = new Map();
    for (const r of rows) cards.set(r.card, [...(cards.get(r.card) ?? []), r]);
    const everyRow = (key) => {
      for (const list of cards.values()) {
        if (list.length < 5) continue;
        const vals = list.map((r) => r[key]);
        if (vals.every((v) => v && v === vals[0])) return { value: vals[0], rows: list.length };
      }
      return null;
    };
    const ws = everyRow('ws');
    check(`${tag} not the same workspace on every row`, !ws, ws ? `"${ws.value}" on all ${ws.rows} rows of a card` : '');
    const av = everyRow('avatar');
    check(`${tag} not the same persona avatar on every row`, !av, av ? `"${av.value}" on all ${av.rows} rows of a card` : '');

    const shown = rows.flatMap((r) => r.shown.map((s) => ({ ...s, id: r.id })));
    const bare = shown.filter((s) => !s.source);
    const staleBare = shown.filter((s) => /\d+\s?%/.test(s.t) && ON_STALE.has(s.id) && !/stale|unavailable|ago/i.test(`${s.t} ${s.source ?? ''}`));
    check(`${tag} a model or quota shown has a source (or says unavailable)`, bare.length === 0 && staleBare.length === 0,
      shown.length === 0 ? '(none shown on a row)' : `${shown.length} shown, ${bare.length} without a source${bare[0] ? ` e.g. "${bare[0].t}"` : ''}`);

    check(`${tag} no sideways scroll`, (await b.eval('document.scrollingElement.scrollWidth <= innerWidth')) === true);
    const file = await shot(`density-${chip}-${dark ? 'dark' : 'light'}`);
    console.log(`     shot ${file}`);
  }
}

await b.close();
if (!args.includes('--keep')) purgeScale(db);
db.close();
console.log(`${failed ? 'FAILED' : 'passed'}: ${failed} failing`);
process.exit(failed ? 1 : 0);
